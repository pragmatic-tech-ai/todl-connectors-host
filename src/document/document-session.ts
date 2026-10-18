import type { ExternalFieldValue } from "@pragmatic-tech-ai/todl";

/**
 * The versioning state of one document, probed via a single read. Distinguishes an absent
 * document ({@link VersionState.Exists} false) from a present one, and for a present document
 * carries its stored version (or null when the document has no version field). This lets the
 * adapter fail CLOSED on a present-but-unversioned record instead of silently overwriting it.
 */
export type VersionState =
    | { Exists: false }
    | { Exists: true; Version: ExternalFieldValue | null };

/** Optional keyset-paging controls for {@link IDocumentSession.Find}; absent means an unpaged find. */
export interface DocumentFindOptions
{
    Sort?: Record<string, 1 | -1>;
    /** Strict seek: only documents whose Field is greater than Value. */
    After?: { Field: string; Value: ExternalFieldValue };
    Limit?: number;
}

/** Injected document-store seam (Mongo-shaped). The adapter owns semantics; the host owns the driver. */
export interface IDocumentSession
{
    Find(collection: string, filter: Record<string, unknown>, options?: DocumentFindOptions): Promise<readonly Record<string, unknown>[]>;
    Upsert(collection: string, idField: string, key: unknown, doc: Record<string, unknown>): Promise<void>;
    Delete(collection: string, idField: string, key: unknown): Promise<boolean>;
    /** Probes a document's existence and stored version in one read (absent vs present-unversioned vs versioned). */
    ReadVersionState?(source: string, idKey: string, key: ExternalFieldValue): Promise<VersionState>;
    /** Runs work inside a backend transaction; present only when the deployment can transact (e.g. a replica set). */
    Transaction?<T>(work: (tx: IDocumentSession) => Promise<T>): Promise<T>;
    Dispose?(): Promise<void>;
}
