import { newDb } from "pg-mem";
import type { IMemoryDb } from "pg-mem";
import { SqlAdapter } from "@pragmatic-tech-ai/todl";
import type { IDataSourceAdapter, ISqlSession, SqlRow } from "@pragmatic-tech-ai/todl";
import { Pool } from "pg";
import { PgSqlSession } from "../sql/pg-sql-session.js";

/** Builds pg-mem-backed SqlAdapters pre-seeded with Customer(id PRIMARY KEY, label) = c1/Acme. */
export class PgMemAdapterHarness
{
    /** Single home of the fixture table shape (id MUST be PRIMARY KEY for the engine's ON CONFLICT upsert).
     *  Carries the `rev` version column so the optimistic version-guard conformance cases (SqlAdapter now
     *  advertises CanVersion) have a column to guard on; the seed leaves it NULL (present-but-unversioned).
     *  Carries the `parent` column for the external-connector conformance's reverse lookup (a foreign key to Customer). */
    public static readonly DefaultTable = "Customer";
    private static readonly CreateTableOpen = 'CREATE TABLE "';
    private static readonly CreateTableClose = '" (id text primary key, label text, rev text, parent text)';
    private static readonly SeedOpen = 'INSERT INTO "';
    private static readonly SeedClose = `" (id, label) VALUES ('c1', 'Acme')`;
    public static readonly CreateTableSql = PgMemAdapterHarness.CreateTableSqlFor(PgMemAdapterHarness.DefaultTable);
    public static readonly SeedSql = PgMemAdapterHarness.SeedSqlFor(PgMemAdapterHarness.DefaultTable);

    /** The fixture table's CREATE statement under the name `table` (a plain identifier). */
    public static CreateTableSqlFor(table: string): string
    {
        return PgMemAdapterHarness.CreateTableOpen + table + PgMemAdapterHarness.CreateTableClose;
    }

    /** The fixture seed (c1/Acme) into `table`. */
    public static SeedSqlFor(table: string): string
    {
        return PgMemAdapterHarness.SeedOpen + table + PgMemAdapterHarness.SeedClose;
    }

    /** A fresh, isolated in-process database per call. */
    public static Make(): IDataSourceAdapter
    {
        return new SqlAdapter(PgMemAdapterHarness.Session());
    }

    /**
     * As Make, with the affected-row count of a version-guarded upsert reported as Postgres reports it (see
     * {@link PgMemFaithfulSession}) and rollback that undoes, so the optimistic and rollback cases can run offline.
     */
    public static MakeVersionFaithful(): IDataSourceAdapter
    {
        const db = PgMemAdapterHarness.Database();
        return new SqlAdapter(new PgMemFaithfulSession(PgMemAdapterHarness.Session(db), db));
    }

    private static Database(): IMemoryDb
    {
        const db = newDb();
        db.public.none(PgMemAdapterHarness.CreateTableSql);
        db.public.none(PgMemAdapterHarness.SeedSql);
        return db;
    }

    private static Session(db: IMemoryDb = PgMemAdapterHarness.Database()): PgSqlSession
    {
        const pg = db.adapters.createPg();
        return new PgSqlSession(new pg.Pool() as unknown as Pool);
    }
}

/**
 * A pg-mem session that behaves as Postgres where pg-mem does not, for the two things the optimistic and transactional
 * conformance cases depend on:
 * - The command tag of SqlAdapter's version-guarded upsert (`INSERT ... ON CONFLICT ("id") DO UPDATE SET ... WHERE
 *   "T"."rev" = $n`). pg-mem reports rowCount 1 even when the WHERE excluded the conflicting row; Postgres reports 0.
 *   Before such a statement this session reads the conflicting row's version: when the row exists and its version is
 *   null, the expected version is null, or the two differ, the guard would exclude it, so the statement is not run and 0
 *   is returned (no row changed). A guarded upsert that would apply, and every other statement, run unchanged.
 * - Rollback. pg-mem's pg adapter ignores ROLLBACK (rows inserted after BEGIN stay), so Transaction takes a pg-mem
 *   backup, runs `work` against this session, and restores the backup when `work` rejects. Statements are not isolated
 *   from other sessions (the conformance runs one session per database).
 */
export class PgMemFaithfulSession implements ISqlSession
{
    private static readonly GuardedUpsert = /^INSERT INTO ("(?:[^"]|"")+") .* ON CONFLICT \(("(?:[^"]|"")+")\) DO UPDATE SET .* WHERE "(?:[^"]|"")+"\.("(?:[^"]|"")+") = \$(\d+)$/s;
    private static readonly SelectOpen = "SELECT ";
    private static readonly SelectAs = " AS v FROM ";
    private static readonly SelectWhere = " WHERE ";
    private static readonly SelectKey = " = $1";
    private static readonly VersionAlias = "v";

    public constructor(private readonly inner: ISqlSession, private readonly db: IMemoryDb)
    {
    }

    public Query(sql: string, params: readonly unknown[]): Promise<readonly SqlRow[]>
    {
        return this.inner.Query(sql, params);
    }

    public async Execute(sql: string, params: readonly unknown[]): Promise<number>
    {
        const guard = PgMemFaithfulSession.GuardedUpsert.exec(sql);
        if (guard !== null)
        {
            const [, table, idColumn, versionColumn, index] = guard;
            const rows = await this.inner.Query(
                PgMemFaithfulSession.SelectOpen + versionColumn + PgMemFaithfulSession.SelectAs + table
                    + PgMemFaithfulSession.SelectWhere + idColumn + PgMemFaithfulSession.SelectKey,
                [params[0]]);
            const expected = params[Number(index) - 1] ?? null;
            const stored = rows[0]?.[PgMemFaithfulSession.VersionAlias] ?? null;
            if (rows.length > 0 && (stored === null || expected === null || String(stored) !== String(expected)))
            {
                return 0;
            }
        }
        return this.inner.Execute(sql, params);
    }

    public async Transaction<T>(work: (tx: ISqlSession) => Promise<T>): Promise<T>
    {
        const backup = this.db.backup();
        try
        {
            return await work(this);
        }
        catch (error)
        {
            backup.restore();
            throw error;
        }
    }

    public async Dispose(): Promise<void>
    {
        await this.inner.Dispose?.();
    }
}

/** Wraps a live session; before first use, drops/recreates the fixture table `table` and seeds c1/Acme. */
class ResettingSession implements ISqlSession
{
    private ready: Promise<void> | undefined;

    public constructor(private readonly inner: ISqlSession, private readonly table: string)
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
        await this.inner.Execute(PgLiveHarness.DropTableSqlFor(this.table), []);
        await this.inner.Execute(PgMemAdapterHarness.CreateTableSqlFor(this.table), []);
        await this.inner.Execute(PgMemAdapterHarness.SeedSqlFor(this.table), []);
    }
}

/**
 * Builds adapters over a real Postgres, resetting the fixture table (id PK, label; default Customer) to c1/Acme on each
 * adapter's first use. Live files that run concurrently pass distinct table names so one never drops another's table.
 */
export class PgLiveHarness
{
    private static readonly DropTableOpen = 'DROP TABLE IF EXISTS "';
    private static readonly DropTableClose = '"';
    public static readonly DropTableSql = PgLiveHarness.DropTableSqlFor(PgMemAdapterHarness.DefaultTable);

    private static readonly Opened: IDataSourceAdapter[] = [];

    public static DropTableSqlFor(table: string): string
    {
        return PgLiveHarness.DropTableOpen + table + PgLiveHarness.DropTableClose;
    }

    public static Make(connectionString: string, table: string = PgMemAdapterHarness.DefaultTable): IDataSourceAdapter
    {
        const pool = new Pool({ connectionString });
        const adapter = new SqlAdapter(new ResettingSession(new PgSqlSession(pool), table));
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
