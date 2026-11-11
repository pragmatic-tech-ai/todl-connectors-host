import { test } from "node:test";
import type { IDataSourceAdapter } from "@pragmatic-tech-ai/todl";
import { DocumentAdapter } from "../document/document-adapter.js";
import { DocumentConnectionConfig, MongoDocumentSession } from "../document/mongo-document-session.js";
import { CypherAdapter } from "../cypher/cypher-adapter.js";
import { CypherConnectionConfig, Neo4jCypherSession } from "../cypher/neo4j-cypher-session.js";
import { PgLiveHarness } from "../testing/pg-mem-adapter.js";
import { ExternalConnectorConformance } from "../testing/external-connector-conformance.js";
import { SeedingCypherSession } from "../testing/seeding-cypher-session.js";
import { SeedingDocumentSession } from "../testing/seeding-document-session.js";

/**
 * Gated live registrations of the external-connector conformance harness (env set => run, else one skipped test per
 * store). The runner executes test files concurrently, and the per-adapter live files (pg-sql-conformance, document-live,
 * cypher-live) reset source Customer on the same stores, so this file binds its own source (table, collection and label
 * ExternalCustomer): no file's reset can touch another's rows. Each case disposes its own adapter (the conformance run
 * owns it), so nothing here disposes again.
 */
class LiveExternalConformance
{
    private static readonly PgVar = "CONNECTORS_LIVE_PG";
    private static readonly MongoVar = "CONNECTORS_LIVE_MONGO";
    private static readonly MongoDbVar = "CONNECTORS_LIVE_MONGO_DB";
    private static readonly Neo4jVar = "CONNECTORS_LIVE_NEO4J";
    private static readonly Neo4jUserVar = "CONNECTORS_LIVE_NEO4J_USER";
    private static readonly Neo4jPasswordVar = "CONNECTORS_LIVE_NEO4J_PASSWORD";
    private static readonly DefaultDatabase = "connectors_test";
    private static readonly Source = "ExternalCustomer";
    private static readonly PgName = "SQL (live postgres)";
    private static readonly MongoName = "Document (live mongo, standalone mode)";
    private static readonly MongoReplicaSetName = "Document (live mongo, replica-set mode)";
    private static readonly TrueValue = "true";
    private static readonly Neo4jName = "Cypher (live neo4j)";
    private static readonly SkipSuffix = " external conformance (env unset)";

    public static Register(): void
    {
        const L = LiveExternalConformance;
        const pg = process.env[L.PgVar] ?? "";
        const mongo = process.env[L.MongoVar] ?? "";
        const neo4j = process.env[L.Neo4jVar] ?? "";
        if (pg !== "")
        {
            ExternalConnectorConformance.Describe(L.PgName, async () => PgLiveHarness.Make(pg, L.Source), { Paged: true, Source: L.Source });
        }
        else
        {
            test(L.PgName + L.SkipSuffix, { skip: true }, () => {});
        }
        if (mongo !== "")
        {
            ExternalConnectorConformance.Describe(L.MongoName, async () => L.MakeMongo(mongo, false), { Paged: true, Links: true, Source: L.Source });
            ExternalConnectorConformance.Describe(L.MongoReplicaSetName, async () => L.MakeMongo(mongo, true), { Paged: true, Links: true, Source: L.Source });
        }
        else
        {
            test(L.MongoName + L.SkipSuffix, { skip: true }, () => {});
        }
        if (neo4j !== "")
        {
            ExternalConnectorConformance.Describe(L.Neo4jName, async () => L.MakeNeo4j(neo4j), { Paged: true, Links: true, Source: L.Source });
        }
        else
        {
            test(L.Neo4jName + L.SkipSuffix, { skip: true }, () => {});
        }
    }

    private static MakeMongo(url: string, replicaSet: boolean): IDataSourceAdapter
    {
        const config: Record<string, string> =
        {
            [DocumentConnectionConfig.UrlKey]: url,
            [DocumentConnectionConfig.DatabaseKey]: process.env[LiveExternalConformance.MongoDbVar] ?? LiveExternalConformance.DefaultDatabase,
            ...(replicaSet ? { [DocumentConnectionConfig.ReplicaSetKey]: LiveExternalConformance.TrueValue } : {}),
        };
        const session = MongoDocumentSession.Connect(DocumentConnectionConfig.From(config));
        return new DocumentAdapter(new SeedingDocumentSession(session, LiveExternalConformance.Source));
    }

    private static MakeNeo4j(uri: string): IDataSourceAdapter
    {
        const config: Record<string, string> = { [CypherConnectionConfig.UriKey]: uri };
        const user = process.env[LiveExternalConformance.Neo4jUserVar];
        if (user !== undefined && user !== "") config[CypherConnectionConfig.UserKey] = user;
        const session = Neo4jCypherSession.Connect(CypherConnectionConfig.From(config, process.env[LiveExternalConformance.Neo4jPasswordVar]));
        return new CypherAdapter(new SeedingCypherSession(session, LiveExternalConformance.Source));
    }
}

LiveExternalConformance.Register();
