import type { Pool } from "pg";
import type { ISqlSession, SqlRow } from "@pragmatic-tech-ai/todl";

/** An ISqlSession backed by a pg.Pool. The adapter owns the SQL text; this owns the connection. */
export class PgSqlSession implements ISqlSession
{
    /** Postgres SQLSTATE undefined_table, set as `error.code` by real pg. */
    private static readonly UndefinedTableCode = "42P01";
    /**
     * pg-mem sets NO `code` for a missing relation: it throws a RelationNotFound error whose message is
     * `relation "<name>" does not exist`. Real Postgres uses the same message wording.
     */
    private static readonly MissingRelationPattern = /^relation ".*" does not exist/;

    public constructor(private readonly pool: Pool)
    {
    }

    public async Query(sql: string, params: readonly unknown[]): Promise<readonly SqlRow[]>
    {
        try
        {
            const result = await this.pool.query(sql, params as unknown[]);
            return result.rows as readonly SqlRow[];
        }
        catch (error)
        {
            // An unknown source (missing table) yields no records; every other error propagates.
            if (PgSqlSession.IsUndefinedTable(error))
            {
                return [];
            }
            throw error;
        }
    }

    public async Execute(sql: string, params: readonly unknown[]): Promise<number>
    {
        const result = await this.pool.query(sql, params as unknown[]);
        return result.rowCount ?? 0;
    }

    public async Dispose(): Promise<void>
    {
        await this.pool.end();
    }

    private static IsUndefinedTable(error: unknown): boolean
    {
        const e = error as { code?: unknown; message?: unknown } | null;
        if (e === null || typeof e !== "object")
        {
            return false;
        }
        return e.code === PgSqlSession.UndefinedTableCode
            || (typeof e.message === "string" && PgSqlSession.MissingRelationPattern.test(e.message));
    }
}
