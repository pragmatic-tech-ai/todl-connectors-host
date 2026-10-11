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

    public async query(sql: string, params: readonly unknown[]): Promise<{ rows: unknown[]; rowCount: number | null }>
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

class ThrowingPool
{
    public constructor(private readonly error: Error)
    {
    }

    public async query(): Promise<never>
    {
        throw this.error;
    }

    public AsPool(): Pool
    {
        return this as unknown as Pool;
    }
}

class UndefinedTableError extends Error
{
    public readonly code = "42P01";
}

test("Query returns [] when the pool throws an undefined-table error", async () =>
{
    const session = new PgSqlSession(new ThrowingPool(new UndefinedTableError('relation "Nope" does not exist')).AsPool());
    assert.deepEqual(await session.Query('select "id" from "Nope"', []), []);
});

test("Query returns [] for a pg-mem style code-less missing-relation error", async () =>
{
    const session = new PgSqlSession(new ThrowingPool(new Error('relation "Nope" does not exist')).AsPool());
    assert.deepEqual(await session.Query("select 1", []), []);
});

test("Query still propagates any other error", async () =>
{
    const session = new PgSqlSession(new ThrowingPool(new Error("connection refused")).AsPool());
    await assert.rejects(session.Query("select 1", []), /connection refused/);
});

test("Execute stays strict on an undefined-table error", async () =>
{
    const session = new PgSqlSession(new ThrowingPool(new UndefinedTableError('relation "Nope" does not exist')).AsPool());
    await assert.rejects(session.Execute("delete from \"Nope\"", []), /does not exist/);
});

test("Query returns the driver rows", async () =>
{
    const pool = new FakePool({ rows: [{ id: "c1" }], rowCount: 1 }, () => {});
    const rows = await new PgSqlSession(pool.AsPool()).Query("select 1", []);
    assert.deepEqual(rows, [{ id: "c1" }]);
});

test("Execute defaults a null rowCount to 0", async () =>
{
    const session = new PgSqlSession(new FakePool({ rows: [], rowCount: null }, () => {}).AsPool());
    assert.equal(await session.Execute("delete from t", []), 0);
});

test("Execute returns the affected-row count", async () =>
{
    const session = new PgSqlSession(new FakePool({ rows: [], rowCount: 3 }, () => {}).AsPool());
    assert.equal(await session.Execute("update t set x=1", []), 3);
});

test("Dispose ends the pool", async () =>
{
    let ended = 0;
    await new PgSqlSession(new FakePool({ rows: [], rowCount: 0 }, () => { ended++; }).AsPool()).Dispose();
    assert.equal(ended, 1);
});
