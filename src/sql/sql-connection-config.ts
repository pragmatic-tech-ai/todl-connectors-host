/** Discrete option bag handed to a pg.Pool. */
export interface PgPoolOptions
{
    connectionString?: string;
    host?: string;
    port?: number;
    database?: string;
    user?: string;
    password?: string;
    ssl?: boolean;
}

/** Parses/validates a connector Config map into pg.Pool options and injects the resolved secret. */
export class SqlConnectionConfig
{
    private static readonly ConnectionStringKey = "connectionString";
    private static readonly HostKey = "host";
    private static readonly PortKey = "port";
    private static readonly DatabaseKey = "database";
    private static readonly UserKey = "user";
    private static readonly SslKey = "ssl";
    private static readonly TrueLiteral = "true";
    private static readonly MissingTargetMessage =
        "sql connector config must supply 'connectionString' or 'database'";

    private static readonly InvalidPortMessage = "sql connector config 'port' must be a number";

    public static From(config: Record<string, string>, secret?: string): PgPoolOptions
    {
        const connectionString = config[SqlConnectionConfig.ConnectionStringKey];
        const database = config[SqlConnectionConfig.DatabaseKey];
        const host = config[SqlConnectionConfig.HostKey];
        const port = config[SqlConnectionConfig.PortKey];
        const user = config[SqlConnectionConfig.UserKey];
        const ssl = config[SqlConnectionConfig.SslKey];
        const hasConnectionString = connectionString !== undefined && connectionString !== "";
        const hasDatabase = database !== undefined && database !== "";
        if (!hasConnectionString && !hasDatabase)
        {
            throw new Error(SqlConnectionConfig.MissingTargetMessage);
        }
        const opts: PgPoolOptions = {};
        if (hasConnectionString) opts.connectionString = connectionString;
        if (host !== undefined) opts.host = host;
        if (port !== undefined)
        {
            const parsed = Number(port);
            if (Number.isNaN(parsed))
            {
                throw new Error(SqlConnectionConfig.InvalidPortMessage);
            }
            opts.port = parsed;
        }
        if (hasDatabase) opts.database = database;
        if (user !== undefined) opts.user = user;
        if (ssl === SqlConnectionConfig.TrueLiteral) opts.ssl = true;
        if (secret !== undefined) opts.password = secret;
        return opts;
    }
}
