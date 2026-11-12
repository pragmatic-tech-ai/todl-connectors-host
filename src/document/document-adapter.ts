import { ConnectionFailureKind, RollbackSignal, WriteAtomicity, WriteCapability, WriteConcurrency, WriteFailureKind, WriteOperationKind } from "@pragmatic-tech-ai/todl";
import type { ExternalFieldValue, ExternalRecord, IAssignedKey, IDataSourceAdapter, PageQuery, PageSlice, QueryRequest, WriteBatch, WriteFailure, WriteOperation, WriteResult } from "@pragmatic-tech-ai/todl";
import { ExternalQuery } from "../query/external-query.js";
import { MongoFilter } from "./mongo-filter.js";
import { DocumentIdentifier } from "./document-identifier.js";
import type { IDocumentSession } from "./document-session.js";

/** The result of applying one document op: a failure, or the source-assigned key of an insert; both absent means a plain success. */
interface IDocumentOpOutcome
{
    readonly Failure?: WriteFailure;
    readonly Assigned?: IAssignedKey;
}

/** Document adapter: Find to read (Where re-applied in-adapter), Insert/Upsert/Delete to write. */
export class DocumentAdapter implements IDataSourceAdapter
{
    private static readonly MongoIdKey = "_id";
    private static readonly InsertUnsupportedReason = "document insert requires the _id key (the source assigns _id)";
    private static readonly InvalidLimitMessage = "QueryPage Limit must be a positive integer";
    private static readonly MissingOrderKeyMessage = "QueryPage requires request.OrderKey or at least one field to order by";
    private static readonly VersionConflictReason = "version mismatch";
    private static readonly AtomicUnsupportedReason = "atomic write not supported by this connector";
    private static readonly OptimisticUnsupportedReason = "optimistic write not supported by this connector (its session cannot read versions)";

    private static readonly NetworkErrorNames: ReadonlySet<string> = new Set(["MongoNetworkError", "MongoServerSelectionError", "MongoNetworkTimeoutError"]);
    private static readonly TransientLabels: ReadonlySet<string> = new Set(["RetryableWriteError", "ResumableChangeStreamError"]);
    private static readonly AuthCodes: ReadonlySet<number> = new Set([18, 13]);

    public constructor(private readonly session: IDocumentSession)
    {
    }

    /** Whether this adapter can enforce an optimistic version guard: iff its session can {@link IDocumentSession.ReadVersionState}. */
    public get CanVersion(): boolean
    {
        return this.session.ReadVersionState !== undefined;
    }

    /** Whether this adapter supports keyset paging: always, via a sorted, limited, `$gt`-seeked Find. */
    public get CanPage(): boolean
    {
        return true;
    }

    /** Depends only on the driver error's name, errorLabels and numeric code; never stringifies the error or reads a secret. */
    public ClassifyFailure(error: unknown): ConnectionFailureKind
    {
        if (error === null || typeof error !== "object")
        {
            return ConnectionFailureKind.Permanent;
        }
        const e = error as { name?: unknown; errorLabels?: unknown; code?: unknown };
        if (typeof e.name === "string" && DocumentAdapter.NetworkErrorNames.has(e.name))
        {
            return ConnectionFailureKind.Transient;
        }
        if (Array.isArray(e.errorLabels) && e.errorLabels.some(l => typeof l === "string" && DocumentAdapter.TransientLabels.has(l)))
        {
            return ConnectionFailureKind.Transient;
        }
        if (typeof e.code === "number" && DocumentAdapter.AuthCodes.has(e.code))
        {
            return ConnectionFailureKind.Auth;
        }
        return ConnectionFailureKind.Permanent;
    }

    /** Whether this adapter can run a batch inside a backend transaction: true iff its session can. */
    public get CanTransact(): boolean
    {
        return this.session.Transaction !== undefined;
    }

    /** Whether this adapter can execute source-keyed inserts: iff its session exposes {@link IDocumentSession.Insert}. */
    public get CanAssignKeys(): boolean
    {
        return this.session.Insert !== undefined;
    }

    public async Query(request: QueryRequest): Promise<readonly ExternalRecord[]>
    {
        DocumentIdentifier.Validate(request.Source);
        const filter = MongoFilter.From(request.Where?.All ?? []);
        const docs = await this.session.Find(request.Source, filter);
        return ExternalQuery.Apply(docs, request);
    }

    /**
     * Keyset page: Find sorted ascending on the order key, strictly after page.After, limited to page.Limit.
     * NextAfter is the last fetched document's order-key value, only when a full page came back.
     */
    public async QueryPage(request: QueryRequest, page: PageQuery): Promise<PageSlice>
    {
        DocumentIdentifier.Validate(request.Source);
        if (!Number.isInteger(page.Limit) || page.Limit <= 0)
        {
            throw new Error(DocumentAdapter.InvalidLimitMessage);
        }
        const rawKey = request.OrderKey ?? request.Fields[0];
        if (rawKey === undefined)
        {
            throw new Error(DocumentAdapter.MissingOrderKeyMessage);
        }
        const orderKey = DocumentIdentifier.Validate(rawKey);
        const filter = MongoFilter.From(request.Where?.All ?? []);
        const docs = await this.session.Find(request.Source, filter, {
            Sort: { [orderKey]: 1 },
            After: page.After === undefined ? undefined : { Field: orderKey, Value: page.After },
            Limit: page.Limit,
        });
        const records = ExternalQuery.Apply(docs, request);
        const lastKey = docs.length === page.Limit ? docs[docs.length - 1]![orderKey] : undefined;
        if (lastKey == null)
        {
            return { Records: records };
        }
        return { Records: records, NextAfter: lastKey as ExternalFieldValue };
    }

    /** Dispatches on the batch's atomicity axis: resilient Sequential apply, or all-or-nothing Transactional. */
    public async Apply(batch: WriteBatch): Promise<WriteResult>
    {
        DocumentIdentifier.Validate(batch.Source);
        DocumentIdentifier.Validate(batch.IdKey);
        // Identifier guards are hard errors (injection safety), validated up front so a bad field name
        // rejects the whole Apply rather than degrading into a per-op soft WriteFailure.
        for (const op of batch.Operations)
        {
            for (const field of Object.keys(op.Fields))
            {
                DocumentIdentifier.Validate(field);
            }
        }
        if (batch.Concurrency === WriteConcurrency.Optimistic && !WriteCapability.CanVersion(this))
        {
            // Fail closed: a session that cannot probe versions must never run an Optimistic batch unguarded.
            return DocumentAdapter.AllFailures(batch, WriteFailureKind.Unsupported, DocumentAdapter.OptimisticUnsupportedReason);
        }
        if (batch.Atomicity === WriteAtomicity.Transactional)
        {
            return this.ApplyTransactional(batch);
        }
        return this.ApplySequential(batch);
    }

    public async Dispose(): Promise<void>
    {
        await this.session.Dispose?.();
    }

    /**
     * Sequential resilient apply: runs ops in order; a thrown driver fault becomes a WriteFailure{Error}
     * and the batch CONTINUES to the next op (no rollback). Applied counts only ops that persisted.
     */
    private async ApplySequential(batch: WriteBatch): Promise<WriteResult>
    {
        return this.RunOps(this.session, batch);
    }

    /**
     * Runs every op of `batch` in order against `session`, collecting failures and source-assigned keys. W20: an
     * applied insert's key is reported under its Ref, so a later op's failure never orphans the inserts that applied.
     */
    private async RunOps(session: IDocumentSession, batch: WriteBatch): Promise<WriteResult>
    {
        let applied = 0;
        const failures: WriteFailure[] = [];
        const assigned: IAssignedKey[] = [];
        for (const op of batch.Operations)
        {
            const outcome = await this.ApplyOne(session, batch, op);
            if (outcome.Failure !== undefined)
            {
                failures.push(outcome.Failure);
            }
            else
            {
                applied++;
                if (outcome.Assigned !== undefined)
                {
                    assigned.push(outcome.Assigned);
                }
            }
        }
        return assigned.length === 0 ? { Applied: applied, Failures: failures } : { Applied: applied, Failures: failures, Assigned: assigned };
    }

    /**
     * Transactional all-or-nothing apply. A backend that cannot transact returns every op as Unsupported
     * (never a silent downgrade to partial). Otherwise the whole op loop runs inside one session
     * transaction; any Conflict or Error throws a RollbackSignal to abort it, caught here so the collected
     * failures come back with Applied 0 (an atomic adapter applies nothing on a mid-batch failure).
     */
    private async ApplyTransactional(batch: WriteBatch): Promise<WriteResult>
    {
        if (!WriteCapability.CanTransact(this))
        {
            return DocumentAdapter.AllFailures(batch, WriteFailureKind.Unsupported, DocumentAdapter.AtomicUnsupportedReason);
        }
        try
        {
            return await this.session.Transaction!(async (tx) =>
            {
                const result = await this.RunOps(tx, batch);
                if (result.Failures.length > 0)
                {
                    // Abort the backend transaction; the caller reports nothing as applied.
                    throw new RollbackSignal({ Applied: 0, Failures: result.Failures });
                }
                return result;
            });
        }
        catch (error)
        {
            if (error instanceof RollbackSignal)
            {
                return error.Result;
            }
            throw error;
        }
    }

    /**
     * Applies one op against a given session (so Sequential and Transactional share the logic):
     * returns {} on success, { Assigned } for an insert, or { Failure } (Conflict for a version-guarded no-op,
     * Unsupported for a non-_id insert, Error for a thrown driver fault) otherwise.
     */
    private async ApplyOne(session: IDocumentSession, batch: WriteBatch, op: WriteOperation): Promise<IDocumentOpOutcome>
    {
        try
        {
            if (op.Kind === WriteOperationKind.Insert)
            {
                return await this.ApplyInsert(session, batch, op);
            }
            if (op.Kind === WriteOperationKind.Delete)
            {
                return await this.ApplyDelete(session, batch, op)
                    ? {}
                    : { Failure: { Key: op.Key, Kind: WriteFailureKind.Conflict, Reason: DocumentAdapter.VersionConflictReason } };
            }
            return await this.ApplyUpsert(session, batch, op)
                ? {}
                : { Failure: { Key: op.Key, Kind: WriteFailureKind.Conflict, Reason: DocumentAdapter.VersionConflictReason } };
        }
        catch (error)
        {
            return { Failure: { Key: op.Key, Kind: WriteFailureKind.Error, Reason: DocumentAdapter.ErrorReason(error) } };
        }
    }

    /**
     * Runs one source-keyed insert: supported only when the batch's IdKey is `_id` (Mongo assigns `_id`; any other
     * key is not source-assigned here), through {@link IDocumentSession.Insert}. The assigned `_id` ObjectId is
     * reported as its hex string under the op's Ref.
     */
    private async ApplyInsert(session: IDocumentSession, batch: WriteBatch, op: WriteOperation): Promise<IDocumentOpOutcome>
    {
        if (batch.IdKey !== DocumentAdapter.MongoIdKey || session.Insert === undefined)
        {
            return { Failure: { Key: op.Key, Kind: WriteFailureKind.Unsupported, Reason: DocumentAdapter.InsertUnsupportedReason } };
        }
        const insertedId = await session.Insert(batch.Source, { ...op.Fields });
        return { Assigned: { Ref: op.Ref!, Key: DocumentAdapter.HexKey(insertedId) } };
    }

    /** An assigned `_id` as an external key: a Mongo ObjectId via toHexString(), else its string form. */
    private static HexKey(id: unknown): ExternalFieldValue
    {
        if (id !== null && typeof id === "object" && typeof (id as { toHexString?: unknown }).toHexString === "function")
        {
            return (id as { toHexString(): string }).toHexString();
        }
        return String(id);
    }

    /**
     * Runs one delete against the given session; returns false when a version-guarded delete must not apply.
     * An Optimistic delete probes ReadVersionState first: a present document whose stored version is null, differs
     * from op.Version, or is deleted with a null op.Version is a Conflict (fail-closed); an absent document has
     * nothing to delete.
     */
    private async ApplyDelete(session: IDocumentSession, batch: WriteBatch, op: WriteOperation): Promise<boolean>
    {
        if (batch.Concurrency === WriteConcurrency.Optimistic && batch.VersionField !== undefined)
        {
            const state = await session.ReadVersionState!(batch.Source, batch.IdKey, op.Key, batch.VersionField);
            if (state.Exists)
            {
                const incoming = op.Version ?? null;
                if (state.Version === null || incoming === null || state.Version !== incoming)
                {
                    return false;
                }
            }
        }
        await session.Delete(batch.Source, batch.IdKey, op.Key);
        return true;
    }

    /** Runs one upsert against the given session; returns false when a version-guarded upsert must not apply. */
    private async ApplyUpsert(session: IDocumentSession, batch: WriteBatch, op: WriteOperation): Promise<boolean>
    {
        if (batch.Concurrency === WriteConcurrency.Optimistic && batch.VersionField !== undefined)
        {
            const state = await session.ReadVersionState!(batch.Source, batch.IdKey, op.Key, batch.VersionField);
            if (state.Exists)
            {
                // Apply only when a present row's stored version matches op.Version with BOTH non-null.
                // A present-but-unversioned row (stored null), a null incoming version, or any difference
                // is a Conflict -- never a silent overwrite (the #7 fail-closed fix).
                const incoming = op.Version ?? null;
                if (state.Version === null || incoming === null || state.Version !== incoming)
                {
                    return false;
                }
            }
            // Exists:false -> absent -> writable (optimistic insert).
        }
        // LastWriteWins (or an absent/matching optimistic row): unconditional upsert, incoming overwrites.
        await session.Upsert(batch.Source, batch.IdKey, op.Key, { ...op.Fields, [batch.IdKey]: op.Key });
        return true;
    }

    /** Every op of the batch failed with the same kind and reason; nothing applied. */
    private static AllFailures(batch: WriteBatch, kind: WriteFailureKind, reason: string): WriteResult
    {
        return { Applied: 0, Failures: batch.Operations.map(op => ({ Key: op.Key, Kind: kind, Reason: reason })) };
    }

    private static ErrorReason(error: unknown): string
    {
        return error instanceof Error ? error.message : String(error);
    }
}
