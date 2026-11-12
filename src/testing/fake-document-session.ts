import type { ExternalFieldValue } from "@pragmatic-tech-ai/todl";
import type { DocumentFindOptions, IDocumentSession, VersionState } from "../document/document-session.js";

/**
 * In-memory document store. Find ignores the filter (the adapter re-filters every read in memory) but honours the
 * options as the driver does: Sort orders by its fields, After keeps only documents whose Field is strictly greater than
 * Value (a missing or null field never is, as with `$gt`), and Limit caps the result. Because the filter is ignored, a
 * filtered page may come back sparser than the driver's, but a drain still visits every matching document, since the
 * adapter takes its NextAfter from the unfiltered page.
 */
export class FakeDocumentSession implements IDocumentSession
{
    public static readonly FailField = "__fail";
    private static readonly IdProperty = "id";
    private static readonly MongoIdProperty = "_id";
    private static readonly InsertFailMessage = "document insert rejected";
    private nextInsertId = 0;

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

    public async Find(collection: string, _filter: Record<string, unknown>, options?: DocumentFindOptions): Promise<readonly Record<string, unknown>[]>
    {
        let docs = [...(this.store.get(collection)?.values() ?? [])];
        const after = options?.After;
        if (after !== undefined)
        {
            docs = docs.filter(d => FakeDocumentSession.Order(d[after.Field] ?? null, after.Value) > 0);
        }
        for (const [field, direction] of Object.entries(options?.Sort ?? {}).reverse())
        {
            docs.sort((a, b) => direction * FakeDocumentSession.Order(a[field] ?? null, b[field] ?? null));
        }
        return options?.Limit === undefined ? docs : docs.slice(0, options.Limit);
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

    /**
     * Inserts a document and returns an ObjectId-like assigned `_id` (an object with toHexString, as the Mongo driver
     * returns), stored under that hex key. A FailField marker throws, as a driver fault would.
     */
    public async Insert(collection: string, doc: Record<string, unknown>): Promise<unknown>
    {
        if (FakeDocumentSession.FailField in doc)
        {
            throw new Error(FakeDocumentSession.InsertFailMessage);
        }
        const hex = (++this.nextInsertId).toString(16).padStart(24, "0");
        const bucket = this.store.get(collection) ?? new Map<string, Record<string, unknown>>();
        this.store.set(collection, bucket);
        bucket.set(hex, { ...doc, [FakeDocumentSession.MongoIdProperty]: hex });
        return { toHexString: () => hex };
    }

    /** Reads the version from the caller's versionField, as the Mongo session does (no hard-coded field to mask a drift). */
    public async ReadVersionState(source: string, _idKey: string, key: ExternalFieldValue, versionField: string): Promise<VersionState>
    {
        const doc = this.store.get(source)?.get(String(key));
        if (doc === undefined)
        {
            return { Exists: false };
        }
        return { Exists: true, Version: (doc[versionField] ?? null) as ExternalFieldValue | null };
    }

    /** Ascending order with nulls first; a null never compares greater, so a strict seek drops it. */
    private static Order(a: unknown, b: unknown): number
    {
        if (a === b) return 0;
        if (a === null) return -1;
        if (b === null) return 1;
        return (a as string | number) < (b as string | number) ? -1 : 1;
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
