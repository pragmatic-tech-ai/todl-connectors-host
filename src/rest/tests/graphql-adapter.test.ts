import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { ConnectionFailureKind, QueryCompareOp, WriteAtomicity, WriteConcurrency, WriteFailureKind, WriteOperationKind } from "@pragmatic-tech-ai/todl";
import type { WriteBatch } from "@pragmatic-tech-ai/todl";
import { GraphQlAdapter, GraphQlConnectionConfig, GraphQlName } from "../graphql-adapter.js";
import { FetchFailureClassifier } from "../fetch-failure-classifier.js";
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
        return GraphQlAdapterFixture.Build(config).adapter;
    }

    /** Builds an adapter over a seeded fake, returning the fake too so a test can assert what was sent/inject errors. */
    public static Build(config: Record<string, string>, secret?: string): { adapter: GraphQlAdapter; client: FakeGraphQlHttpClient }
    {
        const cfg = GraphQlConnectionConfig.From(config, secret);
        const client = new FakeGraphQlHttpClient(cfg);
        client.Seed([{ id: "c1", label: "Acme" }]);
        return { adapter: new GraphQlAdapter(client, cfg), client };
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

test("a configured upsert whose response has an uncoded error is a secret-free Error failure", async () =>
{
    const cfg = GraphQlConnectionConfig.From(GraphQlAdapterFixture.ConfigFull(), "sekret");
    const adapter = new GraphQlAdapter(new ErrorClient(cfg), cfg);
    const result = await adapter.Apply(GraphQlAdapterFixture.LastWriteWins(
        [{ Kind: WriteOperationKind.Upsert, Key: "c1", Fields: { label: "x" } }]));
    assert.equal(result.Applied, 0);
    assert.equal(result.Failures.length, 1);
    assert.equal(result.Failures[0]!.Kind, WriteFailureKind.Error);
    assert.equal(result.Failures[0]!.Reason, "boom");
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

test("upsert emits the configured input type, arg and return selection", async () =>
{
    const { adapter, client } = GraphQlAdapterFixture.Build({ ...GraphQlAdapterFixture.ConfigFull(),
        upsertInputType: "CustomerInput", upsertInputArg: "data", upsertReturn: "id name" });
    const result = await adapter.Apply(GraphQlAdapterFixture.LastWriteWins(
        [{ Kind: WriteOperationKind.Upsert, Key: "c1", Fields: { label: "x" } }]));
    assert.equal(result.Applied, 1);
    assert.equal(client.Sent.at(-1)!.Query, "mutation($data: CustomerInput!){ upsertCustomer(data: $data){ id name } }");
    assert.deepEqual(client.Sent.at(-1)!.Variables, { data: { label: "x", id: "c1" } });
});

test("upsert defaults reproduce today's JSON! document", async () =>
{
    const { adapter, client } = GraphQlAdapterFixture.Build(GraphQlAdapterFixture.ConfigFull());
    await adapter.Apply(GraphQlAdapterFixture.LastWriteWins(
        [{ Kind: WriteOperationKind.Upsert, Key: "c1", Fields: { label: "x" } }]));
    assert.equal(client.Sent.at(-1)!.Query, "mutation($input: JSON!){ upsertCustomer(input: $input){ id } }");
    assert.deepEqual(client.Sent.at(-1)!.Variables, { input: { label: "x", id: "c1" } });
});

test("an empty or whitespace-only upsertReturn behaves exactly like the default", async () =>
{
    for (const empty of ["", "  , ,"])
    {
        const { adapter, client } = GraphQlAdapterFixture.Build({ ...GraphQlAdapterFixture.ConfigFull(), upsertReturn: empty });
        const result = await adapter.Apply(GraphQlAdapterFixture.LastWriteWins(
            [{ Kind: WriteOperationKind.Upsert, Key: "c1", Fields: { label: "x" } }]));
        assert.equal(result.Applied, 1, `applied for upsertReturn=${JSON.stringify(empty)}`);
        assert.equal(client.Sent.at(-1)!.Query, "mutation($input: JSON!){ upsertCustomer(input: $input){ id } }");
    }
    // Still validates the returned id against the written key (the fallback selects IdKey back).
    const mismatch = GraphQlAdapterFixture.Build({ ...GraphQlAdapterFixture.ConfigFull(), upsertReturn: "" });
    mismatch.client.Inject("c1", { ReturnId: "cZ" });
    const mismatchResult = await mismatch.adapter.Apply(GraphQlAdapterFixture.LastWriteWins(
        [{ Kind: WriteOperationKind.Upsert, Key: "c1", Fields: { label: "x" } }]));
    assert.equal(mismatchResult.Applied, 0);
    assert.equal(mismatchResult.Failures[0]!.Kind, WriteFailureKind.Error);
    assert.match(mismatchResult.Failures[0]!.Reason, /different id/);
});

test("delete emits the configured id type and arg", async () =>
{
    const { adapter, client } = GraphQlAdapterFixture.Build({ ...GraphQlAdapterFixture.ConfigFull(),
        deleteIdType: "String", deleteIdArg: "key" });
    const result = await adapter.Apply(GraphQlAdapterFixture.LastWriteWins(
        [{ Kind: WriteOperationKind.Delete, Key: "c1", Fields: {} }]));
    assert.equal(result.Applied, 1);
    assert.equal(client.Sent.at(-1)!.Query, "mutation($key: String!){ deleteCustomer(key: $key) }");
    assert.deepEqual(client.Sent.at(-1)!.Variables, { key: "c1" });
});

test("delete defaults reproduce today's ID! document", async () =>
{
    const { adapter, client } = GraphQlAdapterFixture.Build(GraphQlAdapterFixture.ConfigFull());
    await adapter.Apply(GraphQlAdapterFixture.LastWriteWins([{ Kind: WriteOperationKind.Delete, Key: "c1", Fields: {} }]));
    assert.equal(client.Sent.at(-1)!.Query, "mutation($id: ID!){ deleteCustomer(id: $id) }");
    assert.deepEqual(client.Sent.at(-1)!.Variables, { id: "c1" });
});

test("a returned id different from the written key is an Error failure", async () =>
{
    const { adapter, client } = GraphQlAdapterFixture.Build(GraphQlAdapterFixture.ConfigFull());
    client.Inject("c1", { ReturnId: "cZ" });
    const result = await adapter.Apply(GraphQlAdapterFixture.LastWriteWins(
        [{ Kind: WriteOperationKind.Upsert, Key: "c1", Fields: { label: "x" } }]));
    assert.equal(result.Applied, 0);
    assert.equal(result.Failures.length, 1);
    assert.equal(result.Failures[0]!.Kind, WriteFailureKind.Error);
    assert.match(result.Failures[0]!.Reason, /different id/);
});

test("a GraphQL error with a configured conflict code is a Conflict failure", async () =>
{
    const { adapter, client } = GraphQlAdapterFixture.Build({ ...GraphQlAdapterFixture.ConfigFull(), errorConflictCodes: "E_CONFLICT,E_DUP" });
    client.Inject("c1", { Errors: [{ Message: "duplicate key", Code: "E_DUP" }] });
    const result = await adapter.Apply(GraphQlAdapterFixture.LastWriteWins(
        [{ Kind: WriteOperationKind.Upsert, Key: "c1", Fields: { label: "x" } }]));
    assert.equal(result.Applied, 0);
    assert.equal(result.Failures[0]!.Kind, WriteFailureKind.Conflict);
    assert.equal(result.Failures[0]!.Reason, "duplicate key");
});

test("a GraphQL error with a configured unsupported code is an Unsupported failure", async () =>
{
    const { adapter, client } = GraphQlAdapterFixture.Build({ ...GraphQlAdapterFixture.ConfigFull(), errorUnsupportedCodes: "E_UNSUP" });
    client.Inject("c1", { Errors: [{ Message: "not allowed", Code: "E_UNSUP" }] });
    const result = await adapter.Apply(GraphQlAdapterFixture.LastWriteWins(
        [{ Kind: WriteOperationKind.Upsert, Key: "c1", Fields: { label: "x" } }]));
    assert.equal(result.Applied, 0);
    assert.equal(result.Failures[0]!.Kind, WriteFailureKind.Unsupported);
    assert.equal(result.Failures[0]!.Reason, "not allowed");
});

test("a GraphQL error with any other code is an Error failure", async () =>
{
    const { adapter, client } = GraphQlAdapterFixture.Build({ ...GraphQlAdapterFixture.ConfigFull(),
        errorConflictCodes: "E_CONFLICT", errorUnsupportedCodes: "E_UNSUP" });
    client.Inject("c1", { Errors: [{ Message: "boom", Code: "E_OTHER" }] });
    const result = await adapter.Apply(GraphQlAdapterFixture.LastWriteWins(
        [{ Kind: WriteOperationKind.Upsert, Key: "c1", Fields: { label: "x" } }]));
    assert.equal(result.Failures[0]!.Kind, WriteFailureKind.Error);
    assert.equal(result.Failures[0]!.Reason, "boom");
});

test("the error targeting the op by path is the one mapped", async () =>
{
    const { adapter, client } = GraphQlAdapterFixture.Build({ ...GraphQlAdapterFixture.ConfigFull(), errorConflictCodes: "E_CONFLICT" });
    client.Inject("c1", { Errors: [
        { Message: "unrelated", Code: "E_OTHER", Path: ["somethingElse"] },
        { Message: "mine", Code: "E_CONFLICT", Path: ["upsertCustomer"] }] });
    const result = await adapter.Apply(GraphQlAdapterFixture.LastWriteWins(
        [{ Kind: WriteOperationKind.Upsert, Key: "c1", Fields: { label: "x" } }]));
    assert.equal(result.Failures[0]!.Kind, WriteFailureKind.Conflict);
    assert.equal(result.Failures[0]!.Reason, "mine");
});

test("the failure reason carries only the GraphQL message, never variables/headers/extensions", async () =>
{
    const { adapter, client } = GraphQlAdapterFixture.Build(GraphQlAdapterFixture.ConfigFull(), "sekret");
    client.Inject("c1", { Errors: [{ Message: "Name is required", Code: "VALIDATION", Extensions: { internalToken: "topsecret123" } }] });
    const result = await adapter.Apply(GraphQlAdapterFixture.LastWriteWins(
        [{ Kind: WriteOperationKind.Upsert, Key: "c1", Fields: { label: "SensitiveValue" } }]));
    const reason = result.Failures[0]!.Reason;
    assert.equal(reason, "Name is required");
    assert.ok(!reason.includes("topsecret123"));
    assert.ok(!reason.includes("sekret"));
    assert.ok(!reason.includes("SensitiveValue"));
    assert.ok(!reason.includes("VALIDATION"));
});

test("data present together with errors is a failure, not Applied", async () =>
{
    const { adapter, client } = GraphQlAdapterFixture.Build({ ...GraphQlAdapterFixture.ConfigFull(), errorConflictCodes: "E_DUP" });
    client.Inject("c1", { Errors: [{ Message: "partial", Code: "E_DUP" }], WithData: true });
    const result = await adapter.Apply(GraphQlAdapterFixture.LastWriteWins(
        [{ Kind: WriteOperationKind.Upsert, Key: "c1", Fields: { label: "x" } }]));
    assert.equal(result.Applied, 0);
    assert.equal(result.Failures.length, 1);
    assert.equal(result.Failures[0]!.Kind, WriteFailureKind.Conflict);
});

test("a wrong batch.Source does not issue a write", async () =>
{
    const { adapter, client } = GraphQlAdapterFixture.Build(GraphQlAdapterFixture.ConfigFull());
    const result = await adapter.Apply({
        Source: "Other", IdKey: "id", Concurrency: WriteConcurrency.LastWriteWins, Atomicity: WriteAtomicity.Sequential,
        Operations: [{ Kind: WriteOperationKind.Upsert, Key: "c1", Fields: { label: "x" } }],
    });
    assert.equal(result.Applied, 0);
    assert.equal(result.Failures.length, 1);
    assert.equal(result.Failures[0]!.Kind, WriteFailureKind.Error);
    assert.equal(client.Sent.length, 0);
});

test("an invalid configured identifier is rejected at construction", () =>
{
    assert.throws(() => GraphQlConnectionConfig.From({ ...GraphQlAdapterFixture.ConfigFull(), upsertInputType: "Bad Type" }), /not a valid identifier/);
    assert.throws(() => GraphQlConnectionConfig.From({ ...GraphQlAdapterFixture.ConfigFull(), upsertInputArg: "in put" }), /not a valid identifier/);
    assert.throws(() => GraphQlConnectionConfig.From({ ...GraphQlAdapterFixture.ConfigFull(), upsertReturn: "id bad}" }), /not a valid identifier/);
    assert.throws(() => GraphQlConnectionConfig.From({ ...GraphQlAdapterFixture.ConfigFull(), deleteIdType: "ID!" }), /not a valid identifier/);
    assert.throws(() => GraphQlConnectionConfig.From({ ...GraphQlAdapterFixture.ConfigFull(), deleteIdArg: "1bad" }), /not a valid identifier/);
});

test("GraphQlAdapter.ClassifyFailure delegates to the fetch classifier", () =>
{
    const adapter = new GraphQlAdapter({ GetJson: async () => [], Send: async () => ({ Status: 200, Body: undefined }) }, GraphQlConnectionConfig.From(GraphQlAdapterFixture.ConfigFull()));
    assert.equal(adapter.ClassifyFailure({ status: 503 }), ConnectionFailureKind.Transient);
    assert.equal(adapter.ClassifyFailure(new TypeError("fetch failed")), ConnectionFailureKind.Transient);
    assert.equal(adapter.ClassifyFailure({ status: 401 }), ConnectionFailureKind.Auth);
    assert.equal(adapter.ClassifyFailure({ status: 404 }), ConnectionFailureKind.Permanent);
});

test("a 200 carrying GraphQL errors is a normal write failure and is never routed through the classifier", async () =>
{
    const classify = mock.method(FetchFailureClassifier, "Classify");
    try
    {
        const connection = GraphQlConnectionConfig.From(GraphQlAdapterFixture.ConfigFull());
        const adapter = new GraphQlAdapter(new ErrorClient(connection), connection);
        const result = await adapter.Apply(GraphQlAdapterFixture.LastWriteWins(
            [{ Kind: WriteOperationKind.Upsert, Key: "c1", Fields: { label: "x" } }]));
        assert.equal(result.Applied, 0);
        assert.equal(result.Failures[0]!.Kind, WriteFailureKind.Error);
        assert.equal(classify.mock.callCount(), 0);
    }
    finally
    {
        classify.mock.restore();
    }
});
