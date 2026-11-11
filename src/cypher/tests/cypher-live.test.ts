import { test, after } from "node:test";
import type { IDataSourceAdapter } from "@pragmatic-tech-ai/todl";
import { CypherAdapter } from "../cypher-adapter.js";
import { CypherConnectionConfig, Neo4jCypherSession } from "../neo4j-cypher-session.js";
import { describeDataSourceAdapter } from "../../testing/adapter-conformance.js";
import { SeedingCypherSession } from "../../testing/seeding-cypher-session.js";

class LiveNeo4j
{
    private static readonly UriVar = "CONNECTORS_LIVE_NEO4J";
    private static readonly UserVar = "CONNECTORS_LIVE_NEO4J_USER";
    private static readonly PasswordVar = "CONNECTORS_LIVE_NEO4J_PASSWORD";
    private static readonly SkipName = "Cypher live conformance (CONNECTORS_LIVE_NEO4J unset)";
    private static readonly SuiteName = "CypherAdapter (live neo4j)";

    private static readonly opened: CypherAdapter[] = [];

    /** Registers the live contract when enabled (human-run against provisioned neo4j), else one skipped test. */
    public static Register(): void
    {
        const uri = LiveNeo4j.Uri();
        if (uri !== "")
        {
            describeDataSourceAdapter(LiveNeo4j.SuiteName, () => LiveNeo4j.Make(uri));
            after(async () =>
            {
                await Promise.all(LiveNeo4j.opened.map(adapter => adapter.Dispose()));
            });
        }
        else
        {
            test(LiveNeo4j.SkipName, { skip: true }, () => {});
        }
    }

    private static Uri(): string
    {
        return process.env[LiveNeo4j.UriVar] ?? "";
    }

    private static Make(uri: string): IDataSourceAdapter
    {
        const config: Record<string, string> = { [CypherConnectionConfig.UriKey]: uri };
        const user = process.env[LiveNeo4j.UserVar];
        if (user !== undefined && user !== "") config[CypherConnectionConfig.UserKey] = user;
        const session = Neo4jCypherSession.Connect(CypherConnectionConfig.From(config, process.env[LiveNeo4j.PasswordVar]));
        const adapter = new CypherAdapter(new SeedingCypherSession(session));
        LiveNeo4j.opened.push(adapter);
        return adapter;
    }
}

LiveNeo4j.Register();
