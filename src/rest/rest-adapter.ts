import { ConnectionFailureKind, WriteAtomicity, WriteConcurrency, WriteFailureKind, WriteOperationKind } from "@pragmatic-tech-ai/todl";
import type { ExternalRecord, QueryRequest, WriteBatch, WriteFailure, WriteOperation, WriteResult } from "@pragmatic-tech-ai/todl";
import type { IDataSourceAdapter } from "@pragmatic-tech-ai/todl";
import { ExternalQuery } from "../query/external-query.js";
import { FetchFailureClassifier } from "./fetch-failure-classifier.js";
import { RestHttpMethod } from "./rest-http-client.js";
import type { IRestHttpClient } from "./rest-http-client.js";
import type { RestConnection } from "./rest-connection-config.js";
import { RestWriteReasons } from "./write-reasons.js";

/** REST adapter: GET a collection, PUT/DELETE a resource; Where re-applied in-adapter. */
export class RestAdapter implements IDataSourceAdapter
{
    private static readonly PathSeparator = "/";
    private static readonly IfMatchHeader = "If-Match";
    private static readonly ConflictStatus = 409;
    private static readonly PreconditionFailedStatus = 412;
    private static readonly NotFoundStatus = 404;
    private static readonly SuccessMin = 200;
    private static readonly SuccessMax = 299;
    private static readonly VersionConflictReason = "version mismatch";
    private static readonly UnversionedConflictReason = "optimistic write requires a version REST can enforce via If-Match";
    private static readonly WriteFailedMessage = "rest write failed with status";
    private static readonly ReadMalformedMessage = "rest read returned a non-array payload";

    public constructor(private readonly client: IRestHttpClient, private readonly connection: RestConnection)
    {
    }

    /** Whether this adapter can enforce an optimistic version guard: yes, via the HTTP If-Match precondition. */
    public get CanVersion(): boolean
    {
        return true;
    }

    /** Delegates to {@link FetchFailureClassifier}: a pure function of the thrown transport error. */
    public ClassifyFailure(error: unknown): ConnectionFailureKind
    {
        return FetchFailureClassifier.Classify(error);
    }

    /** Whether this adapter can run a batch inside a backend transaction: no, REST has no cross-request transaction. */
    public get CanTransact(): boolean
    {
        return false;
    }

    public async Query(request: QueryRequest): Promise<readonly ExternalRecord[]>
    {
        const url = this.CollectionUrl(request.Source);
        const payload = await this.client.GetJson(url, this.connection.headers);
        if (!Array.isArray(payload)) throw new Error(RestAdapter.ReadMalformedMessage);
        return ExternalQuery.Apply(payload as Record<string, unknown>[], request);
    }

    /**
     * Dispatches on the batch's atomicity axis. REST cannot transact, so a Transactional batch comes
     * back wholly Unsupported (never a silent downgrade to partial); otherwise a resilient Sequential
     * apply runs each op, collecting Conflict/Error failures and continuing.
     */
    public async Apply(batch: WriteBatch): Promise<WriteResult>
    {
        if (batch.Atomicity === WriteAtomicity.Transactional)
        {
            return {
                Applied: 0,
                Failures: batch.Operations.map(op => ({
                    Key: op.Key,
                    Kind: WriteFailureKind.Unsupported,
                    Reason: RestWriteReasons.TransactionUnsupported,
                })),
            };
        }
        let applied = 0;
        const failures: WriteFailure[] = [];
        for (const op of batch.Operations)
        {
            const failure = await this.ApplyOne(batch, op);
            if (failure === undefined)
            {
                applied++;
            }
            else
            {
                failures.push(failure);
            }
        }
        return { Applied: applied, Failures: failures };
    }

    public async Dispose(): Promise<void>
    {
    }

    /**
     * Applies one op resiliently: a non-2xx (other than a version-conflict code) or a transport throw
     * becomes a WriteFailure{Error}; a version-conflict code or a fail-closed unversioned optimistic op
     * becomes a WriteFailure{Conflict}; success returns undefined.
     */
    private async ApplyOne(batch: WriteBatch, op: WriteOperation): Promise<WriteFailure | undefined>
    {
        try
        {
            if (op.Kind === WriteOperationKind.Delete)
            {
                return await this.ApplyDelete(batch, op);
            }
            return await this.ApplyUpsert(batch, op);
        }
        catch (error)
        {
            return { Key: op.Key, Kind: WriteFailureKind.Error, Reason: RestAdapter.ErrorReason(error) };
        }
    }

    /** DELETE a resource; a 404 is tolerated as already absent. No version guard on delete in v1. */
    private async ApplyDelete(batch: WriteBatch, op: WriteOperation): Promise<WriteFailure | undefined>
    {
        const response = await this.client.Send(
            RestHttpMethod.Delete, this.ResourceUrl(batch.Source, op.Key), this.connection.headers);
        if (response.Status === RestAdapter.NotFoundStatus) return undefined;
        RestAdapter.EnsureSuccess(response.Status);
        return undefined;
    }

    /**
     * PUT a resource. LastWriteWins sends an unconditional PUT (no If-Match). Optimistic is fail-closed:
     * a missing op.Version is a Conflict with NO PUT issued (REST cannot verify without a version), and a
     * present version is sent as If-Match so the backend maps a stale write to 412/409 -> Conflict.
     */
    private async ApplyUpsert(batch: WriteBatch, op: WriteOperation): Promise<WriteFailure | undefined>
    {
        const headers = { ...this.connection.headers };
        if (batch.Concurrency === WriteConcurrency.Optimistic)
        {
            if (op.Version === undefined || op.Version === null)
            {
                return { Key: op.Key, Kind: WriteFailureKind.Conflict, Reason: RestAdapter.UnversionedConflictReason };
            }
            headers[RestAdapter.IfMatchHeader] = String(op.Version);
        }
        const response = await this.client.Send(
            RestHttpMethod.Put, this.ResourceUrl(batch.Source, op.Key), headers, op.Fields);
        if (RestAdapter.IsVersionConflict(response.Status))
        {
            return { Key: op.Key, Kind: WriteFailureKind.Conflict, Reason: RestAdapter.VersionConflictReason };
        }
        RestAdapter.EnsureSuccess(response.Status);
        return undefined;
    }

    private static IsVersionConflict(status: number): boolean
    {
        return status === RestAdapter.ConflictStatus || status === RestAdapter.PreconditionFailedStatus;
    }

    /** Throws a secret-free, status-only error for any non-2xx status. */
    private static EnsureSuccess(status: number): void
    {
        if (status >= RestAdapter.SuccessMin && status <= RestAdapter.SuccessMax) return;
        throw new Error(`${RestAdapter.WriteFailedMessage} ${status}`);
    }

    private static ErrorReason(error: unknown): string
    {
        return error instanceof Error ? error.message : String(error);
    }

    private CollectionUrl(source: string): string
    {
        return this.connection.baseUrl + RestAdapter.PathSeparator + encodeURIComponent(source);
    }

    private ResourceUrl(source: string, key: unknown): string
    {
        return this.CollectionUrl(source) + RestAdapter.PathSeparator + encodeURIComponent(String(key));
    }
}
