import type { Pool, PoolClient } from "pg";
import type { ISqlSession, SqlRow } from "@pragmatic-tech-ai/todl";

/** The minimal driver surface a {@link PgSessionBase} issues statements through: a `pg` Pool and a
 *  pinned PoolClient both satisfy it, so the pooled and the transaction-bound sessions share one body. */
interface IPgQueryable
{
    query(sql: string, params: unknown[]): Promise<{ rows: unknown[]; rowCount: number | null }>;
}

/** Shared ISqlSession body over an {@link IPgQueryable}: owns the missing-relation handling so the
 *  pooled session and the transaction-bound session never drift. */
abstract class PgSessionBase implements ISqlSession
{
    /** Postgres SQLSTATE undefined_table, set as `error.code` by real pg. */
    protected static readonly UndefinedTableCode = "42P01";
    /**
     * pg-mem sets NO `code` for a missing relation: it throws a RelationNotFound error whose message is
     * `relation "<name>" does not exist`. Real Postgres uses the same message wording.
     * pg-mem appends multi-line hints after the first line, so only the first line is matched.
     */
    protected static readonly LineBreak = "\n";
    protected static readonly MissingRelationPattern = /^relation "[^"]+" does not exist$/;

    protected constructor(private readonly queryable: IPgQueryable)
    {
    }

    public async Query(sql: string, params: readonly unknown[]): Promise<readonly SqlRow[]>
    {
        try
        {
            const result = await this.queryable.query(sql, params as unknown[]);
            return result.rows as readonly SqlRow[];
        }
        catch (error)
        {
            // An unknown source (missing table) yields no records; every other error propagates.
            if (PgSessionBase.IsUndefinedTable(error))
            {
                return [];
            }
            throw error;
        }
    }

    public async Execute(sql: string, params: readonly unknown[]): Promise<number>
    {
        const result = await this.queryable.query(sql, params as unknown[]);
        return result.rowCount ?? 0;
    }

    protected static IsUndefinedTable(error: unknown): boolean
    {
        const e = error as { code?: unknown; message?: unknown } | null;
        if (e === null || typeof e !== "object")
        {
            return false;
        }
        if (e.code === PgSessionBase.UndefinedTableCode)
        {
            return true;
        }
        // Message fallback only for code-less errors (pg-mem); a different SQLSTATE is never remapped.
        return e.code === undefined
            && typeof e.message === "string"
            && PgSessionBase.MissingRelationPattern.test(e.message.split(PgSessionBase.LineBreak)[0]!);
    }
}

/** An ISqlSession backed by a pg.Pool. The adapter owns the SQL text; this owns the connection. */
export class PgSqlSession extends PgSessionBase
{
    private static readonly Begin = "BEGIN";
    private static readonly Commit = "COMMIT";
    private static readonly Rollback = "ROLLBACK";

    public constructor(private readonly pool: Pool)
    {
        super(pool as unknown as IPgQueryable);
    }

    /**
     * Runs `work` inside one backend transaction. A single client is pinned out of the pool so every
     * statement joins the same session; BEGIN opens it, COMMIT seals it on resolve, and a reject rolls it
     * back and rethrows (so the caller reports nothing applied). The client is always released in finally.
     */
    public async Transaction<T>(work: (tx: ISqlSession) => Promise<T>): Promise<T>
    {
        const client = await this.pool.connect();
        try
        {
            await client.query(PgSqlSession.Begin);
            const result = await work(new PgPinnedClientSession(client));
            await client.query(PgSqlSession.Commit);
            return result;
        }
        catch (error)
        {
            await client.query(PgSqlSession.Rollback);
            throw error;
        }
        finally
        {
            client.release();
        }
    }

    public async Dispose(): Promise<void>
    {
        await this.pool.end();
    }
}

/** An ISqlSession pinned to one PoolClient so a batch of statements runs inside a single transaction. */
class PgPinnedClientSession extends PgSessionBase
{
    public constructor(client: PoolClient)
    {
        super(client as unknown as IPgQueryable);
    }
}
