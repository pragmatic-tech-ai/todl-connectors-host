import type { IDocumentSession } from "../document/document-session.js";

/** In-memory document store. Find ignores the filter and returns every doc (the adapter re-filters). */
export class FakeDocumentSession implements IDocumentSession
{
    private static readonly VersionProperty = "rev";
    private static readonly IdProperty = "id";

    private readonly store = new Map<string, Map<string, Record<string, unknown>>>();

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

    public async ReadVersion(collection: string, _idField: string, key: unknown): Promise<unknown>
    {
        return this.store.get(collection)?.get(String(key))?.[FakeDocumentSession.VersionProperty] ?? null;
    }
}
