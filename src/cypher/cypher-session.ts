/** One row returned by a Cypher query, keyed by RETURN alias. */
export interface CypherRow
{
    readonly [field: string]: unknown;
}

/** Injected graph-driver seam: the adapter owns Cypher text, the host supplies the connection. */
export interface ICypherSession
{
    Run(cypher: string, params: Record<string, unknown>): Promise<readonly CypherRow[]>;
    /**
     * Optional: runs `work` inside one backend transaction, committing on resolve and rolling back +
     * rethrowing on reject. Absent on sessions that cannot transact; present only when the deployment can
     * (a neo4j driver session via executeWrite). The adapter hands every op to the transaction-bound `tx`.
     */
    Transaction?<T>(work: (tx: ICypherSession) => Promise<T>): Promise<T>;
    Dispose?(): Promise<void>;
}
