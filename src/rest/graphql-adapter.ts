import { WriteOperationKind } from "@pragmatic-tech-ai/todl";
import type { ExternalRecord, QueryRequest, WriteBatch, WriteConflict, WriteOperation, WriteResult } from "@pragmatic-tech-ai/todl";
import type { IDataSourceAdapter } from "@pragmatic-tech-ai/todl";
import { ExternalQuery } from "../query/external-query.js";
import { RestHttpMethod } from "./rest-http-client.js";
import type { IRestHttpClient } from "./rest-http-client.js";

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

/** GraphQL adapter: read via a configured query field, write via configured mutations. Where re-applied in-adapter. */
export class GraphQlAdapter implements IDataSourceAdapter
{
    private static readonly WriteNotConfiguredReason = "graphql write not configured";
    private static readonly DataKey = "data";
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
        const document = this.QueryDocument(request.Fields);
        const response = await this.client.Send(RestHttpMethod.Post, this.connection.endpoint, this.connection.headers,
            { [GraphQlAdapter.QueryKey]: document });
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
            const document = GraphQlAdapter.DeletePrefix + this.connection.deleteMutation + GraphQlAdapter.DeleteArgs;
            await this.client.Send(RestHttpMethod.Post, this.connection.endpoint, this.connection.headers,
                { [GraphQlAdapter.QueryKey]: document, [GraphQlAdapter.VariablesKey]: { [GraphQlAdapter.IdVariable]: op.Key } });
            return true;
        }
        if (this.connection.upsertMutation === undefined) return false;
        const document = GraphQlAdapter.UpsertPrefix + this.connection.upsertMutation + GraphQlAdapter.UpsertArgs
            + batch.IdKey + GraphQlAdapter.UpsertSuffix;
        const input = { ...op.Fields, [batch.IdKey]: op.Key };
        await this.client.Send(RestHttpMethod.Post, this.connection.endpoint, this.connection.headers,
            { [GraphQlAdapter.QueryKey]: document, [GraphQlAdapter.VariablesKey]: { [GraphQlAdapter.InputVariable]: input } });
        return true;
    }

    private QueryDocument(fields: readonly string[]): string
    {
        return GraphQlAdapter.QueryPrefix + this.connection.queryField + GraphQlAdapter.SelectionOpen
            + fields.join(GraphQlAdapter.FieldSeparator) + GraphQlAdapter.SelectionClose + GraphQlAdapter.SelectionClose;
    }
}
