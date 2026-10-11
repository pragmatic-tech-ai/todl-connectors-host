import { test } from "node:test";
import assert from "node:assert/strict";
import { PgSqlSession } from "../pg-sql-session.js";
import type { Pool } from "pg";

class FakePool
{
    public readonly calls: { sql: string; params: readonly unknown[] }[] = [];

    public constructor(private readonly result: { rows: unknown[]; rowCount: number | null }, private readonly onEnd: () => void)
    {
    }

    public async query(sql: string, params: readonly unknown[])
    {
        this.calls.push({ sql, params });
        return this.result;
    }

    public async end(): Promise<void>
    {
        this.onEnd();
    }

    public AsPool(): Pool
    {
        return this as unknown as Pool;
    }
}

test("Query returns the driver rows", async () =>
{
    const pool = new FakePool({ rows: [{ id: "c1" }], rowCount: 1 }, () => {});
    const rows = await new PgSqlSession(pool.AsPool()).Query("select 1", []);
    assert.deepEqual(rows, [{ id: "c1" }]);
});

test("Execute returns the affected-row count, defaulting null to 0", async () =>
{
    const session = new PgSqlSession(new FakePool({ rows: [], rowCount: null }, () => {}).AsPool());
    assert.equal(await session.Execute("delete from t", []), 0);
    const session2 = new PgSqlSession(new FakePool({ rows: [], rowCount: 3 }, () => {}).AsPool());
    assert.equal(await session2.Execute("update t set x=1", []), 3);
});

test("Dispose ends the pool", async () =>
{
    let ended = 0;
    await new PgSqlSession(new FakePool({ rows: [], rowCount: 0 }, () => { ended++; }).AsPool()).Dispose();
    assert.equal(ended, 1);
});
