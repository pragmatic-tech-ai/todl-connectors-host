import { ConnectionFailureKind, WriteAtomicity, WriteConcurrency, WriteFailureKind, WriteOperationKind } from "@pragmatic-tech-ai/todl";
import { DeclaredFilters, type PushedFilter } from "./declared-filters.js";
import type { ExternalFieldValue, ExternalRecord, IAssignedKey, PageQuery, PageSlice, QueryRequest, WriteBatch, WriteFailure, WriteOperation, WriteResult } from "@pragmatic-tech-ai/todl";
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
    /** Source-keyed insert mutation; its presence gates CanAssignKeys. */
    readonly insertMutation?: string;
    readonly insertInputType: string;
    readonly insertInputArg: string;
    /** Fields selected back from the upsert payload; undefined means "default to the batch IdKey". */
    readonly upsertReturn?: readonly string[];
    readonly deleteMutation?: string;
    readonly deleteIdType: string;
    readonly deleteIdArg: string;
    readonly errorConflictCodes: readonly string[];
    readonly errorUnsupportedCodes: readonly string[];
    /** Present only when the connection declares paging; gates the adapter's CanPage. */
    readonly paging?: GraphQlPaging;
    /** Declared query-field equality arguments (`filterArgs`); absent when undeclared. */
    readonly filters?: DeclaredFilters;
    /** The mutation argument carrying an optimistic write's expected version (`versionArg` + `versionArgType`); gates CanVersion. */
    readonly version?: { readonly arg: string; readonly type: string };
    /** Schema-aware upsert: one typed mutation argument per field (`upsertArgs`) instead of a single JSON input. */
    readonly upsertArgs?: DeclaredFilters;
    /** The key argument of a per-field upsert (`upsertKeyArg = "id:ID!"`). */
    readonly upsertKeyArg?: { readonly arg: string; readonly type: string };
}

export class GraphQlConnectionConfig
{
    private static readonly EndpointKey = "endpoint";
    private static readonly SourceKey = "source";
    private static readonly QueryFieldKey = "queryField";
    private static readonly UpsertMutationKey = "upsertMutation";
    private static readonly UpsertInputTypeKey = "upsertInputType";
    private static readonly UpsertInputArgKey = "upsertInputArg";
    private static readonly InsertMutationKey = "insertMutation";
    private static readonly InsertInputTypeKey = "insertInputType";
    private static readonly InsertInputArgKey = "insertInputArg";
    private static readonly DefaultInsertInputType = "JSON!";
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
    private static readonly FilterArgsKey = "filterArgs";
    private static readonly VersionArgKey = "versionArg";
    private static readonly VersionArgTypeKey = "versionArgType";
    private static readonly UpsertArgsKey = "upsertArgs";
    private static readonly UpsertKeyArgKey = "upsertKeyArg";
    private static readonly DefaultKeyArg = "id";
    private static readonly DefaultKeyType = "ID!";
    private static readonly TypedArgSeparator = ":";
    private static readonly TypePattern = /^\[?[_A-Za-z][_0-9A-Za-z]*!?\]?!?$/;
    private static readonly VersionPairMessage = "graphql versionArg and versionArgType must be declared together";
    private static readonly CollisionMessage = "graphql config would repeat a variable or argument (a configured name collides with a generated one, or two declarations share an argument)";
    private static readonly VersionVariable = "version";
    private static readonly FilterVariable = /^f\d+$/;
    private static readonly TypeMessage = "graphql argument type is not a valid GraphQL type";
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
        const insert = config[GraphQlConnectionConfig.InsertMutationKey];
        // insertInputType may carry a `!` (its JSON! default) so it is a GraphQL TYPE, not a bare identifier.
        const insertInputType = GraphQlConnectionConfig.ValidateType(config[GraphQlConnectionConfig.InsertInputTypeKey] ?? GraphQlConnectionConfig.DefaultInsertInputType);
        const insertInputArg = GraphQlName.Validate(config[GraphQlConnectionConfig.InsertInputArgKey] ?? GraphQlConnectionConfig.DefaultUpsertInputArg);
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
        const filters = DeclaredFilters.Parse(config[GraphQlConnectionConfig.FilterArgsKey], true);
        const version = GraphQlConnectionConfig.ParseVersion(config);
        const upsertArgs = DeclaredFilters.Parse(config[GraphQlConnectionConfig.UpsertArgsKey], true);
        const upsertKeyArg = upsertArgs.IsEmpty ? undefined : GraphQlConnectionConfig.ParseTypedArg(config[GraphQlConnectionConfig.UpsertKeyArgKey]);
        GraphQlConnectionConfig.RejectCollisions(upsertInputArg, deleteIdArg, filters, upsertArgs, upsertKeyArg?.arg, version?.arg, paging);
        return {
            endpoint, headers, source, queryField,
            upsertInputType, upsertInputArg, deleteIdType, deleteIdArg,
            insertInputType, insertInputArg,
            errorConflictCodes, errorUnsupportedCodes,
            ...(upsert !== undefined ? { upsertMutation: GraphQlName.Validate(upsert) } : {}),
            ...(del !== undefined ? { deleteMutation: GraphQlName.Validate(del) } : {}),
            ...(insert !== undefined ? { insertMutation: GraphQlName.Validate(insert) } : {}),
            ...(upsertReturn !== undefined ? { upsertReturn } : {}),
            ...(paging !== undefined ? { paging } : {}),
            ...(filters.IsEmpty ? {} : { filters }),
            ...(version !== undefined ? { version } : {}),
            ...(upsertArgs.IsEmpty ? {} : { upsertArgs, upsertKeyArg: upsertKeyArg! }),
        };
    }

    /**
     * Refuses configurations whose generated documents would repeat a variable or an argument: a configured variable name
     * equal to one the adapter generates in the same document ($version beside the input / delete-id variable, $f0.. beside
     * the paging variables), two fields mapped to one argument, or a declared argument equal to the key / version / paging
     * argument it is sent beside. ($key / $a0.. live only in the typed-upsert document, which declares no configured
     * variable.)
     */
    private static RejectCollisions(upsertInputArg: string, deleteIdArg: string, filters: DeclaredFilters, upsertArgs: DeclaredFilters, keyArg: string | undefined, versionArg: string | undefined, paging: GraphQlPaging | undefined): void
    {
        const unique = (names: readonly string[]): boolean => new Set(names).size === names.length;
        // Variables each generated document declares beside the configured ones.
        if (versionArg !== undefined && (upsertInputArg === GraphQlConnectionConfig.VersionVariable || deleteIdArg === GraphQlConnectionConfig.VersionVariable))
        {
            throw new Error(GraphQlConnectionConfig.CollisionMessage);
        }
        if (paging !== undefined && !filters.IsEmpty && [paging.firstArg, paging.afterArg].some(v => GraphQlConnectionConfig.FilterVariable.test(v)))
        {
            throw new Error(GraphQlConnectionConfig.CollisionMessage);
        }
        // Arguments each generated document passes to one field.
        if (!unique([...upsertArgs.Targets(), ...(keyArg !== undefined ? [keyArg] : []), ...(versionArg !== undefined && !upsertArgs.IsEmpty ? [versionArg] : [])]))
        {
            throw new Error(GraphQlConnectionConfig.CollisionMessage);
        }
        if (!unique([...filters.Targets(), ...(paging !== undefined ? [paging.firstArg, paging.afterArg] : [])]))
        {
            throw new Error(GraphQlConnectionConfig.CollisionMessage);
        }
    }

    private static ParseVersion(config: Record<string, string>): { arg: string; type: string } | undefined
    {
        const arg = config[GraphQlConnectionConfig.VersionArgKey];
        const type = config[GraphQlConnectionConfig.VersionArgTypeKey];
        if (arg === undefined && type === undefined) return undefined;
        if (arg === undefined || type === undefined) throw new Error(GraphQlConnectionConfig.VersionPairMessage);
        return { arg: GraphQlName.Validate(arg), type: GraphQlConnectionConfig.ValidateType(type) };
    }

    /** `arg:Type`, defaulting to `id:ID!` when undeclared. */
    private static ParseTypedArg(raw: string | undefined): { arg: string; type: string }
    {
        if (raw === undefined) return { arg: GraphQlConnectionConfig.DefaultKeyArg, type: GraphQlConnectionConfig.DefaultKeyType };
        const [arg, type, ...rest] = raw.split(GraphQlConnectionConfig.TypedArgSeparator).map(p => p.trim());
        if (arg === undefined || type === undefined || rest.length > 0) throw new Error(GraphQlConnectionConfig.TypeMessage);
        return { arg: GraphQlName.Validate(arg), type: GraphQlConnectionConfig.ValidateType(type) };
    }

    private static ValidateType(type: string): string
    {
        if (!GraphQlConnectionConfig.TypePattern.test(type.trim())) throw new Error(GraphQlConnectionConfig.TypeMessage);
        return type.trim();
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

/** The result of applying one GraphQL op: a failure, or the source-assigned key of an insert; both absent means a plain success. */
interface IGraphQlOpOutcome
{
    readonly Failure?: WriteFailure;
    readonly Assigned?: IAssignedKey;
}

/** GraphQL adapter: read via a configured query field, write via configured mutations. Where re-applied in-adapter. */
export class GraphQlAdapter implements IDataSourceAdapter
{
    private static readonly WriteNotConfiguredReason = "graphql write not configured";
    private static readonly InsertNotConfiguredReason = "graphql insert not configured (no insertMutation)";
    private static readonly InsertKeyNotReturnedReason = "graphql insert returned no key";
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
    private static readonly FilterVarPrefix = "f";
    private static readonly VersionVariable = "version";
    private static readonly KeyVariable = "key";
    private static readonly FieldVariablePrefix = "a";
    private static readonly MutationOpen = "mutation($";
    private static readonly RequiredMarker = "!";
    private static readonly VarsClose = "){ ";
    private static readonly UndeclaredFieldPrefix = "graphql upsert has no declared argument for field: ";
    private static readonly MissingVersionReason = "optimistic write has no expected version";
    private static readonly VarSigil = "$";
    private static readonly FilteredQueryOpen = "query($";
    private static readonly FilteredVarsClose = "){ ";
    private static readonly FilteredArgsClose = ")";
    private static readonly VariablesKey = "variables";

    public constructor(private readonly client: IRestHttpClient, private readonly connection: GraphQlConnection)
    {
    }

    /** A GraphQL server enforces (and assigns) versions itself; the engine never computes a next version for it. */
    public get SourceManagesVersions(): boolean
    {
        return true;
    }

    /** Whether this adapter can enforce an optimistic version guard: only when the connection declares the mutation argument
     *  that carries the expected version (the server enforces it and reports a stale version via an errorConflictCodes code). */
    public get CanVersion(): boolean
    {
        return this.connection.version !== undefined;
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

    /** Whether this adapter can execute source-keyed inserts: only when the connection declares an insert mutation. */
    public get CanAssignKeys(): boolean
    {
        return this.connection.insertMutation !== undefined;
    }

    public async Query(request: QueryRequest): Promise<readonly ExternalRecord[]>
    {
        if (request.Source !== this.connection.source) return [];
        const pushed = this.connection.filters?.Pick(request.Where) ?? [];
        const document = this.QueryDocument(GraphQlAdapter.Selection(request), pushed);
        const body: Record<string, unknown> = { [GraphQlAdapter.QueryKey]: document };
        if (pushed.length > 0) body[GraphQlAdapter.VariablesKey] = GraphQlAdapter.FilterVariables(pushed);
        const response = await this.client.Send(RestHttpMethod.Post, this.connection.endpoint, this.connection.headers, body);
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
        const pushed = this.connection.filters?.Pick(request.Where) ?? [];
        const variables: Record<string, unknown> = { ...GraphQlAdapter.FilterVariables(pushed), [paging.firstArg]: page.Limit };
        if (page.After !== undefined) variables[paging.afterArg] = String(page.After);
        const response = await this.client.Send(RestHttpMethod.Post, this.connection.endpoint, this.connection.headers,
            { [GraphQlAdapter.QueryKey]: this.PagedDocument(paging, GraphQlAdapter.Selection(request), pushed), [GraphQlAdapter.VariablesKey]: variables });
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
        if (batch.Concurrency === WriteConcurrency.Optimistic && this.connection.version === undefined)
        {
            return GraphQlAdapter.AllFailures(batch, WriteFailureKind.Unsupported, GraphQlAdapter.OptimisticUnsupportedReason);
        }
        GraphQlName.Validate(batch.IdKey);
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
        // W20: each applied insert's key is reported under its Ref and the loop returns normally (ApplyOne catches
        // every per-op throw), so a mid-batch failure never orphans the mutations that already applied.
        return assigned.length === 0 ? { Applied: applied, Failures: failures } : { Applied: applied, Failures: failures, Assigned: assigned };
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
    private async ApplyOne(batch: WriteBatch, op: WriteOperation): Promise<IGraphQlOpOutcome>
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
            return { Failure: { Key: op.Key, Kind: WriteFailureKind.Error, Reason: GraphQlAdapter.ErrorReason(error) } };
        }
    }

    /**
     * Runs one source-keyed insert through the configured insertMutation: `mutation($input: <insertInputType>){
     * <insertMutation>(<insertInputArg>: $input){ <IdKey> [<VersionField>] } }`, with the op's Fields as the input.
     * The key comes from `data.<insertMutation>.<IdKey>` (its absence is an Error failure); the version from the
     * version field when the batch declares one.
     */
    private async ApplyInsert(batch: WriteBatch, op: WriteOperation): Promise<IGraphQlOpOutcome>
    {
        const mutation = this.connection.insertMutation;
        if (mutation === undefined)
        {
            return { Failure: { Key: op.Key, Kind: WriteFailureKind.Unsupported, Reason: GraphQlAdapter.InsertNotConfiguredReason } };
        }
        const returnFields = [GraphQlName.Validate(batch.IdKey), ...(batch.VersionField === undefined ? [] : [GraphQlName.Validate(batch.VersionField)])];
        const arg = this.connection.insertInputArg;
        const document = GraphQlAdapter.MutationVarOpen + arg + GraphQlAdapter.VarTypeSeparator + this.connection.insertInputType
            + GraphQlAdapter.VarsClose + mutation + GraphQlAdapter.ArgOpen + arg + GraphQlAdapter.ArgVarSeparator + arg
            + GraphQlAdapter.UpsertSelectionOpen + returnFields.join(GraphQlAdapter.FieldSeparator) + GraphQlAdapter.UpsertSelectionClose;
        const response = await this.client.Send(RestHttpMethod.Post, this.connection.endpoint, this.connection.headers,
            { [GraphQlAdapter.QueryKey]: document, [GraphQlAdapter.VariablesKey]: { [arg]: op.Fields } });
        const failure = this.MapResponse(response, mutation, op);
        if (failure !== undefined) return { Failure: failure };
        const payload = GraphQlAdapter.MutationPayload(response, mutation);
        const key = payload?.[batch.IdKey];
        if (key === undefined || key === null)
        {
            return { Failure: { Key: op.Key, Kind: WriteFailureKind.Error, Reason: GraphQlAdapter.InsertKeyNotReturnedReason } };
        }
        const version = batch.VersionField === undefined ? undefined : payload?.[batch.VersionField];
        return { Assigned: version === undefined || version === null
            ? { Ref: op.Ref!, Key: key as ExternalFieldValue }
            : { Ref: op.Ref!, Key: key as ExternalFieldValue, Version: version as ExternalFieldValue } };
    }

    /** The `data.<mutation>` object of a write response, or undefined when the server returned no payload. */
    private static MutationPayload(response: RestResponse, mutation: string): Record<string, unknown> | undefined
    {
        const data = (response.Body as { data?: unknown } | undefined)?.[GraphQlAdapter.DataKey] as Record<string, unknown> | undefined;
        const payload = data?.[mutation];
        return payload === null || payload === undefined ? undefined : payload as Record<string, unknown>;
    }

    private async ApplyDelete(batch: WriteBatch, op: WriteOperation): Promise<WriteFailure | undefined>
    {
        const mutation = this.connection.deleteMutation;
        if (mutation === undefined)
        {
            return { Key: op.Key, Kind: WriteFailureKind.Unsupported, Reason: GraphQlAdapter.WriteNotConfiguredReason };
        }
        const version = this.VersionFor(batch);
        if (version !== undefined && (op.Version === undefined || op.Version === null)) return GraphQlAdapter.Unversioned(op);
        const variables: Record<string, unknown> = { [this.connection.deleteIdArg]: op.Key };
        if (version !== undefined) variables[GraphQlAdapter.VersionVariable] = op.Version ?? null;
        const document = this.DeleteDocument(mutation, version);
        const response = await this.client.Send(RestHttpMethod.Post, this.connection.endpoint, this.connection.headers,
            { [GraphQlAdapter.QueryKey]: document, [GraphQlAdapter.VariablesKey]: variables });
        return this.MapResponse(response, mutation, op);
    }

    // An optimistic write with no expected version cannot be guarded: fail closed (Conflict) without sending anything.
    private static Unversioned(op: WriteOperation): WriteFailure
    {
        return { Key: op.Key, Kind: WriteFailureKind.Conflict, Reason: GraphQlAdapter.MissingVersionReason };
    }

    /** The declared version argument when this batch is optimistic (the expected version travels as $version). */
    private VersionFor(batch: WriteBatch): { arg: string; type: string } | undefined
    {
        return batch.Concurrency === WriteConcurrency.Optimistic ? this.connection.version : undefined;
    }

    private async ApplyUpsert(batch: WriteBatch, op: WriteOperation): Promise<WriteFailure | undefined>
    {
        const mutation = this.connection.upsertMutation;
        if (mutation === undefined)
        {
            return { Key: op.Key, Kind: WriteFailureKind.Unsupported, Reason: GraphQlAdapter.WriteNotConfiguredReason };
        }
        const returnFields = this.connection.upsertReturn ?? [batch.IdKey];
        const version = this.VersionFor(batch);
        if (version !== undefined && (op.Version === undefined || op.Version === null)) return GraphQlAdapter.Unversioned(op);
        let document: string;
        let variables: Record<string, unknown>;
        if (this.connection.upsertArgs !== undefined)
        {
            const typed = this.TypedUpsert(batch, op, mutation, returnFields, version);
            if ("Kind" in typed) return typed;
            [document, variables] = [typed.document, typed.variables];
        }
        else
        {
            document = this.UpsertDocument(mutation, returnFields, version);
            variables = { [this.connection.upsertInputArg]: { ...op.Fields, [batch.IdKey]: op.Key } };
        }
        if (version !== undefined) variables[GraphQlAdapter.VersionVariable] = op.Version ?? null;
        const response = await this.client.Send(RestHttpMethod.Post, this.connection.endpoint, this.connection.headers,
            { [GraphQlAdapter.QueryKey]: document, [GraphQlAdapter.VariablesKey]: variables });
        const failure = this.MapResponse(response, mutation, op);
        if (failure !== undefined) return failure;
        if (returnFields.includes(batch.IdKey))
        {
            return GraphQlAdapter.ValidateReturnedId(response, mutation, batch.IdKey, op);
        }
        return undefined;
    }

    private UpsertDocument(mutation: string, returnFields: readonly string[], version: { arg: string; type: string } | undefined): string
    {
        const arg = this.connection.upsertInputArg;
        return GraphQlAdapter.MutationVarOpen + arg + GraphQlAdapter.VarTypeSeparator + this.connection.upsertInputType
            + GraphQlAdapter.RequiredMarker + GraphQlAdapter.VersionVarDef(version) + GraphQlAdapter.VarsClose
            + mutation + GraphQlAdapter.ArgOpen + arg + GraphQlAdapter.ArgVarSeparator + arg + GraphQlAdapter.VersionArgBind(version)
            + GraphQlAdapter.UpsertSelectionOpen + returnFields.join(GraphQlAdapter.FieldSeparator) + GraphQlAdapter.UpsertSelectionClose;
    }

    /**
     * Schema-aware upsert: the key and each field travel as their own declared, typed mutation argument
     * (`upsertArgs = "name=name:String, region=region:String"`, `upsertKeyArg = "id:ID!"`). A field with no declared argument
     * cannot be written (Unsupported for that op); the version column is skipped when undeclared, since a GraphQL source
     * manages its own version and the expected version travels as the version argument.
     */
    private TypedUpsert(batch: WriteBatch, op: WriteOperation, mutation: string, returnFields: readonly string[], version: { arg: string; type: string } | undefined): { document: string; variables: Record<string, unknown> } | WriteFailure
    {
        const args = this.connection.upsertArgs!;
        const key = this.connection.upsertKeyArg!;
        const defs = [GraphQlAdapter.KeyVariable + GraphQlAdapter.VarTypeSeparator + key.type];
        const binds = [key.arg + GraphQlAdapter.ArgVarSeparator + GraphQlAdapter.KeyVariable];
        const variables: Record<string, unknown> = { [GraphQlAdapter.KeyVariable]: op.Key };
        let i = 0;
        for (const [field, value] of Object.entries(op.Fields))
        {
            if (field === batch.IdKey) continue;
            const declared = args.For(field);
            if (declared === undefined)
            {
                if (field === batch.VersionField) continue;
                return { Key: op.Key, Kind: WriteFailureKind.Unsupported, Reason: GraphQlAdapter.UndeclaredFieldPrefix + field };
            }
            const name = GraphQlAdapter.FieldVariablePrefix + i++;
            defs.push(name + GraphQlAdapter.VarTypeSeparator + declared.Type!);
            binds.push(GraphQlName.Validate(declared.Target) + GraphQlAdapter.ArgVarSeparator + name);
            variables[name] = value;
        }
        if (version !== undefined)
        {
            defs.push(GraphQlAdapter.VersionVariable + GraphQlAdapter.VarTypeSeparator + version.type);
            binds.push(version.arg + GraphQlAdapter.ArgVarSeparator + GraphQlAdapter.VersionVariable);
        }
        const document = GraphQlAdapter.MutationOpen + defs.join(GraphQlAdapter.ArgSeparator + GraphQlAdapter.VarSigil) + GraphQlAdapter.VarsClose
            + mutation + GraphQlAdapter.ArgOpen + binds.join(GraphQlAdapter.ArgSeparator)
            + GraphQlAdapter.UpsertSelectionOpen + returnFields.join(GraphQlAdapter.FieldSeparator) + GraphQlAdapter.UpsertSelectionClose;
        return { document, variables };
    }

    private DeleteDocument(mutation: string, version: { arg: string; type: string } | undefined): string
    {
        const arg = this.connection.deleteIdArg;
        return GraphQlAdapter.MutationVarOpen + arg + GraphQlAdapter.VarTypeSeparator + this.connection.deleteIdType
            + GraphQlAdapter.RequiredMarker + GraphQlAdapter.VersionVarDef(version) + GraphQlAdapter.VarsClose
            + mutation + GraphQlAdapter.ArgOpen + arg + GraphQlAdapter.ArgVarSeparator + arg + GraphQlAdapter.VersionArgBind(version)
            + GraphQlAdapter.DeleteArgsClose;
    }

    private static VersionVarDef(version: { arg: string; type: string } | undefined): string
    {
        return version === undefined ? "" : GraphQlAdapter.ArgSeparator + GraphQlAdapter.VarSigil + GraphQlAdapter.VersionVariable + GraphQlAdapter.VarTypeSeparator + version.type;
    }

    private static VersionArgBind(version: { arg: string; type: string } | undefined): string
    {
        return version === undefined ? "" : GraphQlAdapter.ArgSeparator + version.arg + GraphQlAdapter.ArgVarSeparator + GraphQlAdapter.VersionVariable;
    }

    /** Builds the paged document: the items branch ends in the field selection, the cursor branch in a scalar. */
    private PagedDocument(paging: GraphQlPaging, fields: readonly string[], pushed: readonly PushedFilter[]): string
    {
        const field = GraphQlName.Validate(this.connection.queryField);
        const tree = new SelectionTree();
        tree.Add(GraphQlConnectionConfig.PathBelow(paging.itemsPath, field), fields.map(f => GraphQlName.Validate(f)).join(GraphQlAdapter.FieldSeparator));
        tree.Add(GraphQlConnectionConfig.PathBelow(paging.nextTokenPath, field), undefined);
        return GraphQlAdapter.PagedQueryOpen + GraphQlAdapter.FilterVarDefs(pushed, true) + paging.firstArg + GraphQlAdapter.FirstVarType + paging.afterArg + GraphQlAdapter.AfterVarType
            + field + GraphQlAdapter.PagedArgsOpen + GraphQlAdapter.FilterArgs(pushed, true) + paging.firstArg + GraphQlAdapter.FirstArgBind + paging.firstArg
            + GraphQlAdapter.ArgSeparator + paging.afterArg + GraphQlAdapter.FirstArgBind + paging.afterArg + GraphQlAdapter.PagedArgsClose
            + tree.Render() + GraphQlAdapter.PagedClose;
    }

    private QueryDocument(fields: readonly string[], pushed: readonly PushedFilter[]): string
    {
        const selection = GraphQlAdapter.SelectionOpen + fields.map(f => GraphQlName.Validate(f)).join(GraphQlAdapter.FieldSeparator) + GraphQlAdapter.SelectionClose;
        const field = GraphQlName.Validate(this.connection.queryField);
        if (pushed.length === 0) return GraphQlAdapter.QueryPrefix + field + selection + GraphQlAdapter.SelectionClose;
        return GraphQlAdapter.FilteredQueryOpen + GraphQlAdapter.FilterVarDefs(pushed, false) + GraphQlAdapter.FilteredVarsClose
            + field + GraphQlAdapter.ArgOpen + GraphQlAdapter.FilterArgs(pushed, false) + GraphQlAdapter.FilteredArgsClose + selection + GraphQlAdapter.SelectionClose;
    }

    // Declared filter variables are named f0, f1, ... (never colliding with the paging args, which are validated names).
    private static FilterVariable(i: number): string
    {
        return GraphQlAdapter.FilterVarPrefix + i;
    }

    private static FilterVariables(pushed: readonly PushedFilter[]): Record<string, unknown>
    {
        return Object.fromEntries(pushed.map((p, i) => [GraphQlAdapter.FilterVariable(i), p.Value]));
    }

    private static FilterVarDefs(pushed: readonly PushedFilter[], trailing: boolean): string
    {
        const defs = pushed.map((p, i) => GraphQlAdapter.FilterVariable(i) + GraphQlAdapter.VarTypeSeparator + p.Filter.Type!);
        return defs.join(GraphQlAdapter.ArgSeparator + GraphQlAdapter.VarSigil) + (trailing && defs.length > 0 ? GraphQlAdapter.ArgSeparator + GraphQlAdapter.VarSigil : "");
    }

    private static FilterArgs(pushed: readonly PushedFilter[], trailing: boolean): string
    {
        const args = pushed.map((p, i) => GraphQlName.Validate(p.Filter.Target) + GraphQlAdapter.FirstArgBind + GraphQlAdapter.FilterVariable(i));
        return args.join(GraphQlAdapter.ArgSeparator) + (trailing && args.length > 0 ? GraphQlAdapter.ArgSeparator : "");
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
