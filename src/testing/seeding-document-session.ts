import type { ExternalFieldValue } from "@pragmatic-tech-ai/todl";
import type { DocumentFindOptions, IDocumentSession, VersionState } from "../document/document-session.js";
import type { MongoDocumentSession } from "../document/mongo-document-session.js";

/**
 * A live Mongo session that resets collection `collection` to the fixture seed { id: 'c1', label: 'Acme' } before its
 * first use, so each contract case starts isolated. Live files that run concurrently pass distinct collection names, so
 * one file's reset never deletes another's rows. Transaction is forwarded only when the wrapped session can transact (a
 * replica-set session), so CanTransact mirrors the real one.
 */
export class SeedingDocumentSession implements IDocumentSession
{
    public static readonly DefaultCollection = "Customer";
    private static readonly IdField = "id";
    private static readonly LabelField = "label";
    private static readonly SeedId = "c1";
    private static readonly SeedLabel = "Acme";

    private seeded: Promise<void> | undefined;

    public readonly Transaction?: <T>(work: (tx: IDocumentSession) => Promise<T>) => Promise<T>;

    public constructor(private readonly inner: MongoDocumentSession, private readonly collection: string = SeedingDocumentSession.DefaultCollection)
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

    public async ReadVersionState(source: string, idKey: string, key: ExternalFieldValue, versionField: string): Promise<VersionState>
    {
        await this.EnsureSeeded();
        return this.inner.ReadVersionState(source, idKey, key, versionField);
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
        const S = SeedingDocumentSession;
        for (const doc of await this.inner.Find(this.collection, {}))
        {
            await this.inner.Delete(this.collection, S.IdField, doc[S.IdField]);
        }
        await this.inner.Upsert(this.collection, S.IdField, S.SeedId, { [S.IdField]: S.SeedId, [S.LabelField]: S.SeedLabel });
    }
}
