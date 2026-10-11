import { MongoClient } from "mongodb";
import type { MongoClientOptions } from "mongodb";
import type { IDocumentSession } from "./document-session.js";

/** Parsed Mongo connection. */
export interface DocumentConnection
{
    readonly url: string;
    readonly database: string;
    readonly user?: string;
    readonly versionField?: string;
}

export class DocumentConnectionConfig
{
    public static readonly UserKey = "user";
    public static readonly VersionFieldKey = "versionField";
    public static readonly UrlKey = "url";
    private static readonly UriKey = "uri";
    public static readonly DatabaseKey = "database";
    private static readonly MissingMessage = "document connector config requires 'url'/'uri' and 'database'";

    public static From(config: Record<string, string>, secret?: string): DocumentConnection
    {
        const url = config[DocumentConnectionConfig.UrlKey] ?? config[DocumentConnectionConfig.UriKey];
        const database = config[DocumentConnectionConfig.DatabaseKey];
        if (url === undefined || database === undefined) throw new Error(DocumentConnectionConfig.MissingMessage);
        // The secret is NOT read here; it flows only to the driver's auth option in MongoDocumentSession.Connect.
        void secret;
        const user = config[DocumentConnectionConfig.UserKey];
        const versionField = config[DocumentConnectionConfig.VersionFieldKey];
        return { url, database, ...(user !== undefined ? { user } : {}), ...(versionField !== undefined ? { versionField } : {}) };
    }
}

/** IDocumentSession over a mongodb MongoClient. */
export class MongoDocumentSession implements IDocumentSession
{
    public constructor(private readonly client: MongoClient, private readonly database: string, private readonly versionField?: string)
    {
    }

    /** Builds the client lazily (no network until first use). The secret goes only into MongoClientOptions.auth. */
    public static Connect(connection: DocumentConnection, secret?: string): MongoDocumentSession
    {
        const options: MongoClientOptions = {};
        if (secret !== undefined && connection.user !== undefined)
        {
            options.auth = { username: connection.user, password: secret };
        }
        return new MongoDocumentSession(new MongoClient(connection.url, options), connection.database, connection.versionField);
    }

    public async Find(collection: string, filter: Record<string, unknown>): Promise<readonly Record<string, unknown>[]>
    {
        return this.client.db(this.database).collection(collection).find(filter, { projection: { _id: 0 } }).toArray() as unknown as Record<string, unknown>[];
    }

    public async Upsert(collection: string, idField: string, key: unknown, doc: Record<string, unknown>): Promise<void>
    {
        await this.client.db(this.database).collection(collection).replaceOne({ [idField]: key }, doc, { upsert: true });
    }

    public async Delete(collection: string, idField: string, key: unknown): Promise<boolean>
    {
        const result = await this.client.db(this.database).collection(collection).deleteOne({ [idField]: key });
        return result.deletedCount > 0;
    }

    /** Enabling optimistic versioning on a document source requires configuring the versionField key; without it, writes are not version-guarded. */
    public async ReadVersion(collection: string, idField: string, key: unknown): Promise<unknown>
    {
        const doc = await this.client.db(this.database).collection(collection).findOne({ [idField]: key });
        if (doc === null || this.versionField === undefined) return null;
        return doc[this.versionField] ?? null;
    }

    public async Dispose(): Promise<void>
    {
        await this.client.close();
    }
}
