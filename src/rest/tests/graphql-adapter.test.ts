import { test } from "node:test";
import assert from "node:assert/strict";
import { WriteOperationKind } from "@pragmatic-tech-ai/todl";
import { GraphQlAdapter, GraphQlConnectionConfig } from "../graphql-adapter.js";
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
    assert.equal(result.Conflicts.length, 1);
    assert.match(result.Conflicts[0]!.Reason, /not configured/);
});
