import { test } from "node:test";
import assert from "node:assert/strict";
import { DataSourceKind } from "@pragmatic-tech-ai/todl";
import type { ResolvedConnection } from "@pragmatic-tech-ai/todl";
import { RestAdapterFactory } from "../rest-adapter-factory.js";
import { RestAdapter } from "../rest-adapter.js";
import { GraphQlAdapter } from "../graphql-adapter.js";

test("Kind is Rest", () =>
{
    assert.equal(new RestAdapterFactory().Kind, DataSourceKind.Rest);
});

test("plain REST config opens a RestAdapter", async () =>
{
    const conn: ResolvedConnection = { Kind: DataSourceKind.Rest, Config: { baseUrl: "https://api.example" } };
    assert.ok(await new RestAdapterFactory().Open(conn) instanceof RestAdapter);
});

test("style=graphql config opens a GraphQlAdapter", async () =>
{
    const conn: ResolvedConnection = { Kind: DataSourceKind.Rest,
        Config: { style: "graphql", endpoint: "https://api.example/graphql", source: "Customer", queryField: "customers" } };
    assert.ok(await new RestAdapterFactory().Open(conn) instanceof GraphQlAdapter);
});
