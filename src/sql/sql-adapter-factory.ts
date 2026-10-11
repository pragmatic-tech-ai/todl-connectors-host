import { Pool } from "pg";
import { DataSourceKind, SqlAdapter } from "@pragmatic-tech-ai/todl";
import type { IDataSourceAdapter, IDataSourceAdapterFactory, ResolvedConnection } from "@pragmatic-tech-ai/todl";
import { SqlConnectionConfig } from "./sql-connection-config.js";
import type { PgPoolOptions } from "./sql-connection-config.js";
import { PgSqlSession } from "./pg-sql-session.js";

/** Builds a pg.Pool from pool options (overridable in tests). */
export type PgPoolBuilder = (options: PgPoolOptions) => Pool;

/** Opens SQL adapters backed by a pg.Pool. */
export class SqlAdapterFactory implements IDataSourceAdapterFactory
{
    public readonly Kind = DataSourceKind.Sql;

    private readonly buildPool: PgPoolBuilder;

    public constructor(buildPool?: PgPoolBuilder)
    {
        this.buildPool = buildPool ?? ((options) => new Pool(options));
    }

    public async Open(connection: ResolvedConnection): Promise<IDataSourceAdapter>
    {
        const options = SqlConnectionConfig.From(connection.Config, connection.Secret);
        return new SqlAdapter(new PgSqlSession(this.buildPool(options)));
    }
}
