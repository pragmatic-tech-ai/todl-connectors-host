import type { CypherRow, ICypherSession } from "../cypher/cypher-session.js";
import type { Neo4jCypherSession } from "../cypher/neo4j-cypher-session.js";

/**
 * A live Neo4j session that resets the nodes of label `label` to the fixture seed { id: 'c1', label: 'Acme' } before its
 * first Run, so each contract case starts isolated. Live files that run concurrently pass distinct labels, so one file's
 * reset never deletes another's nodes. `label` must be a plain identifier (it is spliced into the reset Cypher).
 */
export class SeedingCypherSession implements ICypherSession
{
    public static readonly DefaultLabel = "Customer";
    private static readonly ResetOpen = "MATCH (n:`";
    private static readonly ResetClose = "`) DETACH DELETE n";
    private static readonly SeedOpen = "CREATE (:`";
    private static readonly SeedClose = "` { id: $id, label: $label })";
    private static readonly SeedParams = { id: "c1", label: "Acme" };

    private seeded: Promise<void> | undefined;

    public constructor(private readonly inner: Neo4jCypherSession, private readonly label: string = SeedingCypherSession.DefaultLabel)
    {
    }

    public async Run(cypher: string, params: Record<string, unknown>): Promise<readonly CypherRow[]>
    {
        this.seeded ??= this.Seed();
        await this.seeded;
        return this.inner.Run(cypher, params);
    }

    public async Dispose(): Promise<void>
    {
        await this.inner.Dispose();
    }

    private async Seed(): Promise<void>
    {
        const S = SeedingCypherSession;
        await this.inner.Run(S.ResetOpen + this.label + S.ResetClose, {});
        await this.inner.Run(S.SeedOpen + this.label + S.SeedClose, S.SeedParams);
    }
}
