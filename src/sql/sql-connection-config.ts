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

    public static From(config: Record<string, string>, secret?: string): PgPoolOptions
    {
        const connectionString = config[SqlConnectionConfig.ConnectionStringKey];
        const database = config[SqlConnectionConfig.DatabaseKey];
        if (connectionString === undefined && database === undefined)
        {
            throw new Error(SqlConnectionConfig.MissingTargetMessage);
        }
        const opts: PgPoolOptions = {};
        if (connectionString !== undefined) opts.connectionString = connectionString;
        if (config[SqlConnectionConfig.HostKey] !== undefined) opts.host = config[SqlConnectionConfig.HostKey];
        if (config[SqlConnectionConfig.PortKey] !== undefined) opts.port = Number(config[SqlConnectionConfig.PortKey]);
        if (database !== undefined) opts.database = database;
        if (config[SqlConnectionConfig.UserKey] !== undefined) opts.user = config[SqlConnectionConfig.UserKey];
        if (config[SqlConnectionConfig.SslKey] === SqlConnectionConfig.TrueLiteral) opts.ssl = true;
        if (secret !== undefined) opts.password = secret;
        return opts;
    }
}
