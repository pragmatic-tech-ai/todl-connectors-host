import { test } from "node:test";
import assert from "node:assert/strict";
import { DataSourceKind } from "@pragmatic-tech-ai/todl";
import type { ResolvedConnection } from "@pragmatic-tech-ai/todl";
import type { Pool } from "pg";
import { SqlAdapterFactory } from "../sql-adapter-factory.js";
import type { PgPoolOptions } from "../sql-connection-config.js";

test("Kind is Sql", () =>
{
    assert.equal(new SqlAdapterFactory().Kind, DataSourceKind.Sql);
});

test("Open builds a pool from the resolved config+secret and returns a working SqlAdapter", async () =>
{
    let seen: PgPoolOptions | undefined;
    const factory = new SqlAdapterFactory((opts) => {
        seen = opts;
        return { query: async () => ({ rows: [{ id: "c1" }], rowCount: 1 }), end: async () => {} } as unknown as Pool;
    });
    const conn: ResolvedConnection = { Kind: DataSourceKind.Sql, Config: { database: "app", host: "h" }, Secret: "pw" };
    const adapter = await factory.Open(conn);
    assert.equal(seen?.database, "app");
    assert.equal(seen?.password, "pw");
    const rows = await adapter.Query({ Source: "Customer", Fields: ["id"] });
    assert.deepEqual(rows, [{ id: "c1" }]);
    await adapter.Dispose();
});
