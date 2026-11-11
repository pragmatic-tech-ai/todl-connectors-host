import { test, after } from "node:test";
import type { IDataSourceAdapter } from "@pragmatic-tech-ai/todl";
import { DocumentAdapter } from "../document-adapter.js";
import { DocumentConnectionConfig, MongoDocumentSession } from "../mongo-document-session.js";
import { describeDataSourceAdapter } from "../../testing/adapter-conformance.js";
import { SeedingDocumentSession } from "../../testing/seeding-document-session.js";

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
