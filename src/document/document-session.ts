/** Injected document-store seam (Mongo-shaped). The adapter owns semantics; the host owns the driver. */
export interface IDocumentSession
{
    Find(collection: string, filter: Record<string, unknown>): Promise<readonly Record<string, unknown>[]>;
    Upsert(collection: string, idField: string, key: unknown, doc: Record<string, unknown>): Promise<void>;
    Delete(collection: string, idField: string, key: unknown): Promise<boolean>;
    ReadVersion?(collection: string, idField: string, key: unknown): Promise<unknown>;
    Dispose?(): Promise<void>;
}
