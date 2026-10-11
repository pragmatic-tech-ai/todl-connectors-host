import { test, after } from "node:test";
import type { IDataSourceAdapter } from "@pragmatic-tech-ai/todl";
import { DocumentAdapter } from "../document-adapter.js";
import type { IDocumentSession } from "../document-session.js";
import { DocumentConnectionConfig, MongoDocumentSession } from "../mongo-document-session.js";
import { describeDataSourceAdapter } from "../../testing/adapter-conformance.js";

/** Resets the Customer collection to c1/Acme before its first use, so each contract test starts isolated. */
class SeedingDocumentSession implements IDocumentSession
{
    private static readonly Collection = "Customer";
    private static readonly IdField = "id";
    private static readonly LabelField = "label";
    private static readonly SeedId = "c1";
    private static readonly SeedLabel = "Acme";

    private seeded: Promise<void> | undefined;

    public constructor(private readonly inner: MongoDocumentSession)
    {
    }

    public async Find(collection: string, filter: Record<string, unknown>): Promise<readonly Record<string, unknown>[]>
    {
        await this.EnsureSeeded();
        return this.inner.Find(collection, filter);
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

    public async ReadVersion(collection: string, idField: string, key: unknown): Promise<unknown>
    {
        await this.EnsureSeeded();
        return this.inner.ReadVersion(collection, idField, key);
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
        const existing = await this.inner.Find(SeedingDocumentSession.Collection, {});
        for (const doc of existing)
        {
            await this.inner.Delete(SeedingDocumentSession.Collection, SeedingDocumentSession.IdField, doc[SeedingDocumentSession.IdField]);
        }
        await this.inner.Upsert(SeedingDocumentSession.Collection, SeedingDocumentSession.IdField, SeedingDocumentSession.SeedId,
            { [SeedingDocumentSession.IdField]: SeedingDocumentSession.SeedId, label: SeedingDocumentSession.SeedLabel });
    }
}

class LiveMongo
{
    private static readonly UrlVar = "CONNECTORS_LIVE_MONGO";
    private static readonly DatabaseVar = "CONNECTORS_LIVE_MONGO_DB";
    private static readonly DefaultDatabase = "connectors_test";
    private static readonly SkipName = "Document live conformance (CONNECTORS_LIVE_MONGO unset)";
    private static readonly SuiteName = "DocumentAdapter (live mongo)";
    
    private static readonly opened: DocumentAdapter[] = [];

    /** Registers the live contract when enabled (human-run against provisioned mongo), else one skipped test. */
    public static Register(): void
    {
        const url = process.env[LiveMongo.UrlVar] ?? "";
        if (url !== "")
        {
            describeDataSourceAdapter(LiveMongo.SuiteName, () => LiveMongo.Make(url));
            after(async () =>
            {
                await Promise.all(LiveMongo.opened.map(adapter => adapter.Dispose()));
            });
        }
        else
        {
            test(LiveMongo.SkipName, { skip: true }, () => {});
        }
    }

    private static Make(url: string): IDataSourceAdapter
    {
        const config: Record<string, string> =
        {
            [DocumentConnectionConfig.UrlKey]: url,
            [DocumentConnectionConfig.DatabaseKey]: process.env[LiveMongo.DatabaseVar] ?? LiveMongo.DefaultDatabase,
        };
        const session = MongoDocumentSession.Connect(DocumentConnectionConfig.From(config));
        const adapter = new DocumentAdapter(new SeedingDocumentSession(session));
        LiveMongo.opened.push(adapter);
        return adapter;
    }
}

LiveMongo.Register();
