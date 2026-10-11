import neo4j from "neo4j-driver";
import type { Driver } from "neo4j-driver";
import type { CypherRow, ICypherSession } from "./cypher-session.js";

/** Parsed neo4j connection. */
export interface CypherConnection
{
    readonly uri: string;
    readonly user: string;
    readonly password?: string;
    readonly database?: string;
}

export class CypherConnectionConfig
{
    private static readonly UriKey = "uri";
    public static readonly UserKey = "user";
    private static readonly DatabaseKey = "database";
    private static readonly DefaultUser = "neo4j";
    private static readonly MissingUriMessage = "cypher connector config requires 'uri'";

    public static From(config: Record<string, string>, secret?: string): CypherConnection
    {
        const uri = config[CypherConnectionConfig.UriKey];
        if (uri === undefined) throw new Error(CypherConnectionConfig.MissingUriMessage);
        const connection: CypherConnection = { uri, user: config[CypherConnectionConfig.UserKey] ?? CypherConnectionConfig.DefaultUser };
        const database = config[CypherConnectionConfig.DatabaseKey];
        return { ...connection,
            ...(secret !== undefined ? { password: secret } : {}),
            ...(database !== undefined ? { database } : {}) };
    }
}

/** ICypherSession over a neo4j driver. Each Run opens a short-lived session. */
export class Neo4jCypherSession implements ICypherSession
{
    public constructor(private readonly driver: Driver, private readonly database?: string)
    {
    }

    public static Connect(connection: CypherConnection): Neo4jCypherSession
    {
        // No secret => empty password: intentionally targets an auth-disabled server.
        const auth = neo4j.auth.basic(connection.user, connection.password ?? "");
        return new Neo4jCypherSession(neo4j.driver(connection.uri, auth), connection.database);
    }

    public async Run(cypher: string, params: Record<string, unknown>): Promise<readonly CypherRow[]>
    {
        const session = this.database !== undefined ? this.driver.session({ database: this.database }) : this.driver.session();
        try
        {
            const result = await session.run(cypher, params);
            // neo4j-native values (Integer, temporal, ...) pass through ExternalQuery.Coerce, which stringifies
            // non-scalars (Integer -> decimal string), like the SQL adapter's numeric->string; richer typing is deferred.
            return result.records.map(record => Object.fromEntries(record.keys.map(k => [k, record.get(k)])) as CypherRow);
        }
        finally
        {
            await session.close();
        }
    }

    public async Dispose(): Promise<void>
    {
        await this.driver.close();
    }
}
