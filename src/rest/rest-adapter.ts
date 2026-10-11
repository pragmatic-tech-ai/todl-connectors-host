import { WriteOperationKind } from "@pragmatic-tech-ai/todl";
import type { ExternalRecord, QueryRequest, WriteBatch, WriteConflict, WriteOperation, WriteResult } from "@pragmatic-tech-ai/todl";
import type { IDataSourceAdapter } from "@pragmatic-tech-ai/todl";
import { ExternalQuery } from "../query/external-query.js";
import { RestHttpMethod } from "./rest-http-client.js";
import type { IRestHttpClient } from "./rest-http-client.js";
import type { RestConnection } from "./rest-connection-config.js";

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
    private static readonly WriteFailedMessage = "rest write failed with status";
    private static readonly ReadMalformedMessage = "rest read returned a non-array payload";

    public constructor(private readonly client: IRestHttpClient, private readonly connection: RestConnection)
    {
    }

    public async Query(request: QueryRequest): Promise<readonly ExternalRecord[]>
    {
        const url = this.CollectionUrl(request.Source);
        const payload = await this.client.GetJson(url, this.connection.headers);
        if (!Array.isArray(payload)) throw new Error(RestAdapter.ReadMalformedMessage);
        return ExternalQuery.Apply(payload as Record<string, unknown>[], request);
    }

    public async Apply(batch: WriteBatch): Promise<WriteResult>
    {
        let applied = 0;
        const conflicts: WriteConflict[] = [];
        for (const op of batch.Operations)
        {
            if (op.Kind === WriteOperationKind.Delete)
            {
                const response = await this.client.Send(
                    RestHttpMethod.Delete, this.ResourceUrl(batch.Source, op.Key), this.connection.headers);
                if (response.Status !== RestAdapter.NotFoundStatus) RestAdapter.EnsureSuccess(response.Status);
                applied++;
            }
            else if (await this.ApplyUpsert(batch, op)) applied++;
            else conflicts.push({ Key: op.Key, Reason: RestAdapter.VersionConflictReason });
        }
        return { Applied: applied, Conflicts: conflicts };
    }

    public async Dispose(): Promise<void>
    {
    }

    private async ApplyUpsert(batch: WriteBatch, op: WriteOperation): Promise<boolean>
    {
        const headers = { ...this.connection.headers };
        if (batch.VersionField !== undefined && op.Version !== undefined && op.Version !== null)
        {
            headers[RestAdapter.IfMatchHeader] = String(op.Version);
        }
        const response = await this.client.Send(
            RestHttpMethod.Put, this.ResourceUrl(batch.Source, op.Key), headers, op.Fields);
        if (RestAdapter.IsVersionConflict(response.Status)) return false;
        RestAdapter.EnsureSuccess(response.Status);
        return true;
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

    private CollectionUrl(source: string): string
    {
        return this.connection.baseUrl + RestAdapter.PathSeparator + encodeURIComponent(source);
    }

    private ResourceUrl(source: string, key: unknown): string
    {
        return this.CollectionUrl(source) + RestAdapter.PathSeparator + encodeURIComponent(String(key));
    }
}
