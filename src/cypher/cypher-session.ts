/** One row returned by a Cypher query, keyed by RETURN alias. */
export interface CypherRow
{
    readonly [field: string]: unknown;
}

/** Injected graph-driver seam: the adapter owns Cypher text, the host supplies the connection. */
export interface ICypherSession
{
    Run(cypher: string, params: Record<string, unknown>): Promise<readonly CypherRow[]>;
    Dispose?(): Promise<void>;
}
