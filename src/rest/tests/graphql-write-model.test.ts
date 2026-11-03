import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { WriteAtomicity, WriteConcurrency, WriteFailureKind, WriteOperationKind } from "@pragmatic-tech-ai/todl";
import type { WriteBatch } from "@pragmatic-tech-ai/todl";
import { GraphQlAdapter, GraphQlConnectionConfig } from "../graphql-adapter.js";
import { RestHttpMethod } from "../rest-http-client.js";
import type { IRestHttpClient, RestResponse } from "../rest-http-client.js";

/** Records each mutation and answers with the written id, or a GraphQL error carrying `code`. */
class MutationClient implements IRestHttpClient
{
    public readonly Bodies: { query: string; variables: Record<string, unknown> }[] = [];
    public ErrorCode: string | undefined;

    public async GetJson(): Promise<unknown>
    {
        return [];
    }

    public async Send(_method: RestHttpMethod, _url: string, _headers: Record<string, string>, body?: unknown): Promise<RestResponse>
    {
        const sent = body as { query: string; variables: Record<string, unknown> };
        this.Bodies.push(sent);
        if (this.ErrorCode !== undefined) return { Status: 200, Body: { errors: [{ message: "stale", extensions: { code: this.ErrorCode } }] } };
        const id = sent.variables["key"] ?? (sent.variables["input"] as Record<string, unknown> | undefined)?.["id"] ?? sent.variables["id"];
        return { Status: 200, Body: { data: { upsertCustomer: { id }, deleteCustomer: true } } };
    }
}

class WriteModelFixture
{
    public static readonly Base = { endpoint: "https://gql.example/graphql", source: "Customer", queryField: "customers", upsertMutation: "upsertCustomer", deleteMutation: "deleteCustomer", errorConflictCodes: "STALE_VERSION" };
    public static readonly Versioned = { ...WriteModelFixture.Base, versionArg: "expectedVersion", versionArgType: "Int!" };

    public static Adapter(config: Record<string, string>): { adapter: GraphQlAdapter; client: MutationClient }
    {
        const client = new MutationClient();
        return { adapter: new GraphQlAdapter(client, GraphQlConnectionConfig.From(config)), client };
    }

    public static Batch(ops: WriteBatch["Operations"], concurrency: WriteConcurrency): WriteBatch
    {
        return { Source: "Customer", IdKey: "id", Operations: ops, Concurrency: concurrency, Atomicity: WriteAtomicity.Sequential, VersionField: "ver" };
    }
}

describe("GraphQL optimistic versioning", () =>
{
    test("without a declared version argument the adapter cannot version and refuses optimistic batches", async () =>
    {
        const { adapter } = WriteModelFixture.Adapter(WriteModelFixture.Base);
        assert.equal(adapter.CanVersion, false);
        const result = await adapter.Apply(WriteModelFixture.Batch([{ Kind: WriteOperationKind.Upsert, Key: "c1", Fields: { label: "x" }, Version: 1 }], WriteConcurrency.Optimistic));
        assert.equal(result.Failures[0]!.Kind, WriteFailureKind.Unsupported);
    });

    test("a declared version argument carries the expected version on upsert and delete", async () =>
    {
        const { adapter, client } = WriteModelFixture.Adapter(WriteModelFixture.Versioned);
        assert.equal(adapter.CanVersion, true);
        const result = await adapter.Apply(WriteModelFixture.Batch([
            { Kind: WriteOperationKind.Upsert, Key: "c1", Fields: { label: "x" }, Version: 4 },
            { Kind: WriteOperationKind.Delete, Key: "c2", Fields: {}, Version: 9 },
        ], WriteConcurrency.Optimistic));
        assert.deepEqual([result.Applied, result.Failures], [2, []]);
        assert.equal(client.Bodies[0]!.query, "mutation($input: JSON!, $version: Int!){ upsertCustomer(input: $input, expectedVersion: $version){ id } }");
        assert.deepEqual(client.Bodies[0]!.variables, { input: { label: "x", id: "c1" }, version: 4 });
        assert.equal(client.Bodies[1]!.query, "mutation($id: ID!, $version: Int!){ deleteCustomer(id: $id, expectedVersion: $version) }");
        assert.deepEqual(client.Bodies[1]!.variables, { id: "c2", version: 9 });
    });

    test("a server-reported stale version maps to Conflict; last-write-wins sends no version", async () =>
    {
        const { adapter, client } = WriteModelFixture.Adapter(WriteModelFixture.Versioned);
        client.ErrorCode = "STALE_VERSION";
        const stale = await adapter.Apply(WriteModelFixture.Batch([{ Kind: WriteOperationKind.Upsert, Key: "c1", Fields: {}, Version: 1 }], WriteConcurrency.Optimistic));
        assert.equal(stale.Failures[0]!.Kind, WriteFailureKind.Conflict);
        client.ErrorCode = undefined;
        await adapter.Apply(WriteModelFixture.Batch([{ Kind: WriteOperationKind.Upsert, Key: "c1", Fields: { label: "y" } }], WriteConcurrency.LastWriteWins));
        assert.equal(client.Bodies[1]!.query, "mutation($input: JSON!){ upsertCustomer(input: $input){ id } }");
    });

    test("versionArg and versionArgType must come together, with a valid type", () =>
    {
        assert.throws(() => GraphQlConnectionConfig.From({ ...WriteModelFixture.Base, versionArg: "v" }), /together/);
        assert.throws(() => GraphQlConnectionConfig.From({ ...WriteModelFixture.Base, versionArg: "v", versionArgType: "In t" }), /valid GraphQL type/);
    });
});

describe("GraphQL schema-aware upsert (upsertArgs)", () =>
{
    const typed = { ...WriteModelFixture.Versioned, upsertArgs: "label=name:String, tier=tier:Tier", upsertKeyArg: "customerId:ID!" };

    test("each field travels as its own typed argument, the key as the declared key argument", async () =>
    {
        const { adapter, client } = WriteModelFixture.Adapter(typed);
        const result = await adapter.Apply(WriteModelFixture.Batch([{ Kind: WriteOperationKind.Upsert, Key: "c1", Fields: { label: "Ada", tier: "GOLD", ver: 5 }, Version: 4 }], WriteConcurrency.Optimistic));
        assert.deepEqual(result.Failures, []);
        assert.equal(client.Bodies[0]!.query, "mutation($key: ID!, $a0: String, $a1: Tier, $version: Int!){ upsertCustomer(customerId: $key, name: $a0, tier: $a1, expectedVersion: $version){ id } }");
        assert.deepEqual(client.Bodies[0]!.variables, { key: "c1", a0: "Ada", a1: "GOLD", version: 4 }, "the undeclared version column is left to the server");
    });

    test("a field with no declared argument is Unsupported for that op and nothing is sent for it", async () =>
    {
        const { adapter, client } = WriteModelFixture.Adapter(typed);
        const result = await adapter.Apply(WriteModelFixture.Batch([{ Kind: WriteOperationKind.Upsert, Key: "c1", Fields: { secret: "x" } }], WriteConcurrency.LastWriteWins));
        assert.equal(result.Failures[0]!.Kind, WriteFailureKind.Unsupported);
        assert.match(result.Failures[0]!.Reason, /secret/);
        assert.equal(client.Bodies.length, 0);
    });

    test("the key argument defaults to id:ID!", async () =>
    {
        const { adapter, client } = WriteModelFixture.Adapter({ ...WriteModelFixture.Base, upsertArgs: "label=name:String" });
        await adapter.Apply(WriteModelFixture.Batch([{ Kind: WriteOperationKind.Upsert, Key: "c1", Fields: { label: "Ada" } }], WriteConcurrency.LastWriteWins));
        assert.equal(client.Bodies[0]!.query, "mutation($key: ID!, $a0: String){ upsertCustomer(id: $key, name: $a0){ id } }");
    });
});
