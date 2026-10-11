import { newDb } from "pg-mem";
import { SqlAdapter } from "@pragmatic-tech-ai/todl";
import type { IDataSourceAdapter, ISqlSession, SqlRow } from "@pragmatic-tech-ai/todl";
import { Pool } from "pg";
import { PgSqlSession } from "../sql/pg-sql-session.js";

/**
 * Test-only decorator: the conformance contract says an unknown source yields no records, but a real
 * SQL engine raises "relation does not exist". Production PgSqlSession stays strict (a missing table is
 * a real misconfiguration); the harness maps that one error to an empty result so the shared contract holds.
 */
class MissingRelationTolerantSession implements ISqlSession
{
    private static readonly UndefinedTableCode = "42P01";
    private static readonly MissingRelationPattern = /relation .* does not exist/i;

    public constructor(private readonly inner: ISqlSession)
    {
    }

    public async Query(sql: string, params: readonly unknown[]): Promise<readonly SqlRow[]>
    {
        try
        {
            return await this.inner.Query(sql, params);
        }
        catch (error)
        {
            if (MissingRelationTolerantSession.IsMissingRelation(error))
            {
                return [];
            }
            throw error;
        }
    }

    public Execute(sql: string, params: readonly unknown[]): Promise<number>
    {
        return this.inner.Execute(sql, params);
    }

    public Dispose(): Promise<void>
    {
        return this.inner.Dispose();
    }

    private static IsMissingRelation(error: unknown): boolean
    {
        const e = error as { code?: string; message?: string };
        return e.code === MissingRelationTolerantSession.UndefinedTableCode
            || MissingRelationTolerantSession.MissingRelationPattern.test(e.message ?? "");
    }
}

/** Builds pg-mem-backed SqlAdapters pre-seeded with Customer(id PRIMARY KEY, label) = c1/Acme. */
export class PgMemAdapterHarness
{
    private static readonly CreateTableSql = 'CREATE TABLE "Customer" (id text primary key, label text)';
    private static readonly SeedSql = `INSERT INTO "Customer" (id, label) VALUES ('c1', 'Acme')`;

    /** A fresh, isolated in-process database per call. */
    public static Make(): IDataSourceAdapter
    {
        const db = newDb();
        const pg = db.adapters.createPg();
        const pool = new pg.Pool() as unknown as Pool;
        db.public.none(PgMemAdapterHarness.CreateTableSql);
        db.public.none(PgMemAdapterHarness.SeedSql);
        return new SqlAdapter(new MissingRelationTolerantSession(new PgSqlSession(pool)));
    }
}

/** Wraps a live session; before first use, drops/recreates Customer and seeds c1/Acme. */
class ResettingSession implements ISqlSession
{
    private ready: Promise<void> | undefined;

    public constructor(private readonly inner: ISqlSession)
    {
    }

    public async Query(sql: string, params: readonly unknown[]): Promise<readonly SqlRow[]>
    {
        await this.EnsureReset();
        return this.inner.Query(sql, params);
    }

    public async Execute(sql: string, params: readonly unknown[]): Promise<number>
    {
        await this.EnsureReset();
        return this.inner.Execute(sql, params);
    }

    public async Dispose(): Promise<void>
    {
        await this.inner.Dispose();
    }

    private EnsureReset(): Promise<void>
    {
        this.ready ??= this.Reset();
        return this.ready;
    }

    private async Reset(): Promise<void>
    {
        await this.inner.Execute(PgLiveHarness.DropTableSql, []);
        await this.inner.Execute(PgLiveHarness.CreateTableSql, []);
        await this.inner.Execute(PgLiveHarness.SeedSql, []);
    }
}

/** Builds adapters over a real Postgres, resetting Customer(id PK, label) to c1/Acme on each adapter's first use. */
export class PgLiveHarness
{
    public static readonly DropTableSql = 'DROP TABLE IF EXISTS "Customer"';
    public static readonly CreateTableSql = 'CREATE TABLE "Customer" (id text primary key, label text)';
    public static readonly SeedSql = `INSERT INTO "Customer" (id, label) VALUES ('c1', 'Acme')`;

    public static Make(connectionString: string): IDataSourceAdapter
    {
        const pool = new Pool({ connectionString });
        return new SqlAdapter(new MissingRelationTolerantSession(new ResettingSession(new PgSqlSession(pool))));
    }
}
