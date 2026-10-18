import type { Pool, PoolClient } from "pg";
import { ConnectionFailureKind } from "@pragmatic-tech-ai/todl";
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
    /** SQLSTATE class 08 (connection exception): the link dropped or could not be made; retry. */
    private static readonly ConnectionClass = "08";
    /** SQLSTATE class 28 (invalid authorization specification): credentials rejected; reopen with fresh ones. */
    private static readonly AuthClass = "28";
    /** admin_shutdown / crash_shutdown / cannot_connect_now: the server is going away or starting; retry. */
    private static readonly ShutdownCodes: ReadonlySet<string> = new Set(["57P01", "57P02", "57P03"]);
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

    /** Pure function of the error: classifies a pg SQLSTATE; never reads the message or any secret. */
    public ClassifyFailure(error: unknown): ConnectionFailureKind
    {
        const code = PgSessionBase.CodeOf(error);
        if (code === undefined)
        {
            return ConnectionFailureKind.Permanent;
        }
        if (code.startsWith(PgSessionBase.ConnectionClass) || PgSessionBase.ShutdownCodes.has(code))
        {
            return ConnectionFailureKind.Transient;
        }
        if (code.startsWith(PgSessionBase.AuthClass))
        {
            return ConnectionFailureKind.Auth;
        }
        return ConnectionFailureKind.Permanent;
    }

    private static CodeOf(error: unknown): string | undefined
    {
        const e = error as { code?: unknown } | null;
        if (e === null || typeof e !== "object")
        {
            return undefined;
        }
        return typeof e.code === "string" ? e.code : undefined;
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
    private static readonly RollbackErrorProperty = "rollbackError";

    public constructor(private readonly pool: Pool)
    {
        // pg's Pool.query has a wider overload set than IPgQueryable's single (sql, params) signature,
        // so it is not structurally assignable; the double cast bridges to the one overload we call.
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
            try
            {
                await client.query(PgSqlSession.Rollback);
            }
            catch (rollbackError)
            {
                // A throwing ROLLBACK must never replace the original work error (that is the one the
                // caller must see); attach it as context on the original instead of letting it propagate.
                if (error !== null && typeof error === "object")
                {
                    (error as Record<string, unknown>)[PgSqlSession.RollbackErrorProperty] = rollbackError;
                }
            }
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
        // pg's PoolClient.query has the same wider overload set as Pool, so (like Pool) it is not
        // structurally assignable to IPgQueryable; the double cast bridges to the one overload we call.
        super(client as unknown as IPgQueryable);
    }
}
