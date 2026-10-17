import { test } from "node:test";
import assert from "node:assert/strict";
import { QueryCompareOp, WriteOperationKind } from "@pragmatic-tech-ai/todl";
import { GraphQlAdapter, GraphQlConnectionConfig, GraphQlName } from "../graphql-adapter.js";
import type { RestResponse } from "../rest-http-client.js";
import { FakeGraphQlHttpClient } from "../../testing/fake-graphql-http-client.js";
import { describeDataSourceAdapter } from "../../testing/adapter-conformance.js";

const Endpoint = "https://api.example/graphql";
const Customer = "Customer";

class GraphQlAdapterFixture
{
    public static ConfigFull(): Record<string, string>
    {
        return { style: "graphql", endpoint: Endpoint, source: Customer, queryField: "customers",
            upsertMutation: "upsertCustomer", deleteMutation: "deleteCustomer" };
    }

    public static ConfigReadOnly(): Record<string, string>
    {
        return { style: "graphql", endpoint: Endpoint, source: Customer, queryField: "customers" };
    }

    public static Make(config: Record<string, string>): GraphQlAdapter
    {
        const cfg = GraphQlConnectionConfig.From(config);
        const client = new FakeGraphQlHttpClient(cfg);
        client.Seed([{ id: "c1", label: "Acme" }]);
        return new GraphQlAdapter(client, cfg);
    }
}

class ErrorClient extends FakeGraphQlHttpClient
{
    public override async Send(): Promise<RestResponse>
    {
        return { Status: 200, Body: { data: null, errors: [{ message: "boom" }] } };
    }
}

describeDataSourceAdapter("GraphQlAdapter (fake client)", () => GraphQlAdapterFixture.Make(GraphQlAdapterFixture.ConfigFull()));

test("querying a source other than the configured one yields no records", async () =>
{
    const rows = await GraphQlAdapterFixture.Make(GraphQlAdapterFixture.ConfigFull()).Query({ Source: "Nope", Fields: ["id"] });
    assert.deepEqual(rows, []);
});

test("writes with no configured mutation become conflicts, never throw", async () =>
{
    const adapter = GraphQlAdapterFixture.Make(GraphQlAdapterFixture.ConfigReadOnly());
    const result = await adapter.Apply({ Source: Customer, IdKey: "id",
        Operations: [{ Kind: WriteOperationKind.Upsert, Key: "c9", Fields: { label: "z" } }] });
    assert.equal(result.Applied, 0);
    assert.equal(result.Failures.length, 1);
    assert.match(result.Failures[0]!.Reason, /not configured/);
});

test("a configured upsert whose response has errors throws a secret-free error", async () =>
{
    const cfg = GraphQlConnectionConfig.From(GraphQlAdapterFixture.ConfigFull(), "sekret");
    const adapter = new GraphQlAdapter(new ErrorClient(cfg), cfg);
    await assert.rejects(
        adapter.Apply({ Source: Customer, IdKey: "id", Operations: [{ Kind: WriteOperationKind.Upsert, Key: "c1", Fields: { label: "x" } }] }),
        (e: Error) => /graphql request failed/.test(e.message) && !/sekret/.test(e.message));
});

test("a query whose response has errors throws", async () =>
{
    const cfg = GraphQlConnectionConfig.From(GraphQlAdapterFixture.ConfigFull());
    const adapter = new GraphQlAdapter(new ErrorClient(cfg), cfg);
    await assert.rejects(adapter.Query({ Source: Customer, Fields: ["id"] }), /graphql request failed/);
});

test("invalid names are rejected, valid ones pass", async () =>
{
    assert.equal(GraphQlName.Validate("label_1"), "label_1");
    const adapter = GraphQlAdapterFixture.Make(GraphQlAdapterFixture.ConfigFull());
    await assert.rejects(adapter.Query({ Source: Customer, Fields: ["id }"] }), /not a valid identifier/);
    await assert.rejects(
        adapter.Apply({ Source: Customer, IdKey: "id}", Operations: [{ Kind: WriteOperationKind.Upsert, Key: "c1", Fields: {} }] }),
        /not a valid identifier/);
});

test("Where on an unprojected field still filters, projection stays narrow", async () =>
{
    const cfg = GraphQlConnectionConfig.From(GraphQlAdapterFixture.ConfigFull());
    const client = new FakeGraphQlHttpClient(cfg);
    client.Seed([{ id: "c1", tier: "gold" }, { id: "c2", tier: "basic" }]);
    const rows = await new GraphQlAdapter(client, cfg).Query(
        { Source: Customer, Fields: ["id"], Where: { All: [{ Field: "tier", Op: QueryCompareOp.Eq, Value: "gold" }] } });
    assert.deepEqual(rows, [{ id: "c1" }]);
});
