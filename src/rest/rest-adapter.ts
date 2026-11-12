import { ConnectionFailureKind, WriteAtomicity, WriteConcurrency, WriteFailureKind, WriteOperationKind } from "@pragmatic-tech-ai/todl";
import type { ExternalFieldValue, ExternalRecord, IAssignedKey, PageQuery, PageSlice, QueryRequest, WriteBatch, WriteFailure, WriteOperation, WriteResult } from "@pragmatic-tech-ai/todl";
import type { IDataSourceAdapter } from "@pragmatic-tech-ai/todl";
import { ExternalQuery } from "../query/external-query.js";
import { JsonPath } from "./json-path.js";
import { LinkHeader } from "./rest-paging.js";
import { FetchFailureClassifier } from "./fetch-failure-classifier.js";
import { RestHttpMethod } from "./rest-http-client.js";
import type { IRestHttpClient, RestResponse } from "./rest-http-client.js";
import type { RestConnection } from "./rest-connection-config.js";
import { RestWriteReasons } from "./write-reasons.js";

/** The result of applying one REST op: a failure, or the source-assigned key of an insert; both absent means a plain success. */
interface IRestOpOutcome
{
    readonly Failure?: WriteFailure;
    readonly Assigned?: IAssignedKey;
}

/** REST adapter: GET a collection, POST an insert, PUT/DELETE a resource; Where re-applied in-adapter. */
export class RestAdapter implements IDataSourceAdapter
{
    private static readonly PathSeparator = "/";
    private static readonly LocationHeader = "Location";
    private static readonly ETagHeader = "ETag";
    private static readonly KeyNotReturnedReason = "rest insert returned no key (no body id field and no Location header)";
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
    private static readonly PageMalformedMessage = "rest paged read returned a non-array payload at itemsPath";
    private static readonly PagingNotConfiguredMessage = "rest paging is not configured for this connection";
    private static readonly PagingClientMessage = "rest http client does not support paged reads";
    private static readonly InvalidLimitMessage = "QueryPage Limit must be a positive integer";
    private static readonly QueryStart = "?";
    private static readonly QueryJoin = "&";
    private static readonly ParamPair = "=";

    public constructor(private readonly client: IRestHttpClient, private readonly connection: RestConnection)
    {
    }

    /** The server assigns versions (ETags) itself; the engine never computes a next version for REST. */
    public get SourceManagesVersions(): boolean
    {
        return true;
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

    /** Whether this adapter can page: true ONLY when the connection declares paging config AND the client can serve paged GETs (REST has no generic id column). */
    public get CanPage(): boolean
    {
        return this.connection.paging !== undefined && this.client.GetPage !== undefined;
    }

    /** Whether this adapter can run a batch inside a backend transaction: no, REST has no cross-request transaction. */
    public get CanTransact(): boolean
    {
        return false;
    }

    /** Whether this adapter can execute source-keyed inserts: yes, by POSTing to the collection and reading the
     *  assigned key back from the response body or the Location header. */
    public get CanAssignKeys(): boolean
    {
        return true;
    }

    public async Query(request: QueryRequest): Promise<readonly ExternalRecord[]>
    {
        const filters = this.FilterParams(request);
        const url = this.CollectionUrl(request.Source) + (filters.length === 0 ? "" : RestAdapter.QueryStart + filters.join(RestAdapter.QueryJoin));
        const payload = await this.client.GetJson(url, this.connection.headers);
        if (!Array.isArray(payload)) throw new Error(RestAdapter.ReadMalformedMessage);
        return ExternalQuery.Apply(payload as Record<string, unknown>[], request);
    }

    /**
     * Declared-config page: sends the limit and (when set) the opaque page token as the configured query
     * params, reads records from itemsPath and the next token from nextTokenPath or the Link rel="next"
     * header. NextAfter is set only when the envelope carries a next token. Where is re-applied to the
     * page in-adapter (a filtered page may be short; NextAfter still tracks the source's cursor).
     */
    public async QueryPage(request: QueryRequest, page: PageQuery): Promise<PageSlice>
    {
        const paging = this.connection.paging;
        if (paging === undefined) throw new Error(RestAdapter.PagingNotConfiguredMessage);
        if (!Number.isInteger(page.Limit) || page.Limit <= 0) throw new Error(RestAdapter.InvalidLimitMessage);
        if (this.client.GetPage === undefined) throw new Error(RestAdapter.PagingClientMessage);
        const params = [...this.FilterParams(request), RestAdapter.Param(paging.limitParam, page.Limit)];
        if (page.After !== undefined) params.push(RestAdapter.Param(paging.tokenParam, page.After));
        const url = this.CollectionUrl(request.Source) + RestAdapter.QueryStart + params.join(RestAdapter.QueryJoin);
        const response = await this.client.GetPage(url, this.connection.headers);
        const items = JsonPath.Read(response.Body, paging.itemsPath);
        if (!Array.isArray(items)) throw new Error(RestAdapter.PageMalformedMessage);
        const records = ExternalQuery.Apply(items as Record<string, unknown>[], request);
        const next = paging.useLinkHeader
            ? this.LinkToken(response.Link, paging.tokenParam)
            : JsonPath.AsToken(JsonPath.Read(response.Body, paging.nextTokenPath!));
        return next === undefined ? { Records: records } : { Records: records, NextAfter: next as ExternalFieldValue };
    }

    /** The declared server-side equality filters this request's Where drives, as encoded query params (narrowing only:
     *  the full Where is re-applied in memory). */
    private FilterParams(request: QueryRequest): string[]
    {
        return (this.connection.filters?.Pick(request.Where) ?? []).map(p => RestAdapter.Param(p.Filter.Target, p.Value));
    }

    private static Param(name: string, value: ExternalFieldValue | number): string
    {
        return encodeURIComponent(name) + RestAdapter.ParamPair + encodeURIComponent(String(value));
    }

    /** The token param's value from the Link rel="next" URL; undefined when there is no next link or it lacks the param. */
    private LinkToken(link: string | undefined, tokenParam: string): string | undefined
    {
        const next = LinkHeader.Next(link);
        if (next === undefined) return undefined;
        let value: string | null;
        try
        {
            value = new URL(next, this.connection.baseUrl).searchParams.get(tokenParam);
        }
        catch
        {
            return undefined;
        }
        return value === null || value.length === 0 ? undefined : value;
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
        const assigned: IAssignedKey[] = [];
        for (const op of batch.Operations)
        {
            const outcome = await this.ApplyOne(batch, op);
            if (outcome.Failure !== undefined)
            {
                failures.push(outcome.Failure);
            }
            else
            {
                applied++;
                if (outcome.Assigned !== undefined)
                {
                    assigned.push(outcome.Assigned);
                }
            }
        }
        // W20: a mid-batch failure never orphans the POSTs that already applied — each applied insert's key is
        // reported here under its Ref, and the loop returns normally (ApplyOne catches every per-op throw).
        return assigned.length === 0 ? { Applied: applied, Failures: failures } : { Applied: applied, Failures: failures, Assigned: assigned };
    }

    public async Dispose(): Promise<void>
    {
    }

    /**
     * Applies one op resiliently: a non-2xx (other than a version-conflict code) or a transport throw
     * becomes a WriteFailure{Error}; a version-conflict code or a fail-closed unversioned optimistic op
     * becomes a WriteFailure{Conflict}; an insert returns its source-assigned key; a plain success returns {}.
     */
    private async ApplyOne(batch: WriteBatch, op: WriteOperation): Promise<IRestOpOutcome>
    {
        try
        {
            if (op.Kind === WriteOperationKind.Insert)
            {
                return await this.ApplyInsert(batch, op);
            }
            const failure = op.Kind === WriteOperationKind.Delete
                ? await this.ApplyDelete(batch, op)
                : await this.ApplyUpsert(batch, op);
            return failure === undefined ? {} : { Failure: failure };
        }
        catch (error)
        {
            return { Failure: { Key: op.Key, Kind: WriteFailureKind.Error, Reason: RestAdapter.ErrorReason(error) } };
        }
    }

    /**
     * POSTs an insert to the collection URL (the source assigns the key). The key is the body field IdKey, else
     * the last path segment of the Location header; its absence is an Error failure. The row's version is the
     * ETag header when present.
     */
    private async ApplyInsert(batch: WriteBatch, op: WriteOperation): Promise<IRestOpOutcome>
    {
        const response = await this.client.Send(
            RestHttpMethod.Post, this.CollectionUrl(batch.Source), { ...this.connection.headers }, op.Fields);
        RestAdapter.EnsureSuccess(response.Status);
        const key = RestAdapter.InsertKey(batch, response);
        if (key === undefined || key === null)
        {
            return { Failure: { Key: op.Key, Kind: WriteFailureKind.Error, Reason: RestAdapter.KeyNotReturnedReason } };
        }
        // Surface the ETag-derived version only when the batch declares a version field (as the Cypher / GraphQL
        // adapters gate theirs on batch.VersionField); an unversioned binding reports just the key.
        const version = batch.VersionField === undefined ? undefined : RestAdapter.Header(response, RestAdapter.ETagHeader);
        return { Assigned: version === undefined ? { Ref: op.Ref!, Key: key } : { Ref: op.Ref!, Key: key, Version: version } };
    }

    /** The assigned key of an inserted row: the body field IdKey, else the last path segment of the Location header. */
    private static InsertKey(batch: WriteBatch, response: RestResponse): ExternalFieldValue | undefined
    {
        const body = response.Body as Record<string, unknown> | undefined;
        const fromBody = body?.[batch.IdKey];
        if (fromBody !== undefined && fromBody !== null)
        {
            return fromBody as ExternalFieldValue;
        }
        const location = RestAdapter.Header(response, RestAdapter.LocationHeader);
        if (location === undefined)
        {
            return undefined;
        }
        const segments = location.split(RestAdapter.PathSeparator).filter(s => s.length > 0);
        return segments.length === 0 ? undefined : decodeURIComponent(segments[segments.length - 1]!);
    }

    /** A response header looked up case-insensitively (the production client lower-cases every key). */
    private static Header(response: RestResponse, name: string): string | undefined
    {
        const headers = response.Headers;
        return headers?.[name] ?? headers?.[name.toLowerCase()];
    }

    /**
     * DELETE a resource; a 404 is tolerated as already absent. LastWriteWins deletes unconditionally. Optimistic
     * is fail-closed like PUT: a missing op.Version is a Conflict with NO request issued, and a present version
     * is sent as If-Match so a stale delete maps to 412/409 -> Conflict.
     */
    private async ApplyDelete(batch: WriteBatch, op: WriteOperation): Promise<WriteFailure | undefined>
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
        const response = await this.client.Send(RestHttpMethod.Delete, this.ResourceUrl(batch.Source, op.Key), headers);
        if (RestAdapter.IsVersionConflict(response.Status))
        {
            return { Key: op.Key, Kind: WriteFailureKind.Conflict, Reason: RestAdapter.VersionConflictReason };
        }
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
