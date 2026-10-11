import { newDb } from "pg-mem";
import { SqlAdapter } from "@pragmatic-tech-ai/todl";
import type { IDataSourceAdapter, ISqlSession, SqlRow } from "@pragmatic-tech-ai/todl";
import { Pool } from "pg";
import { PgSqlSession } from "../sql/pg-sql-session.js";

/** Builds pg-mem-backed SqlAdapters pre-seeded with Customer(id PRIMARY KEY, label) = c1/Acme. */
export class PgMemAdapterHarness
{
    /** Single home of the fixture table shape (id MUST be PRIMARY KEY for the engine's ON CONFLICT upsert). */
    public static readonly CreateTableSql = 'CREATE TABLE "Customer" (id text primary key, label text)';
    public static readonly SeedSql = `INSERT INTO "Customer" (id, label) VALUES ('c1', 'Acme')`;

    /** A fresh, isolated in-process database per call. */
    public static Make(): IDataSourceAdapter
    {
        const db = newDb();
        const pg = db.adapters.createPg();
        const pool = new pg.Pool() as unknown as Pool;
        db.public.none(PgMemAdapterHarness.CreateTableSql);
        db.public.none(PgMemAdapterHarness.SeedSql);
        return new SqlAdapter(new PgSqlSession(pool));
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
        await this.inner.Dispose?.();
    }

    private EnsureReset(): Promise<void>
    {
        this.ready ??= this.Reset();
        return this.ready;
    }

    private async Reset(): Promise<void>
    {
        await this.inner.Execute(PgLiveHarness.DropTableSql, []);
        await this.inner.Execute(PgMemAdapterHarness.CreateTableSql, []);
        await this.inner.Execute(PgMemAdapterHarness.SeedSql, []);
    }
}

/** Builds adapters over a real Postgres, resetting Customer(id PK, label) to c1/Acme on each adapter's first use. */
export class PgLiveHarness
{
    public static readonly DropTableSql = 'DROP TABLE IF EXISTS "Customer"';

    private static readonly Opened: IDataSourceAdapter[] = [];

    public static Make(connectionString: string): IDataSourceAdapter
    {
        const pool = new Pool({ connectionString });
        const adapter = new SqlAdapter(new ResettingSession(new PgSqlSession(pool)));
        PgLiveHarness.Opened.push(adapter);
        return adapter;
    }

    /** Ends every pool opened by Make so a live run does not leak connections until idle timeout. */
    public static async DisposeAll(): Promise<void>
    {
        const adapters = PgLiveHarness.Opened.splice(0);
        for (const adapter of adapters)
        {
            await adapter.Dispose();
        }
    }
}
