import { test } from "node:test";
import assert from "node:assert/strict";
import { PgSqlSession } from "../pg-sql-session.js";
import { Pool } from "pg";
import { ConnectionFailureKind } from "@pragmatic-tech-ai/todl";

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

class OtherCodeError extends Error
{
    public readonly code = "42501";
}

test("Query does not remap a different SQLSTATE even if the message looks like a missing relation", async () =>
{
    const session = new PgSqlSession(new ThrowingPool(new OtherCodeError('relation "Nope" does not exist')).AsPool());
    await assert.rejects(session.Query("select 1", []), /does not exist/);
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

/** Records every statement issued on the pinned client and whether it was released. pg-mem cannot
 *  honour a pinned-client ROLLBACK (verified), so the transaction mechanics are asserted against this
 *  recorder; the real rollback is covered by the gated live Postgres test below. */
class RecordingClient
{
    public readonly queries: string[] = [];
    public released = 0;

    public async query(sql: string, _params: readonly unknown[]): Promise<{ rows: unknown[]; rowCount: number | null }>
    {
        this.queries.push(sql);
        return { rows: [], rowCount: 1 };
    }

    public release(): void
    {
        this.released++;
    }
}

class RecordingPool
{
    public constructor(private readonly client: RecordingClient)
    {
    }

    public async connect(): Promise<RecordingClient>
    {
        return this.client;
    }

    public AsPool(): Pool
    {
        return this as unknown as Pool;
    }
}

const TxUpdateSql = "update t set x=1";

test("Transaction pins a client, wraps work in BEGIN/COMMIT, and releases it", async () =>
{
    const client = new RecordingClient();
    const session = new PgSqlSession(new RecordingPool(client).AsPool());
    const out = await session.Transaction(async (tx) =>
    {
        await tx.Execute(TxUpdateSql, []);
        return 42;
    });
    assert.equal(out, 42);
    assert.deepEqual(client.queries, ["BEGIN", TxUpdateSql, "COMMIT"]);
    assert.equal(client.released, 1);
});

test("Transaction issues ROLLBACK and rethrows when work throws, still releasing the client", async () =>
{
    const client = new RecordingClient();
    const session = new PgSqlSession(new RecordingPool(client).AsPool());
    const boom = new Error("boom");
    await assert.rejects(session.Transaction(async (tx) =>
    {
        await tx.Execute(TxUpdateSql, []);
        throw boom;
    }), /boom/);
    assert.deepEqual(client.queries, ["BEGIN", TxUpdateSql, "ROLLBACK"]);
    assert.equal(client.released, 1);
});

const ClassificationTable: readonly [string | undefined, ConnectionFailureKind][] =
[
    ["08000", ConnectionFailureKind.Transient],
    ["08003", ConnectionFailureKind.Transient],
    ["08006", ConnectionFailureKind.Transient],
    ["08001", ConnectionFailureKind.Transient],
    ["08004", ConnectionFailureKind.Transient],
    ["57P01", ConnectionFailureKind.Transient],
    ["57P02", ConnectionFailureKind.Transient],
    ["57P03", ConnectionFailureKind.Transient],
    ["28000", ConnectionFailureKind.Auth],
    ["28P01", ConnectionFailureKind.Auth],
    ["23505", ConnectionFailureKind.Permanent],
    ["42P01", ConnectionFailureKind.Permanent],
    [undefined, ConnectionFailureKind.Permanent],
];

for (const [code, kind] of ClassificationTable)
{
    test(`ClassifyFailure maps SQLSTATE ${code ?? "(none)"} to ${kind}`, () =>
    {
        const session = new PgSqlSession(new FakePool({ rows: [], rowCount: 0 }, () => { }).AsPool());
        assert.equal(session.ClassifyFailure(code === undefined ? new Error("x") : { code }), kind);
    });
}

test("ClassifyFailure is Permanent for non-object errors", () =>
{
    const session = new PgSqlSession(new FakePool({ rows: [], rowCount: 0 }, () => { }).AsPool());
    assert.equal(session.ClassifyFailure(null), ConnectionFailureKind.Permanent);
    assert.equal(session.ClassifyFailure("08000"), ConnectionFailureKind.Permanent);
});

// GATED LIVE: a real Postgres honours the pinned-client transaction -- COMMIT persists, ROLLBACK
// undoes. Registered only when CONNECTORS_LIVE_PG is set and non-empty.
const LiveEnvVar = "CONNECTORS_LIVE_PG";
if ((process.env[LiveEnvVar] ?? "") !== "")
{
    test("live: Transaction commits on success and rolls back on throw", { timeout: 60000 }, async () =>
    {
        const session = new PgSqlSession(new Pool({ connectionString: process.env[LiveEnvVar]! }));
        try
        {
            await session.Execute('DROP TABLE IF EXISTS "TxProbe"', []);
            await session.Execute('CREATE TABLE "TxProbe" (id text primary key, v text)', []);
            await session.Execute(`INSERT INTO "TxProbe" (id, v) VALUES ('a', '1')`, []);

            await session.Transaction(async (tx) => { await tx.Execute(`UPDATE "TxProbe" SET v = '2' WHERE id = 'a'`, []); });
            assert.equal((await session.Query(`SELECT v FROM "TxProbe" WHERE id = 'a'`, []))[0]!["v"], "2");

            await assert.rejects(session.Transaction(async (tx) =>
            {
                await tx.Execute(`UPDATE "TxProbe" SET v = '9' WHERE id = 'a'`, []);
                throw new Error("boom");
            }), /boom/);
            assert.equal((await session.Query(`SELECT v FROM "TxProbe" WHERE id = 'a'`, []))[0]!["v"], "2");
        }
        finally
        {
            await session.Dispose();
        }
    });
}
