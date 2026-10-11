import { MongoClient } from "mongodb";
import type { MongoClientOptions } from "mongodb";
import type { IDocumentSession } from "./document-session.js";
import { DocumentIdentifier } from "./document-identifier.js";

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
    private static readonly AuthMissingUserMessage = "mongo auth requires a 'user' config key when a secret is supplied";

    public constructor(private readonly client: MongoClient, private readonly database: string, private readonly versionField?: string)
    {
    }

    /** Builds the client lazily (no network until first use). The secret goes only into MongoClientOptions.auth. */
    public static Connect(connection: DocumentConnection, secret?: string): MongoDocumentSession
    {
        if (secret !== undefined && connection.user === undefined)
        {
            throw new Error(MongoDocumentSession.AuthMissingUserMessage);
        }
        const options: MongoClientOptions = {};
        if (secret !== undefined && connection.user !== undefined)
        {
            options.auth = { username: connection.user, password: secret };
        }
        return new MongoDocumentSession(new MongoClient(connection.url, options), connection.database, connection.versionField);
    }

    public async Find(collection: string, filter: Record<string, unknown>): Promise<readonly Record<string, unknown>[]>
    {
        DocumentIdentifier.Validate(collection);
        return this.client.db(this.database).collection(collection).find(filter, { projection: { _id: 0 } }).toArray() as unknown as Record<string, unknown>[];
    }

    public async Upsert(collection: string, idField: string, key: unknown, doc: Record<string, unknown>): Promise<void>
    {
        DocumentIdentifier.Validate(collection);
        DocumentIdentifier.Validate(idField);
        await this.client.db(this.database).collection(collection).replaceOne({ [idField]: key }, doc, { upsert: true });
    }

    public async Delete(collection: string, idField: string, key: unknown): Promise<boolean>
    {
        DocumentIdentifier.Validate(collection);
        DocumentIdentifier.Validate(idField);
        const result = await this.client.db(this.database).collection(collection).deleteOne({ [idField]: key });
        return result.deletedCount > 0;
    }

    /**
     * Enabling optimistic versioning on a document source requires configuring the versionField key; without it, writes are not version-guarded.
     * Returns null in THREE cases: versionField unconfigured, doc absent, AND doc present but its version field absent/null. The caller
     * therefore cannot distinguish a brand-new doc from a pre-existing unversioned doc (both are treated as writable). This is deliberate
     * v1 best-effort behavior (consistent with the non-atomic read-then-write window; transactions are deferred, spec section 9).
     */
    public async ReadVersion(collection: string, idField: string, key: unknown): Promise<unknown>
    {
        DocumentIdentifier.Validate(collection);
        DocumentIdentifier.Validate(idField);
        const doc = await this.client.db(this.database).collection(collection).findOne({ [idField]: key });
        if (doc === null || this.versionField === undefined) return null;
        return doc[this.versionField] ?? null;
    }

    public async Dispose(): Promise<void>
    {
        await this.client.close();
    }
}
