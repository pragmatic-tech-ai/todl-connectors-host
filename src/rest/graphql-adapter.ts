import { ConnectionFailureKind, WriteAtomicity, WriteConcurrency, WriteFailureKind, WriteOperationKind } from "@pragmatic-tech-ai/todl";
import type { ExternalFieldValue, ExternalRecord, PageQuery, PageSlice, QueryRequest, WriteBatch, WriteFailure, WriteOperation, WriteResult } from "@pragmatic-tech-ai/todl";
import type { IDataSourceAdapter } from "@pragmatic-tech-ai/todl";
import { ExternalQuery } from "../query/external-query.js";
import { JsonPath } from "./json-path.js";
import { FetchFailureClassifier } from "./fetch-failure-classifier.js";
import { RestHttpMethod } from "./rest-http-client.js";
import type { IRestHttpClient, RestResponse } from "./rest-http-client.js";
import { RestWriteReasons } from "./write-reasons.js";

/** A nested GraphQL selection built from dot-path branches (leaf = a field list, or none for a scalar). */
export class SelectionTree
{
    private static readonly Open = "{ ";
    private static readonly Close = " }";
    private static readonly Space = " ";
    private readonly children = new Map<string, SelectionTree>();
    private leaf: string | undefined;

    public Add(branch: readonly string[], leaf: string | undefined): void
    {
        let node: SelectionTree = this;
        for (const name of branch)
        {
            let next = node.children.get(name);
            if (next === undefined)
            {
                next = new SelectionTree();
                node.children.set(name, next);
            }
            node = next;
        }
        node.leaf = leaf;
    }

    public Render(): string
    {
        const parts: string[] = [];
        for (const [name, node] of this.children)
        {
            const inner = node.children.size > 0 ? node.Render() : node.leaf;
            parts.push(inner === undefined ? name : name + SelectionTree.Open + inner + SelectionTree.Close);
        }
        return parts.join(SelectionTree.Space);
    }
}

/** Declared GraphQL paging: the size/cursor arg names plus where the items and next cursor live under data. */
export interface GraphQlPaging
{
    readonly firstArg: string;
    readonly afterArg: string;
    /** Dot path under `data`, starting with the queryField, of the items array. */
    readonly itemsPath: string;
    /** Dot path under `data`, starting with the queryField, of the next cursor scalar. */
    readonly nextTokenPath: string;
}

/** Parsed GraphQL connection. One adapter instance serves exactly one `source` via `queryField`. */
export interface GraphQlConnection
{
    readonly endpoint: string;
    readonly headers: Record<string, string>;
    readonly source: string;
    readonly queryField: string;
    readonly upsertMutation?: string;
    readonly upsertInputType: string;
    readonly upsertInputArg: string;
    /** Fields selected back from the upsert payload; undefined means "default to the batch IdKey". */
    readonly upsertReturn?: readonly string[];
    readonly deleteMutation?: string;
    readonly deleteIdType: string;
    readonly deleteIdArg: string;
    readonly errorConflictCodes: readonly string[];
    readonly errorUnsupportedCodes: readonly string[];
    /** Present only when the connection declares paging; gates the adapter's CanPage. */
    readonly paging?: GraphQlPaging;
}

export class GraphQlConnectionConfig
{
    private static readonly EndpointKey = "endpoint";
    private static readonly SourceKey = "source";
    private static readonly QueryFieldKey = "queryField";
    private static readonly UpsertMutationKey = "upsertMutation";
    private static readonly UpsertInputTypeKey = "upsertInputType";
    private static readonly UpsertInputArgKey = "upsertInputArg";
    private static readonly UpsertReturnKey = "upsertReturn";
    private static readonly DeleteMutationKey = "deleteMutation";
    private static readonly DeleteIdTypeKey = "deleteIdType";
    private static readonly DeleteIdArgKey = "deleteIdArg";
    private static readonly ErrorConflictCodesKey = "errorConflictCodes";
    private static readonly ErrorUnsupportedCodesKey = "errorUnsupportedCodes";
    private static readonly PageFirstArgKey = "pageFirstArg";
    private static readonly PageAfterArgKey = "pageAfterArg";
    private static readonly ItemsPathKey = "itemsPath";
    private static readonly NextTokenPathKey = "nextTokenPath";
    private static readonly PagingIncompleteMessage = "graphql paging config requires pageFirstArg, pageAfterArg, itemsPath and nextTokenPath";
    private static readonly PagingPathMessage = "graphql paging paths must start with the queryField and be distinct, non-nested paths below it";
    private static readonly DefaultUpsertInputType = "JSON";
    private static readonly DefaultUpsertInputArg = "input";
    private static readonly DefaultDeleteIdType = "ID";
    private static readonly DefaultDeleteIdArg = "id";
    private static readonly AuthorizationHeader = "Authorization";
    private static readonly BearerPrefix = "Bearer ";
    private static readonly MissingMessage = "graphql connector config requires endpoint, source and queryField";
    private static readonly ReturnFieldSeparator = /[\s,]+/;
    private static readonly CodeSeparator = ",";

    public static From(config: Record<string, string>, secret?: string): GraphQlConnection
    {
        const endpoint = config[GraphQlConnectionConfig.EndpointKey];
        const source = config[GraphQlConnectionConfig.SourceKey];
        const queryField = config[GraphQlConnectionConfig.QueryFieldKey];
        if (endpoint === undefined || source === undefined || queryField === undefined)
        {
            throw new Error(GraphQlConnectionConfig.MissingMessage);
        }
        const headers: Record<string, string> = {};
        if (secret !== undefined)
        {
            headers[GraphQlConnectionConfig.AuthorizationHeader] = GraphQlConnectionConfig.BearerPrefix + secret;
        }
        const upsert = config[GraphQlConnectionConfig.UpsertMutationKey];
        const del = config[GraphQlConnectionConfig.DeleteMutationKey];
        const upsertInputType = GraphQlName.Validate(config[GraphQlConnectionConfig.UpsertInputTypeKey] ?? GraphQlConnectionConfig.DefaultUpsertInputType);
        const upsertInputArg = GraphQlName.Validate(config[GraphQlConnectionConfig.UpsertInputArgKey] ?? GraphQlConnectionConfig.DefaultUpsertInputArg);
        const deleteIdType = GraphQlName.Validate(config[GraphQlConnectionConfig.DeleteIdTypeKey] ?? GraphQlConnectionConfig.DefaultDeleteIdType);
        const deleteIdArg = GraphQlName.Validate(config[GraphQlConnectionConfig.DeleteIdArgKey] ?? GraphQlConnectionConfig.DefaultDeleteIdArg);
        // An unset OR empty-after-parse (whitespace/commas-only) upsertReturn is left undefined so the
        // adapter coalesces to [IdKey]: a GraphQL selection set cannot be empty, and returning the id keeps
        // return-id validation working.
        const upsertReturnRaw = config[GraphQlConnectionConfig.UpsertReturnKey];
        const upsertReturnParsed = upsertReturnRaw !== undefined ? GraphQlConnectionConfig.ParseReturnFields(upsertReturnRaw) : [];
        const upsertReturn = upsertReturnParsed.length > 0 ? upsertReturnParsed : undefined;
        const errorConflictCodes = GraphQlConnectionConfig.ParseCodes(config[GraphQlConnectionConfig.ErrorConflictCodesKey]);
        const errorUnsupportedCodes = GraphQlConnectionConfig.ParseCodes(config[GraphQlConnectionConfig.ErrorUnsupportedCodesKey]);
        const paging = GraphQlConnectionConfig.ParsePaging(config, queryField);
        return {
            endpoint, headers, source, queryField,
            upsertInputType, upsertInputArg, deleteIdType, deleteIdArg,
            errorConflictCodes, errorUnsupportedCodes,
            ...(upsert !== undefined ? { upsertMutation: GraphQlName.Validate(upsert) } : {}),
            ...(del !== undefined ? { deleteMutation: GraphQlName.Validate(del) } : {}),
            ...(upsertReturn !== undefined ? { upsertReturn } : {}),
            ...(paging !== undefined ? { paging } : {}),
        };
    }

    /** No paging key = not configured; some-but-not-all keys, or paths outside the queryField, are config errors. */
    private static ParsePaging(config: Record<string, string>, queryField: string): GraphQlPaging | undefined
    {
        const firstArg = config[GraphQlConnectionConfig.PageFirstArgKey];
        const afterArg = config[GraphQlConnectionConfig.PageAfterArgKey];
        const itemsPath = config[GraphQlConnectionConfig.ItemsPathKey];
        const nextTokenPath = config[GraphQlConnectionConfig.NextTokenPathKey];
        const present = [firstArg, afterArg, itemsPath, nextTokenPath].filter(v => v !== undefined).length;
        if (present === 0) return undefined;
        if (firstArg === undefined || afterArg === undefined || itemsPath === undefined || nextTokenPath === undefined)
        {
            throw new Error(GraphQlConnectionConfig.PagingIncompleteMessage);
        }
        const items = GraphQlConnectionConfig.PathBelow(itemsPath, queryField);
        const token = GraphQlConnectionConfig.PathBelow(nextTokenPath, queryField);
        if (GraphQlConnectionConfig.IsSegmentPrefix(items, token) || GraphQlConnectionConfig.IsSegmentPrefix(token, items)) throw new Error(GraphQlConnectionConfig.PagingPathMessage);
        return {
            firstArg: GraphQlName.Validate(firstArg), afterArg: GraphQlName.Validate(afterArg), itemsPath, nextTokenPath,
        };
    }

    /** True when `prefix` is an element-wise prefix of `path` (segment boundaries respected). */
    private static IsSegmentPrefix(prefix: readonly string[], path: readonly string[]): boolean
    {
        return prefix.length <= path.length && prefix.every((segment, i) => segment === path[i]);
    }

    /** The path segments below the queryField (each a valid GraphQL name); throws when the path is not under it. */
    public static PathBelow(path: string, queryField: string): string[]
    {
        const segments = JsonPath.Segments(path);
        if (segments.length < 2 || segments[0] !== queryField) throw new Error(GraphQlConnectionConfig.PagingPathMessage);
        return segments.slice(1).map(s => GraphQlName.Validate(s));
    }

    /** Splits a space-or-comma return list and validates each field as a GraphQL identifier (config-time error). */
    private static ParseReturnFields(value: string): string[]
    {
        return value.split(GraphQlConnectionConfig.ReturnFieldSeparator).filter(f => f.length > 0).map(f => GraphQlName.Validate(f));
    }

    /** Splits a comma-list of extension codes; an unset or empty value yields no codes. */
    private static ParseCodes(value: string | undefined): string[]
    {
        if (value === undefined) return [];
        return value.split(GraphQlConnectionConfig.CodeSeparator).map(c => c.trim()).filter(c => c.length > 0);
    }
}

/** Validates identifiers interpolated into a GraphQL document (GraphQL name rules). */
export class GraphQlName
{
    private static readonly Pattern = /^[_A-Za-z][_0-9A-Za-z]*$/;
    private static readonly InvalidMessage = "graphql name is not a valid identifier";

    public static Validate(name: string): string
    {
        if (typeof name !== "string" || !GraphQlName.Pattern.test(name))
        {
            throw new Error(GraphQlName.InvalidMessage);
        }
        return name;
    }
}

/** GraphQL adapter: read via a configured query field, write via configured mutations. Where re-applied in-adapter. */
export class GraphQlAdapter implements IDataSourceAdapter
{
    private static readonly WriteNotConfiguredReason = "graphql write not configured";
    private static readonly OptimisticUnsupportedReason = "optimistic write not supported by this connector (graphql cannot version)";
    private static readonly WrongSourceReason = "write batch source does not match the connector's configured source";
    private static readonly ReturnedIdMismatchReason = "graphql mutation returned a different id than the one written";
    private static readonly StatusReasonPrefix = "graphql request failed with status ";
    private static readonly DataKey = "data";
    private static readonly ErrorsKey = "errors";
    private static readonly MessageKey = "message";
    private static readonly PathKey = "path";
    private static readonly ExtensionsKey = "extensions";
    private static readonly CodeKey = "code";
    private static readonly RequestFailedMessage = "graphql request failed";
    private static readonly SuccessMin = 200;
    private static readonly SuccessMax = 299;
    private static readonly FieldSeparator = " ";
    private static readonly QueryPrefix = "query{ ";
    private static readonly SelectionOpen = "{ ";
    private static readonly SelectionClose = " }";
    private static readonly MutationVarOpen = "mutation($";
    private static readonly VarTypeSeparator = ": ";
    private static readonly RequiredSelectionOpen = "!){ ";
    private static readonly ArgOpen = "(";
    private static readonly ArgVarSeparator = ": $";
    private static readonly UpsertSelectionOpen = "){ ";
    private static readonly UpsertSelectionClose = " } }";
    private static readonly DeleteArgsClose = ") }";
    private static readonly PageMalformedMessage = "graphql paged read returned a non-array payload at itemsPath";
    private static readonly PagingNotConfiguredMessage = "graphql paging is not configured for this connection";
    private static readonly InvalidLimitMessage = "QueryPage Limit must be a positive integer";
    private static readonly PagedQueryOpen = "query($";
    private static readonly FirstVarType = ": Int, $";
    private static readonly AfterVarType = ": String){ ";
    private static readonly PagedArgsOpen = "(";
    private static readonly FirstArgBind = ": $";
    private static readonly ArgSeparator = ", ";
    private static readonly PagedArgsClose = "){ ";
    private static readonly PagedClose = " } }";
    private static readonly QueryKey = "query";
    private static readonly VariablesKey = "variables";

    public constructor(private readonly client: IRestHttpClient, private readonly connection: GraphQlConnection)
    {
    }

    /** Whether this adapter can enforce an optimistic version guard: no, a GraphQL mutation has no version precondition. */
    public get CanVersion(): boolean
    {
        return false;
    }

    /** Delegates to {@link FetchFailureClassifier}: a pure function of the thrown transport error. */
    public ClassifyFailure(error: unknown): ConnectionFailureKind
    {
        return FetchFailureClassifier.Classify(error);
    }

    /** Whether this adapter can page: true ONLY when the connection declares paging config (GraphQL has no generic id column). */
    public get CanPage(): boolean
    {
        return this.connection.paging !== undefined;
    }

    /** Whether this adapter can run a batch inside a backend transaction: no, each mutation is its own request. */
    public get CanTransact(): boolean
    {
        return false;
    }

    public async Query(request: QueryRequest): Promise<readonly ExternalRecord[]>
    {
        if (request.Source !== this.connection.source) return [];
        const document = this.QueryDocument(GraphQlAdapter.Selection(request));
        const response = await this.client.Send(RestHttpMethod.Post, this.connection.endpoint, this.connection.headers,
            { [GraphQlAdapter.QueryKey]: document });
        GraphQlAdapter.EnsureOk(response);
        const data = (response.Body as Record<string, unknown> | undefined)?.[GraphQlAdapter.DataKey] as Record<string, unknown> | undefined;
        const list = data?.[this.connection.queryField];
        const records = Array.isArray(list) ? list as Record<string, unknown>[] : [];
        return ExternalQuery.Apply(records, request);
    }

    /**
     * Declared-config page: sends first/after as variables to the query field, reads the records from
     * itemsPath and the next cursor from nextTokenPath (both under `data`). NextAfter is set only when
     * the cursor is a non-empty scalar. Where is re-applied to the page in-adapter.
     */
    public async QueryPage(request: QueryRequest, page: PageQuery): Promise<PageSlice>
    {
        const paging = this.connection.paging;
        if (paging === undefined) throw new Error(GraphQlAdapter.PagingNotConfiguredMessage);
        if (!Number.isInteger(page.Limit) || page.Limit <= 0) throw new Error(GraphQlAdapter.InvalidLimitMessage);
        if (request.Source !== this.connection.source) return { Records: [] };
        const variables: Record<string, unknown> = { [paging.firstArg]: page.Limit };
        if (page.After !== undefined) variables[paging.afterArg] = String(page.After);
        const response = await this.client.Send(RestHttpMethod.Post, this.connection.endpoint, this.connection.headers,
            { [GraphQlAdapter.QueryKey]: this.PagedDocument(paging, GraphQlAdapter.Selection(request)), [GraphQlAdapter.VariablesKey]: variables });
        GraphQlAdapter.EnsureOk(response);
        const data = (response.Body as Record<string, unknown> | undefined)?.[GraphQlAdapter.DataKey];
        const items = JsonPath.Read(data, paging.itemsPath);
        if (!Array.isArray(items)) throw new Error(GraphQlAdapter.PageMalformedMessage);
        const records = items as Record<string, unknown>[];
        const next = JsonPath.AsToken(JsonPath.Read(data, paging.nextTokenPath));
        const applied = ExternalQuery.Apply(records, request);
        return next === undefined ? { Records: applied } : { Records: applied, NextAfter: next as ExternalFieldValue };
    }

    /**
     * GraphQL can neither transact nor version, so a Transactional or Optimistic batch comes back wholly
     * Unsupported at apply (defending the plan-build block from Task 5, never a silent downgrade). A batch
     * whose Source does not match the configured source is refused wholesale (mirroring Query's source
     * guard), so no op writes to the wrong field. A LastWriteWins batch runs resiliently: a per-op
     * driver/transport fault becomes a WriteFailure{Error} and the loop continues. Identifier guards on
     * IdKey stay hard errors (injection safety).
     */
    public async Apply(batch: WriteBatch): Promise<WriteResult>
    {
        if (batch.Source !== this.connection.source)
        {
            return GraphQlAdapter.AllFailures(batch, WriteFailureKind.Error, GraphQlAdapter.WrongSourceReason);
        }
        if (batch.Atomicity === WriteAtomicity.Transactional)
        {
            return GraphQlAdapter.AllFailures(batch, WriteFailureKind.Unsupported, RestWriteReasons.TransactionUnsupported);
        }
        if (batch.Concurrency === WriteConcurrency.Optimistic)
        {
            return GraphQlAdapter.AllFailures(batch, WriteFailureKind.Unsupported, GraphQlAdapter.OptimisticUnsupportedReason);
        }
        GraphQlName.Validate(batch.IdKey);
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

    private static AllFailures(batch: WriteBatch, kind: WriteFailureKind, reason: string): WriteResult
    {
        return {
            Applied: 0,
            Failures: batch.Operations.map(op => ({ Key: op.Key, Kind: kind, Reason: reason })),
        };
    }

    /**
     * Applies one op resiliently: a not-configured mutation is Unsupported (the capability is absent),
     * a thrown driver/transport fault is Error, success returns undefined.
     */
    private async ApplyOne(batch: WriteBatch, op: WriteOperation): Promise<WriteFailure | undefined>
    {
        try
        {
            if (op.Kind === WriteOperationKind.Delete)
            {
                return await this.ApplyDelete(op);
            }
            return await this.ApplyUpsert(batch, op);
        }
        catch (error)
        {
            return { Key: op.Key, Kind: WriteFailureKind.Error, Reason: GraphQlAdapter.ErrorReason(error) };
        }
    }

    private async ApplyDelete(op: WriteOperation): Promise<WriteFailure | undefined>
    {
        const mutation = this.connection.deleteMutation;
        if (mutation === undefined)
        {
            return { Key: op.Key, Kind: WriteFailureKind.Unsupported, Reason: GraphQlAdapter.WriteNotConfiguredReason };
        }
        const document = this.DeleteDocument(mutation);
        const response = await this.client.Send(RestHttpMethod.Post, this.connection.endpoint, this.connection.headers,
            { [GraphQlAdapter.QueryKey]: document, [GraphQlAdapter.VariablesKey]: { [this.connection.deleteIdArg]: op.Key } });
        return this.MapResponse(response, mutation, op);
    }

    private async ApplyUpsert(batch: WriteBatch, op: WriteOperation): Promise<WriteFailure | undefined>
    {
        const mutation = this.connection.upsertMutation;
        if (mutation === undefined)
        {
            return { Key: op.Key, Kind: WriteFailureKind.Unsupported, Reason: GraphQlAdapter.WriteNotConfiguredReason };
        }
        const returnFields = this.connection.upsertReturn ?? [batch.IdKey];
        const document = this.UpsertDocument(mutation, returnFields);
        const input = { ...op.Fields, [batch.IdKey]: op.Key };
        const response = await this.client.Send(RestHttpMethod.Post, this.connection.endpoint, this.connection.headers,
            { [GraphQlAdapter.QueryKey]: document, [GraphQlAdapter.VariablesKey]: { [this.connection.upsertInputArg]: input } });
        const failure = this.MapResponse(response, mutation, op);
        if (failure !== undefined) return failure;
        if (returnFields.includes(batch.IdKey))
        {
            return GraphQlAdapter.ValidateReturnedId(response, mutation, batch.IdKey, op);
        }
        return undefined;
    }

    private UpsertDocument(mutation: string, returnFields: readonly string[]): string
    {
        const arg = this.connection.upsertInputArg;
        return GraphQlAdapter.MutationVarOpen + arg + GraphQlAdapter.VarTypeSeparator + this.connection.upsertInputType
            + GraphQlAdapter.RequiredSelectionOpen + mutation + GraphQlAdapter.ArgOpen + arg + GraphQlAdapter.ArgVarSeparator + arg
            + GraphQlAdapter.UpsertSelectionOpen + returnFields.join(GraphQlAdapter.FieldSeparator) + GraphQlAdapter.UpsertSelectionClose;
    }

    private DeleteDocument(mutation: string): string
    {
        const arg = this.connection.deleteIdArg;
        return GraphQlAdapter.MutationVarOpen + arg + GraphQlAdapter.VarTypeSeparator + this.connection.deleteIdType
            + GraphQlAdapter.RequiredSelectionOpen + mutation + GraphQlAdapter.ArgOpen + arg + GraphQlAdapter.ArgVarSeparator + arg
            + GraphQlAdapter.DeleteArgsClose;
    }

    /** Builds the paged document: the items branch ends in the field selection, the cursor branch in a scalar. */
    private PagedDocument(paging: GraphQlPaging, fields: readonly string[]): string
    {
        const field = GraphQlName.Validate(this.connection.queryField);
        const tree = new SelectionTree();
        tree.Add(GraphQlConnectionConfig.PathBelow(paging.itemsPath, field), fields.map(f => GraphQlName.Validate(f)).join(GraphQlAdapter.FieldSeparator));
        tree.Add(GraphQlConnectionConfig.PathBelow(paging.nextTokenPath, field), undefined);
        return GraphQlAdapter.PagedQueryOpen + paging.firstArg + GraphQlAdapter.FirstVarType + paging.afterArg + GraphQlAdapter.AfterVarType
            + field + GraphQlAdapter.PagedArgsOpen + paging.firstArg + GraphQlAdapter.FirstArgBind + paging.firstArg
            + GraphQlAdapter.ArgSeparator + paging.afterArg + GraphQlAdapter.FirstArgBind + paging.afterArg + GraphQlAdapter.PagedArgsClose
            + tree.Render() + GraphQlAdapter.PagedClose;
    }

    private QueryDocument(fields: readonly string[]): string
    {
        return GraphQlAdapter.QueryPrefix + GraphQlName.Validate(this.connection.queryField) + GraphQlAdapter.SelectionOpen
            + fields.map(f => GraphQlName.Validate(f)).join(GraphQlAdapter.FieldSeparator) + GraphQlAdapter.SelectionClose + GraphQlAdapter.SelectionClose;
    }

    /** Union of projected fields and Where fields, deduped, so Where can be re-applied in-adapter. */
    private static Selection(request: QueryRequest): string[]
    {
        const names = new Set<string>(request.Fields);
        for (const term of request.Where?.All ?? []) names.add(term.Field);
        return [...names];
    }

    /**
     * Maps a write response to a per-op failure or success (undefined). A GraphQL `errors` array -- even
     * alongside a `data` payload (partial success) -- is a failure of the kind its `extensions.code` maps to.
     * A non-2xx status with no `errors` is an Error with a status-only reason. Otherwise the op succeeded.
     */
    private MapResponse(response: RestResponse, mutation: string, op: WriteOperation): WriteFailure | undefined
    {
        const errors = (response.Body as { errors?: unknown } | undefined)?.[GraphQlAdapter.ErrorsKey];
        if (Array.isArray(errors) && errors.length > 0)
        {
            return this.MapError(errors, mutation, op);
        }
        if (response.Status < GraphQlAdapter.SuccessMin || response.Status > GraphQlAdapter.SuccessMax)
        {
            return { Key: op.Key, Kind: WriteFailureKind.Error, Reason: GraphQlAdapter.StatusReasonPrefix + response.Status };
        }
        return undefined;
    }

    /** Maps the error targeting this op (by `path`, else the first) through the configured code lists. */
    private MapError(errors: readonly unknown[], mutation: string, op: WriteOperation): WriteFailure
    {
        const error = GraphQlAdapter.SelectError(errors, mutation);
        const code = GraphQlAdapter.ErrorCode(error);
        const kind = code !== undefined && this.connection.errorConflictCodes.includes(code)
            ? WriteFailureKind.Conflict
            : code !== undefined && this.connection.errorUnsupportedCodes.includes(code)
                ? WriteFailureKind.Unsupported
                : WriteFailureKind.Error;
        return { Key: op.Key, Kind: kind, Reason: GraphQlAdapter.SanitizeGraphQlMessage(error) };
    }

    /** The first error whose `path` head names this op's mutation field, else the first error. */
    private static SelectError(errors: readonly unknown[], mutation: string): unknown
    {
        for (const error of errors)
        {
            const path = (error as { path?: unknown } | undefined)?.[GraphQlAdapter.PathKey];
            if (Array.isArray(path) && path.length > 0 && path[0] === mutation) return error;
        }
        return errors[0];
    }

    private static ErrorCode(error: unknown): string | undefined
    {
        const extensions = (error as { extensions?: unknown } | undefined)?.[GraphQlAdapter.ExtensionsKey];
        const code = (extensions as { code?: unknown } | undefined)?.[GraphQlAdapter.CodeKey];
        return typeof code === "string" ? code : undefined;
    }

    /**
     * Redaction boundary: a failure Reason carries ONLY the schema-authored GraphQL error `message` string --
     * never the variables, the document, request headers, or the `extensions` payload (any of which may
     * carry row data or secrets). A missing/non-string message falls back to the generic request-failed text.
     */
    private static SanitizeGraphQlMessage(error: unknown): string
    {
        const message = (error as { message?: unknown } | undefined)?.[GraphQlAdapter.MessageKey];
        return typeof message === "string" ? message : GraphQlAdapter.RequestFailedMessage;
    }

    /**
     * A null mutation payload with no errors stays success (today's behavior). When the upsert selects the
     * IdKey back, a returned id other than the one written is an Error -- the server acknowledged a different row.
     */
    private static ValidateReturnedId(response: RestResponse, mutation: string, idKey: string, op: WriteOperation): WriteFailure | undefined
    {
        const data = (response.Body as { data?: unknown } | undefined)?.[GraphQlAdapter.DataKey] as Record<string, unknown> | undefined;
        const payload = data?.[mutation];
        if (payload === null || payload === undefined) return undefined;
        const returned = (payload as Record<string, unknown>)[idKey];
        if (returned !== op.Key)
        {
            return { Key: op.Key, Kind: WriteFailureKind.Error, Reason: GraphQlAdapter.ReturnedIdMismatchReason };
        }
        return undefined;
    }

    private static ErrorReason(error: unknown): string
    {
        return error instanceof Error ? error.message : String(error);
    }

    /** Throws a secret-free error for a non-2xx status or a GraphQL errors array (read path only). */
    private static EnsureOk(response: RestResponse): void
    {
        const errors = (response.Body as { errors?: unknown } | undefined)?.[GraphQlAdapter.ErrorsKey];
        const statusOk = response.Status >= GraphQlAdapter.SuccessMin && response.Status <= GraphQlAdapter.SuccessMax;
        if (!statusOk || (Array.isArray(errors) && errors.length > 0))
        {
            throw new Error(GraphQlAdapter.RequestFailedMessage);
        }
    }
}
