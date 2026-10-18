import { ConnectionFailureKind, RollbackSignal, WriteAtomicity, WriteCapability, WriteConcurrency, WriteFailureKind, WriteOperationKind } from "@pragmatic-tech-ai/todl";
import type { ExternalFieldValue, ExternalRecord, IDataSourceAdapter, PageQuery, PageSlice, QueryRequest, WriteBatch, WriteFailure, WriteOperation, WriteResult } from "@pragmatic-tech-ai/todl";
import { ExternalQuery } from "../query/external-query.js";
import { MongoFilter } from "./mongo-filter.js";
import { DocumentIdentifier } from "./document-identifier.js";
import type { IDocumentSession } from "./document-session.js";

/** Document adapter: Find to read (Where re-applied in-adapter), Upsert/Delete to write. */
export class DocumentAdapter implements IDataSourceAdapter
{
    private static readonly InvalidLimitMessage = "QueryPage Limit must be a positive integer";
    private static readonly MissingOrderKeyMessage = "QueryPage requires request.OrderKey or at least one field to order by";
    private static readonly VersionConflictReason = "version mismatch";
    private static readonly AtomicUnsupportedReason = "atomic write not supported by this connector";

    private static readonly NetworkErrorNames: ReadonlySet<string> = new Set(["MongoNetworkError", "MongoServerSelectionError", "MongoNetworkTimeoutError"]);
    private static readonly TransientLabels: ReadonlySet<string> = new Set(["RetryableWriteError", "ResumableChangeStreamError"]);
    private static readonly AuthCodes: ReadonlySet<number> = new Set([18, 13]);

    public constructor(private readonly session: IDocumentSession)
    {
    }

    /** Whether this adapter can enforce an optimistic version guard: always, via {@link IDocumentSession.ReadVersionState}. */
    public get CanVersion(): boolean
    {
        return true;
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
        let applied = 0;
        const failures: WriteFailure[] = [];
        for (const op of batch.Operations)
        {
            const failure = await this.ApplyOne(this.session, batch, op);
            if (failure === undefined)
            {
                applied++;
            }
            else
            {
                failures.push(failure);
            }
        }
        return { Applied: applied, Failures: failures };
    }

    /**
     * Transactional all-or-nothing apply. A backend that cannot transact returns every op as Unsupported
     * (never a silent downgrade to partial). Otherwise the whole op loop runs inside one session
     * transaction; any Conflict or Error throws a RollbackSignal to abort it, caught here so the collected
     * failures come back with Applied 0.
     */
    private async ApplyTransactional(batch: WriteBatch): Promise<WriteResult>
    {
        if (!WriteCapability.CanTransact(this))
        {
            return {
                Applied: 0,
                Failures: batch.Operations.map(op => ({
                    Key: op.Key,
                    Kind: WriteFailureKind.Unsupported,
                    Reason: DocumentAdapter.AtomicUnsupportedReason,
                })),
            };
        }
        try
        {
            return await this.session.Transaction!(async (tx) =>
            {
                let applied = 0;
                const failures: WriteFailure[] = [];
                for (const op of batch.Operations)
                {
                    const failure = await this.ApplyOne(tx, batch, op);
                    if (failure === undefined)
                    {
                        applied++;
                    }
                    else
                    {
                        failures.push(failure);
                    }
                }
                if (failures.length > 0)
                {
                    // Abort the backend transaction; the caller reports nothing as applied.
                    throw new RollbackSignal({ Applied: 0, Failures: failures });
                }
                return { Applied: applied, Failures: failures };
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
     * returns undefined on success, or the WriteFailure (Conflict for a version-guarded no-op, Error for
     * a thrown driver fault) otherwise.
     */
    private async ApplyOne(session: IDocumentSession, batch: WriteBatch, op: WriteOperation): Promise<WriteFailure | undefined>
    {
        try
        {
            if (op.Kind === WriteOperationKind.Delete)
            {
                // Delete is unconditional in v1: no version guard.
                await session.Delete(batch.Source, batch.IdKey, op.Key);
                return undefined;
            }
            if (await this.ApplyUpsert(session, batch, op))
            {
                return undefined;
            }
            return { Key: op.Key, Kind: WriteFailureKind.Conflict, Reason: DocumentAdapter.VersionConflictReason };
        }
        catch (error)
        {
            return { Key: op.Key, Kind: WriteFailureKind.Error, Reason: DocumentAdapter.ErrorReason(error) };
        }
    }

    /** Runs one upsert against the given session; returns false when a version-guarded upsert must not apply. */
    private async ApplyUpsert(session: IDocumentSession, batch: WriteBatch, op: WriteOperation): Promise<boolean>
    {
        if (batch.Concurrency === WriteConcurrency.Optimistic && batch.VersionField !== undefined)
        {
            const state = await session.ReadVersionState!(batch.Source, batch.IdKey, op.Key);
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

    private static ErrorReason(error: unknown): string
    {
        return error instanceof Error ? error.message : String(error);
    }
}
