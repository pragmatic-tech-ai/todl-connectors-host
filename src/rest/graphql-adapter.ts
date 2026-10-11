import { WriteOperationKind } from "@pragmatic-tech-ai/todl";
import type { ExternalRecord, QueryRequest, WriteBatch, WriteConflict, WriteOperation, WriteResult } from "@pragmatic-tech-ai/todl";
import type { IDataSourceAdapter } from "@pragmatic-tech-ai/todl";
import { ExternalQuery } from "../query/external-query.js";
import { RestHttpMethod } from "./rest-http-client.js";
import type { IRestHttpClient, RestResponse } from "./rest-http-client.js";

/** Parsed GraphQL connection. One adapter instance serves exactly one `source` via `queryField`. */
export interface GraphQlConnection
{
    readonly endpoint: string;
    readonly headers: Record<string, string>;
    readonly source: string;
    readonly queryField: string;
    readonly upsertMutation?: string;
    readonly deleteMutation?: string;
}

export class GraphQlConnectionConfig
{
    private static readonly EndpointKey = "endpoint";
    private static readonly SourceKey = "source";
    private static readonly QueryFieldKey = "queryField";
    private static readonly UpsertMutationKey = "upsertMutation";
    private static readonly DeleteMutationKey = "deleteMutation";
    private static readonly AuthorizationHeader = "Authorization";
    private static readonly BearerPrefix = "Bearer ";
    private static readonly MissingMessage = "graphql connector config requires endpoint, source and queryField";

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
        return {
            endpoint, headers, source, queryField,
            ...(upsert !== undefined ? { upsertMutation: upsert } : {}),
            ...(del !== undefined ? { deleteMutation: del } : {}),
        };
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
    private static readonly DataKey = "data";
    private static readonly ErrorsKey = "errors";
    private static readonly RequestFailedMessage = "graphql request failed";
    private static readonly SuccessMin = 200;
    private static readonly SuccessMax = 299;
    private static readonly FieldSeparator = " ";
    private static readonly QueryPrefix = "query{ ";
    private static readonly SelectionOpen = "{ ";
    private static readonly SelectionClose = " }";
    private static readonly DeletePrefix = "mutation($id: ID!){ ";
    private static readonly DeleteArgs = "(id: $id) }";
    private static readonly UpsertPrefix = "mutation($input: JSON!){ ";
    private static readonly UpsertArgs = "(input: $input){ ";
    private static readonly UpsertSuffix = " } }";
    private static readonly QueryKey = "query";
    private static readonly VariablesKey = "variables";
    private static readonly IdVariable = "id";
    private static readonly InputVariable = "input";

    public constructor(private readonly client: IRestHttpClient, private readonly connection: GraphQlConnection)
    {
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

    public async Apply(batch: WriteBatch): Promise<WriteResult>
    {
        let applied = 0;
        const conflicts: WriteConflict[] = [];
        for (const op of batch.Operations)
        {
            if (await this.ApplyOne(batch, op)) applied++;
            else conflicts.push({ Key: op.Key, Reason: GraphQlAdapter.WriteNotConfiguredReason });
        }
        return { Applied: applied, Conflicts: conflicts };
    }

    public async Dispose(): Promise<void>
    {
    }

    private async ApplyOne(batch: WriteBatch, op: WriteOperation): Promise<boolean>
    {
        if (op.Kind === WriteOperationKind.Delete)
        {
            if (this.connection.deleteMutation === undefined) return false;
            // Assumes a schema convention: id is an ID! argument (richer/configurable write types are a documented deferral).
            const document = GraphQlAdapter.DeletePrefix + GraphQlName.Validate(this.connection.deleteMutation) + GraphQlAdapter.DeleteArgs;
            const response = await this.client.Send(RestHttpMethod.Post, this.connection.endpoint, this.connection.headers,
                { [GraphQlAdapter.QueryKey]: document, [GraphQlAdapter.VariablesKey]: { [GraphQlAdapter.IdVariable]: op.Key } });
            GraphQlAdapter.EnsureOk(response);
            return true;
        }
        if (this.connection.upsertMutation === undefined) return false;
        // Assumes a schema convention: a JSON! input scalar (richer/configurable write types are a documented deferral).
        const document = GraphQlAdapter.UpsertPrefix + GraphQlName.Validate(this.connection.upsertMutation) + GraphQlAdapter.UpsertArgs
            + GraphQlName.Validate(batch.IdKey) + GraphQlAdapter.UpsertSuffix;
        const input = { ...op.Fields, [batch.IdKey]: op.Key };
        const response = await this.client.Send(RestHttpMethod.Post, this.connection.endpoint, this.connection.headers,
            { [GraphQlAdapter.QueryKey]: document, [GraphQlAdapter.VariablesKey]: { [GraphQlAdapter.InputVariable]: input } });
        GraphQlAdapter.EnsureOk(response);
        return true;
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

    /** Throws a secret-free error for a non-2xx status or a GraphQL errors array. */
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
