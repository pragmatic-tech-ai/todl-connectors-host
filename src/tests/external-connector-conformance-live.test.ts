import { after, test } from "node:test";
import type { ExternalFieldValue, IDataSourceAdapter } from "@pragmatic-tech-ai/todl";
import { DocumentAdapter } from "../document/document-adapter.js";
import type { DocumentFindOptions, IDocumentSession, VersionState } from "../document/document-session.js";
import { DocumentConnectionConfig, MongoDocumentSession } from "../document/mongo-document-session.js";
import { CypherAdapter } from "../cypher/cypher-adapter.js";
import type { CypherRow, ICypherSession } from "../cypher/cypher-session.js";
import { CypherConnectionConfig, Neo4jCypherSession } from "../cypher/neo4j-cypher-session.js";
import { PgLiveHarness } from "../testing/pg-mem-adapter.js";
import { ExternalConformanceRun, ExternalConnectorConformance } from "../testing/external-connector-conformance.js";

/** Resets the Customer collection to the conformance seed before first use; forwards Transaction so a replica set is exercised. */
class ResettingDocumentSession implements IDocumentSession
{
    private seeded: Promise<void> | undefined;

    /** Present only when the wrapped session can transact (a replica-set session), so CanTransact mirrors the real one. */
    public readonly Transaction?: <T>(work: (tx: IDocumentSession) => Promise<T>) => Promise<T>;

    public constructor(private readonly inner: MongoDocumentSession)
    {
        const transactional = inner as unknown as IDocumentSession;
        if (transactional.Transaction !== undefined)
        {
            this.Transaction = async <T>(work: (tx: IDocumentSession) => Promise<T>): Promise<T> =>
            {
                await this.EnsureSeeded();
                return transactional.Transaction!(work);
            };
        }
    }

    public async Find(collection: string, filter: Record<string, unknown>, options?: DocumentFindOptions): Promise<readonly Record<string, unknown>[]>
    {
        await this.EnsureSeeded();
        return this.inner.Find(collection, filter, options);
    }

    public async Upsert(collection: string, idField: string, key: unknown, doc: Record<string, unknown>): Promise<void>
    {
        await this.EnsureSeeded();
        return this.inner.Upsert(collection, idField, key, doc);
    }

    public async Delete(collection: string, idField: string, key: unknown): Promise<boolean>
    {
        await this.EnsureSeeded();
        return this.inner.Delete(collection, idField, key);
    }

    public async ReadVersionState(source: string, idKey: string, key: ExternalFieldValue): Promise<VersionState>
    {
        await this.EnsureSeeded();
        return this.inner.ReadVersionState(source, idKey, key);
    }

    public async Dispose(): Promise<void>
    {
        await this.inner.Dispose();
    }

    private EnsureSeeded(): Promise<void>
    {
        this.seeded ??= this.Reset();
        return this.seeded;
    }

    private async Reset(): Promise<void>
    {
        const R = ExternalConformanceRun;
        for (const doc of await this.inner.Find(R.Source, {}))
        {
            await this.inner.Delete(R.Source, R.IdKey, doc[R.IdKey]);
        }
        await this.inner.Upsert(R.Source, R.IdKey, R.SeedId, { [R.IdKey]: R.SeedId, [R.LabelField]: R.SeedLabel });
    }
}

/** Resets the :Customer graph to the conformance seed before first Run. */
class ResettingCypherSession implements ICypherSession
{
    private static readonly ResetCypher = "MATCH (n:Customer) DETACH DELETE n";
    private static readonly SeedCypher = "CREATE (:Customer { id: $id, label: $label })";

    private seeded: Promise<void> | undefined;

    public constructor(private readonly inner: Neo4jCypherSession)
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
        await this.inner.Run(ResettingCypherSession.ResetCypher, {});
        await this.inner.Run(ResettingCypherSession.SeedCypher, { id: ExternalConformanceRun.SeedId, label: ExternalConformanceRun.SeedLabel });
    }
}

/** Gated live registrations of the external-connector conformance harness (env set => run, else one skipped test per store). */
class LiveExternalConformance
{
    private static readonly PgVar = "CONNECTORS_LIVE_PG";
    private static readonly MongoVar = "CONNECTORS_LIVE_MONGO";
    private static readonly MongoDbVar = "CONNECTORS_LIVE_MONGO_DB";
    private static readonly Neo4jVar = "CONNECTORS_LIVE_NEO4J";
    private static readonly Neo4jUserVar = "CONNECTORS_LIVE_NEO4J_USER";
    private static readonly Neo4jPasswordVar = "CONNECTORS_LIVE_NEO4J_PASSWORD";
    private static readonly DefaultDatabase = "connectors_test";
    private static readonly PgName = "SQL (live postgres)";
    private static readonly MongoName = "Document (live mongo, standalone mode)";
    private static readonly MongoReplicaSetName = "Document (live mongo, replica-set mode)";
    private static readonly TrueValue = "true";
    private static readonly Neo4jName = "Cypher (live neo4j)";
    private static readonly SkipSuffix = " external conformance (env unset)";

    private static readonly opened: IDataSourceAdapter[] = [];

    public static Register(): void
    {
        const L = LiveExternalConformance;
        const pg = process.env[L.PgVar] ?? "";
        const mongo = process.env[L.MongoVar] ?? "";
        const neo4j = process.env[L.Neo4jVar] ?? "";
        if (pg !== "")
        {
            ExternalConnectorConformance.Describe(L.PgName, async () => PgLiveHarness.Make(pg), { Paged: true });
            after(async () => { await PgLiveHarness.DisposeAll(); });
        }
        else
        {
            test(L.PgName + L.SkipSuffix, { skip: true }, () => {});
        }
        if (mongo !== "")
        {
            ExternalConnectorConformance.Describe(L.MongoName, async () => L.Track(L.MakeMongo(mongo, false)), { Paged: true, Links: true });
            ExternalConnectorConformance.Describe(L.MongoReplicaSetName, async () => L.Track(L.MakeMongo(mongo, true)), { Paged: true, Links: true });
        }
        else
        {
            test(L.MongoName + L.SkipSuffix, { skip: true }, () => {});
        }
        if (neo4j !== "")
        {
            ExternalConnectorConformance.Describe(L.Neo4jName, async () => L.Track(L.MakeNeo4j(neo4j)), { Paged: true, Links: true });
        }
        else
        {
            test(L.Neo4jName + L.SkipSuffix, { skip: true }, () => {});
        }
        after(async () =>
        {
            await Promise.all(L.opened.splice(0).map(adapter => adapter.Dispose()));
        });
    }

    private static Track(adapter: IDataSourceAdapter): IDataSourceAdapter
    {
        LiveExternalConformance.opened.push(adapter);
        return adapter;
    }

    private static MakeMongo(url: string, replicaSet: boolean): IDataSourceAdapter
    {
        const config: Record<string, string> =
        {
            [DocumentConnectionConfig.UrlKey]: url,
            [DocumentConnectionConfig.DatabaseKey]: process.env[LiveExternalConformance.MongoDbVar] ?? LiveExternalConformance.DefaultDatabase,
            ...(replicaSet ? { [DocumentConnectionConfig.ReplicaSetKey]: LiveExternalConformance.TrueValue } : {}),
        };
        return new DocumentAdapter(new ResettingDocumentSession(MongoDocumentSession.Connect(DocumentConnectionConfig.From(config))));
    }

    private static MakeNeo4j(uri: string): IDataSourceAdapter
    {
        const config: Record<string, string> = { uri };
        const user = process.env[LiveExternalConformance.Neo4jUserVar];
        if (user !== undefined && user !== "") config[CypherConnectionConfig.UserKey] = user;
        const session = Neo4jCypherSession.Connect(CypherConnectionConfig.From(config, process.env[LiveExternalConformance.Neo4jPasswordVar]));
        return new CypherAdapter(new ResettingCypherSession(session));
    }
}

LiveExternalConformance.Register();
