import { MongoClient } from "mongodb";
import type { ClientSession, MongoClientOptions } from "mongodb";
import type { ExternalFieldValue } from "@pragmatic-tech-ai/todl";
import type { IDocumentSession, VersionState } from "./document-session.js";
import { DocumentIdentifier } from "./document-identifier.js";

/** Parsed Mongo connection. */
export interface DocumentConnection
{
    readonly url: string;
    readonly database: string;
    readonly user?: string;
    readonly versionField?: string;
    readonly replicaSet?: boolean;
}

export class DocumentConnectionConfig
{
    public static readonly UserKey = "user";
    public static readonly VersionFieldKey = "versionField";
    public static readonly ReplicaSetKey = "replicaSet";
    public static readonly UrlKey = "url";
    private static readonly UriKey = "uri";
    public static readonly DatabaseKey = "database";
    private static readonly TrueValue = "true";
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
        const replicaSet = config[DocumentConnectionConfig.ReplicaSetKey] === DocumentConnectionConfig.TrueValue;
        return {
            url,
            database,
            ...(user !== undefined ? { user } : {}),
            ...(versionField !== undefined ? { versionField } : {}),
            ...(replicaSet ? { replicaSet } : {}),
        };
    }
}

/** IDocumentSession over a mongodb MongoClient. */
export class MongoDocumentSession implements IDocumentSession
{
    private static readonly AuthMissingUserMessage = "mongo auth requires a 'user' config key when a secret is supplied";

    public constructor(
        protected readonly client: MongoClient,
        protected readonly database: string,
        protected readonly versionField?: string,
        // When present, every operation runs on this driver session so it joins an open transaction.
        private readonly clientSession?: ClientSession)
    {
    }

    /**
     * Builds the client lazily (no network until first use). The secret goes only into
     * MongoClientOptions.auth. A replica-set deployment yields a {@link ReplicaSetMongoDocumentSession}
     * so the adapter can transact; a standalone yields the plain session (CanTransact stays false, and
     * a transactional batch is reported Unsupported -- never thrown at apply time).
     */
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
        const client = new MongoClient(connection.url, options);
        if (connection.replicaSet === true)
        {
            return new ReplicaSetMongoDocumentSession(client, connection.database, connection.versionField);
        }
        return new MongoDocumentSession(client, connection.database, connection.versionField);
    }

    public async Find(collection: string, filter: Record<string, unknown>): Promise<readonly Record<string, unknown>[]>
    {
        DocumentIdentifier.Validate(collection);
        return this.client.db(this.database).collection(collection)
            .find(filter, { projection: { _id: 0 }, ...this.SessionOption() }).toArray() as unknown as Record<string, unknown>[];
    }

    public async Upsert(collection: string, idField: string, key: unknown, doc: Record<string, unknown>): Promise<void>
    {
        DocumentIdentifier.Validate(collection);
        DocumentIdentifier.Validate(idField);
        await this.client.db(this.database).collection(collection).replaceOne({ [idField]: key }, doc, { upsert: true, ...this.SessionOption() });
    }

    public async Delete(collection: string, idField: string, key: unknown): Promise<boolean>
    {
        DocumentIdentifier.Validate(collection);
        DocumentIdentifier.Validate(idField);
        const result = await this.client.db(this.database).collection(collection).deleteOne({ [idField]: key }, this.SessionOption());
        return result.deletedCount > 0;
    }

    /**
     * Probes a document in a single findOne, distinguishing three states so the adapter can fail CLOSED:
     * absent (doc null -> Exists:false), present-but-unversioned (Version null, e.g. versionField
     * unconfigured or the field missing), and versioned (Version is the stored value).
     */
    public async ReadVersionState(source: string, idKey: string, key: ExternalFieldValue): Promise<VersionState>
    {
        DocumentIdentifier.Validate(source);
        DocumentIdentifier.Validate(idKey);
        const doc = await this.client.db(this.database).collection(source).findOne({ [idKey]: key }, this.SessionOption());
        if (doc === null)
        {
            return { Exists: false };
        }
        const version = this.versionField === undefined ? null : (doc[this.versionField] ?? null);
        return { Exists: true, Version: version as ExternalFieldValue | null };
    }

    public async Dispose(): Promise<void>
    {
        await this.client.close();
    }

    /** The driver session option, present only when this instance is bound to an open transaction. */
    protected SessionOption(): { session?: ClientSession }
    {
        return this.clientSession === undefined ? {} : { session: this.clientSession };
    }
}

/** A Mongo session over a replica set: can run a batch inside a real multi-document transaction. */
export class ReplicaSetMongoDocumentSession extends MongoDocumentSession
{
    /**
     * Runs work inside a driver transaction. A transaction-bound session is handed to work; any throw
     * (e.g. a RollbackSignal) aborts the transaction and propagates, so the caller reports nothing applied.
     */
    public async Transaction<T>(work: (tx: IDocumentSession) => Promise<T>): Promise<T>
    {
        const clientSession = this.client.startSession();
        try
        {
            let outcome: T;
            await clientSession.withTransaction(async () =>
            {
                outcome = await work(new MongoDocumentSession(this.client, this.database, this.versionField, clientSession));
            });
            return outcome!;
        }
        finally
        {
            await clientSession.endSession();
        }
    }
}
