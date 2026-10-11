import { RestHttpMethod } from "../rest/rest-http-client.js";
import type { IRestHttpClient, RestResponse } from "../rest/rest-http-client.js";
import type { GraphQlConnection } from "../rest/graphql-adapter.js";

/** In-memory GraphQL backend: recognizes the configured query/mutation names in the document. */
export class FakeGraphQlHttpClient implements IRestHttpClient
{
    private static readonly OkStatus = 200;
    private static readonly IdKey = "id";
    private static readonly InputKey = "input";
    private static readonly DataKey = "data";
    private readonly store = new Map<string, Record<string, unknown>>();

    public constructor(private readonly connection: GraphQlConnection)
    {
    }

    public Seed(records: Record<string, unknown>[]): this
    {
        for (const r of records) this.store.set(String(r[FakeGraphQlHttpClient.IdKey]), { ...r });
        return this;
    }

    public async GetJson(): Promise<unknown>
    {
        return undefined; // GraphQL goes through Send(POST)
    }

    public async Send(_method: RestHttpMethod, _url: string, _headers: Record<string, string>, body?: unknown): Promise<RestResponse>
    {
        const doc = body as { query?: string; variables?: Record<string, unknown> } | undefined;
        const query = doc?.query ?? "";
        const vars = doc?.variables ?? {};
        if (this.connection.upsertMutation !== undefined && query.includes(this.connection.upsertMutation))
        {
            const input = vars[FakeGraphQlHttpClient.InputKey] as Record<string, unknown>;
            this.store.set(String(input[FakeGraphQlHttpClient.IdKey]), { ...input });
            return this.Ok({ [this.connection.upsertMutation]: input });
        }
        if (this.connection.deleteMutation !== undefined && query.includes(this.connection.deleteMutation))
        {
            this.store.delete(String(vars[FakeGraphQlHttpClient.IdKey]));
            return this.Ok({ [this.connection.deleteMutation]: true });
        }
        return this.Ok({ [this.connection.queryField]: [...this.store.values()] });
    }

    private Ok(data: Record<string, unknown>): RestResponse
    {
        return { Status: FakeGraphQlHttpClient.OkStatus, Body: { [FakeGraphQlHttpClient.DataKey]: data } };
    }
}
