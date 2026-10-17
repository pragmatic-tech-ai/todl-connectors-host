import type { ExternalFieldValue } from "@pragmatic-tech-ai/todl";
import type { IDocumentSession, VersionState } from "../document/document-session.js";

/** In-memory document store. Find ignores the filter and returns every doc (the adapter re-filters). */
export class FakeDocumentSession implements IDocumentSession
{
    private static readonly VersionProperty = "rev";
    private static readonly IdProperty = "id";

    protected readonly store = new Map<string, Map<string, Record<string, unknown>>>();

    public Seed(collection: string, docs: Record<string, unknown>[]): this
    {
        const bucket = new Map<string, Record<string, unknown>>();
        for (const d of docs)
        {
            bucket.set(String(d[FakeDocumentSession.IdProperty]), { ...d });
        }
        this.store.set(collection, bucket);
        return this;
    }

    public async Find(collection: string, _filter: Record<string, unknown>): Promise<readonly Record<string, unknown>[]>
    {
        return [...(this.store.get(collection)?.values() ?? [])];
    }

    public async Upsert(collection: string, idField: string, key: unknown, doc: Record<string, unknown>): Promise<void>
    {
        const bucket = this.store.get(collection) ?? new Map<string, Record<string, unknown>>();
        this.store.set(collection, bucket);
        bucket.set(String(key), { ...doc, [idField]: key });
    }

    public async Delete(collection: string, _idField: string, key: unknown): Promise<boolean>
    {
        return this.store.get(collection)?.delete(String(key)) ?? false;
    }

    public async ReadVersionState(source: string, _idKey: string, key: ExternalFieldValue): Promise<VersionState>
    {
        const doc = this.store.get(source)?.get(String(key));
        if (doc === undefined)
        {
            return { Exists: false };
        }
        return { Exists: true, Version: (doc[FakeDocumentSession.VersionProperty] ?? null) as ExternalFieldValue | null };
    }

    /** Deep-copies the store so a transaction can roll back to this point. */
    protected Snapshot(): Map<string, Map<string, Record<string, unknown>>>
    {
        const copy = new Map<string, Map<string, Record<string, unknown>>>();
        for (const [collection, bucket] of this.store)
        {
            const clone = new Map<string, Record<string, unknown>>();
            for (const [key, doc] of bucket)
            {
                clone.set(key, { ...doc });
            }
            copy.set(collection, clone);
        }
        return copy;
    }

    /** Replaces the live store with a prior snapshot (rollback). */
    protected Restore(snapshot: Map<string, Map<string, Record<string, unknown>>>): void
    {
        this.store.clear();
        for (const [collection, bucket] of snapshot)
        {
            this.store.set(collection, bucket);
        }
    }
}

/** A fake that CAN transact: runs work against itself, restoring the pre-transaction snapshot if it throws. */
export class TransactionalFakeDocumentSession extends FakeDocumentSession
{
    public async Transaction<T>(work: (tx: IDocumentSession) => Promise<T>): Promise<T>
    {
        const snapshot = this.Snapshot();
        try
        {
            return await work(this);
        }
        catch (error)
        {
            this.Restore(snapshot);
            throw error;
        }
    }
}
