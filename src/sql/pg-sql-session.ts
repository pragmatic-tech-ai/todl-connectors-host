import type { Pool } from "pg";
import type { ISqlSession, SqlRow } from "@pragmatic-tech-ai/todl";

/** An ISqlSession backed by a pg.Pool. The adapter owns the SQL text; this owns the connection. */
export class PgSqlSession implements ISqlSession
{
    public constructor(private readonly pool: Pool)
    {
    }

    public async Query(sql: string, params: readonly unknown[]): Promise<readonly SqlRow[]>
    {
        const result = await this.pool.query(sql, params as unknown[]);
        return result.rows as readonly SqlRow[];
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
}
