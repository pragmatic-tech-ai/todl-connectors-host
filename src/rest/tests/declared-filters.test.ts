import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { QueryCompareOp } from "@pragmatic-tech-ai/todl";
import type { QueryRequest } from "@pragmatic-tech-ai/todl";
import { DeclaredFilters } from "../declared-filters.js";
import { RestAdapter } from "../rest-adapter.js";
import { RestConnectionConfig } from "../rest-connection-config.js";
import { GraphQlAdapter, GraphQlConnectionConfig } from "../graphql-adapter.js";
import { RestHttpMethod } from "../rest-http-client.js";
import type { IRestHttpClient, RestPageResponse, RestResponse } from "../rest-http-client.js";

/** Records every URL / body and answers with fixed rows. */
class RecordingClient implements IRestHttpClient
{
    public readonly Urls: string[] = [];
    public readonly Bodies: Record<string, unknown>[] = [];

    constructor(private readonly rows: Record<string, unknown>[], private readonly paged = false)
    {
    }

    public async GetJson(url: string): Promise<unknown>
    {
        this.Urls.push(url);
        return this.rows;
    }

    public async GetPage(url: string): Promise<RestPageResponse>
    {
        this.Urls.push(url);
        return { Body: { items: this.rows }, Link: undefined } as RestPageResponse;
    }

    public async Send(_method: RestHttpMethod, _url: string, _headers: Record<string, string>, body?: unknown): Promise<RestResponse>
    {
        this.Bodies.push(body as Record<string, unknown>);
        return { Status: 200, Body: { data: { items: this.paged ? { nodes: this.rows, next: null } : this.rows } } };
    }
}

class FilterFixture
{
    public static readonly Rows = [{ id: "1", region: "eu", tier: "gold" }, { id: "2", region: "us", tier: "gold" }];

    public static Request(): QueryRequest
    {
        return { Source: "customers", Fields: ["id"], Where: { All: [
            { Field: "region", Op: QueryCompareOp.Eq, Value: "eu" },
            { Field: "tier", Op: QueryCompareOp.Neq, Value: "basic" },
        ] } };
    }
}

describe("DeclaredFilters", () =>
{
    test("parses REST and typed GraphQL declarations and rejects malformed ones", () =>
    {
        assert.equal(DeclaredFilters.Parse(undefined, false).IsEmpty, true);
        assert.equal(DeclaredFilters.Parse("region=region_eq, tier=level", false).Pick(FilterFixture.Request().Where).length, 1);
        assert.throws(() => DeclaredFilters.Parse("region", false));
        assert.throws(() => DeclaredFilters.Parse("region=r:String", false));
        assert.throws(() => DeclaredFilters.Parse("region=r", true));
        assert.throws(() => DeclaredFilters.Parse("region=r:Str ing", true));
        assert.equal(DeclaredFilters.Parse("region=r:String!", true).IsEmpty, false);
    });

    test("only non-null Eq terms on declared fields are picked", () =>
    {
        const filters = DeclaredFilters.Parse("region=r, tier=t", false);
        const picked = filters.Pick({ All: [
            { Field: "region", Op: QueryCompareOp.Eq, Value: null },
            { Field: "region", Op: QueryCompareOp.Eq, Value: "eu" },
            { Field: "tier", Op: QueryCompareOp.Gt, Value: "a" },
        ] });
        assert.deepEqual(picked.map(p => [p.Filter.Target, p.Value]), [["r", "eu"]]);
    });
});

describe("REST declared filters", () =>
{
    test("Eq terms on declared fields become query params; the full Where is still applied in memory", async () =>
    {
        const client = new RecordingClient(FilterFixture.Rows);
        const adapter = new RestAdapter(client, RestConnectionConfig.From({ baseUrl: "https://api.example/v1/", filterParams: "region=region" }));
        const records = await adapter.Query(FilterFixture.Request());
        assert.equal(client.Urls[0], "https://api.example/v1/customers?region=eu");
        assert.deepEqual(records, [{ id: "1" }]);
    });

    test("an undeclared connection sends no filter params", async () =>
    {
        const client = new RecordingClient(FilterFixture.Rows);
        await new RestAdapter(client, RestConnectionConfig.From({ baseUrl: "https://api.example/v1" })).Query(FilterFixture.Request());
        assert.equal(client.Urls[0], "https://api.example/v1/customers");
    });
});

describe("GraphQL declared filters", () =>
{
    const config = { endpoint: "https://gql.example/graphql", source: "customers", queryField: "items", filterArgs: "region=region:String" };

    test("Eq terms on declared fields become typed query-field arguments bound as variables", async () =>
    {
        const client = new RecordingClient(FilterFixture.Rows);
        const records = await new GraphQlAdapter(client, GraphQlConnectionConfig.From(config)).Query(FilterFixture.Request());
        assert.equal(client.Bodies[0]!["query"], "query($f0: String){ items(region: $f0){ id region tier } }");
        assert.deepEqual(client.Bodies[0]!["variables"], { f0: "eu" });
        assert.deepEqual(records, [{ id: "1" }]);
    });

    test("paged reads add the filter variables beside first/after", async () =>
    {
        const paged = { ...config, pageFirstArg: "first", pageAfterArg: "after", itemsPath: "items.nodes", nextTokenPath: "items.next" };
        const client = new RecordingClient(FilterFixture.Rows, true);
        await new GraphQlAdapter(client, GraphQlConnectionConfig.From(paged)).QueryPage(FilterFixture.Request(), { Limit: 2 });
        assert.equal(client.Bodies[0]!["query"], "query($f0: String, $first: Int, $after: String){ items(region: $f0, first: $first, after: $after){ nodes{ id region tier } next } }");
        assert.deepEqual(client.Bodies[0]!["variables"], { f0: "eu", first: 2 });
    });
});
