import { test } from "node:test";
import assert from "node:assert/strict";
import { QueryCompareOp, WriteAtomicity, WriteConcurrency, WriteFailureKind, WriteOperationKind } from "@pragmatic-tech-ai/todl";
import type { WriteBatch } from "@pragmatic-tech-ai/todl";
import { GraphQlAdapter, GraphQlConnectionConfig, GraphQlName } from "../graphql-adapter.js";
import { RestHttpMethod } from "../rest-http-client.js";
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

    public static LastWriteWins(ops: WriteBatch["Operations"]): WriteBatch
    {
        return { Source: Customer, IdKey: "id", Concurrency: WriteConcurrency.LastWriteWins, Atomicity: WriteAtomicity.Sequential, Operations: ops };
    }
}

class ErrorClient extends FakeGraphQlHttpClient
{
    public override async Send(): Promise<RestResponse>
    {
        return { Status: 200, Body: { data: null, errors: [{ message: "boom" }] } };
    }
}

/** Throws a transport fault on any mutation whose input/variables carry the given key; others succeed. */
class ThrowingGraphQlClient extends FakeGraphQlHttpClient
{
    public constructor(connection: ConstructorParameters<typeof FakeGraphQlHttpClient>[0], private readonly throwKey: string)
    {
        super(connection);
    }

    public override async Send(method: RestHttpMethod, url: string, headers: Record<string, string>, body?: unknown): Promise<RestResponse>
    {
        const vars = (body as { variables?: Record<string, unknown> } | undefined)?.variables ?? {};
        const input = vars["input"] as Record<string, unknown> | undefined;
        if (input?.["id"] === this.throwKey) throw new Error("transport exploded");
        return super.Send(method, url, headers, body);
    }
}

describeDataSourceAdapter("GraphQlAdapter (fake client)", () => GraphQlAdapterFixture.Make(GraphQlAdapterFixture.ConfigFull()));

test("GraphQL advertises neither CanVersion nor CanTransact", () =>
{
    const adapter = GraphQlAdapterFixture.Make(GraphQlAdapterFixture.ConfigFull());
    assert.equal(adapter.CanVersion, false);
    assert.equal(adapter.CanTransact, false);
});

test("querying a source other than the configured one yields no records", async () =>
{
    const rows = await GraphQlAdapterFixture.Make(GraphQlAdapterFixture.ConfigFull()).Query({ Source: "Nope", Fields: ["id"] });
    assert.deepEqual(rows, []);
});

test("a Transactional batch is wholly Unsupported on GraphQL, nothing applied", async () =>
{
    const adapter = GraphQlAdapterFixture.Make(GraphQlAdapterFixture.ConfigFull());
    const result = await adapter.Apply({
        Source: Customer, IdKey: "id", Concurrency: WriteConcurrency.LastWriteWins, Atomicity: WriteAtomicity.Transactional,
        Operations: [
            { Kind: WriteOperationKind.Upsert, Key: "c1", Fields: { label: "x" } },
            { Kind: WriteOperationKind.Upsert, Key: "c2", Fields: { label: "y" } },
        ],
    });
    assert.equal(result.Applied, 0);
    assert.equal(result.Failures.length, 2);
    assert.ok(result.Failures.every(f => f.Kind === WriteFailureKind.Unsupported));
});

test("an Optimistic batch is wholly Unsupported on GraphQL at apply (it cannot version)", async () =>
{
    const adapter = GraphQlAdapterFixture.Make(GraphQlAdapterFixture.ConfigFull());
    const result = await adapter.Apply({
        Source: Customer, IdKey: "id", Concurrency: WriteConcurrency.Optimistic, Atomicity: WriteAtomicity.Sequential, VersionField: "rev",
        Operations: [{ Kind: WriteOperationKind.Upsert, Key: "c1", Fields: { label: "x" }, Version: "v1" }],
    });
    assert.equal(result.Applied, 0);
    assert.equal(result.Failures.length, 1);
    assert.equal(result.Failures[0]!.Kind, WriteFailureKind.Unsupported);
});

test("LastWriteWins is resilient: one op errors, the others still apply", async () =>
{
    const cfg = GraphQlConnectionConfig.From(GraphQlAdapterFixture.ConfigFull());
    const client = new ThrowingGraphQlClient(cfg, "c1");
    client.Seed([{ id: "c1", label: "Acme" }]);
    const adapter = new GraphQlAdapter(client, cfg);
    const result = await adapter.Apply(GraphQlAdapterFixture.LastWriteWins([
        { Kind: WriteOperationKind.Upsert, Key: "c1", Fields: { label: "x" } },
        { Kind: WriteOperationKind.Upsert, Key: "c2", Fields: { label: "y" } },
    ]));
    assert.equal(result.Applied, 1);
    assert.equal(result.Failures.length, 1);
    assert.equal(result.Failures[0]!.Key, "c1");
    assert.equal(result.Failures[0]!.Kind, WriteFailureKind.Error);
});

test("writes with no configured mutation are Unsupported, never throw", async () =>
{
    const adapter = GraphQlAdapterFixture.Make(GraphQlAdapterFixture.ConfigReadOnly());
    const result = await adapter.Apply(GraphQlAdapterFixture.LastWriteWins(
        [{ Kind: WriteOperationKind.Upsert, Key: "c9", Fields: { label: "z" } }]));
    assert.equal(result.Applied, 0);
    assert.equal(result.Failures.length, 1);
    assert.equal(result.Failures[0]!.Kind, WriteFailureKind.Unsupported);
    assert.match(result.Failures[0]!.Reason, /not configured/);
});

test("a configured upsert whose response has errors is a secret-free Error failure", async () =>
{
    const cfg = GraphQlConnectionConfig.From(GraphQlAdapterFixture.ConfigFull(), "sekret");
    const adapter = new GraphQlAdapter(new ErrorClient(cfg), cfg);
    const result = await adapter.Apply(GraphQlAdapterFixture.LastWriteWins(
        [{ Kind: WriteOperationKind.Upsert, Key: "c1", Fields: { label: "x" } }]));
    assert.equal(result.Applied, 0);
    assert.equal(result.Failures.length, 1);
    assert.equal(result.Failures[0]!.Kind, WriteFailureKind.Error);
    assert.match(result.Failures[0]!.Reason, /graphql request failed/);
    assert.ok(!result.Failures[0]!.Reason.includes("sekret"));
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
        adapter.Apply({ Source: Customer, IdKey: "id}", Concurrency: WriteConcurrency.LastWriteWins, Atomicity: WriteAtomicity.Sequential,
            Operations: [{ Kind: WriteOperationKind.Upsert, Key: "c1", Fields: {} }] }),
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
