import { ConnectionFailureKind, QueryCompareOp, RollbackSignal, WriteAtomicity, WriteCapability, WriteConcurrency, WriteFailureKind, WriteOperationKind } from "@pragmatic-tech-ai/todl";
import type { ExternalFieldValue, ExternalRecord, IDataSourceAdapter, PageQuery, PageSlice, QueryComparison, QueryRequest, WriteBatch, WriteFailure, WriteOperation, WriteResult } from "@pragmatic-tech-ai/todl";
import { ExternalQuery } from "../query/external-query.js";
import { CypherIdentifier } from "./cypher-identifier.js";
import type { ICypherSession } from "./cypher-session.js";

/** The versioning state of one graph node, probed via a single MATCH: absent, or present with its
 *  stored version (null when the node carries no value for the version property). Lets the adapter
 *  fail CLOSED on a present-but-unversioned node rather than silently overwriting it. */
type NodeVersionState =
    | { Exists: false }
    | { Exists: true; Version: unknown };

/** Graph adapter: MATCH to read (Where is re-applied in-adapter for Query; for QueryPage it is pushed to the source for keyset paging), MERGE/DETACH DELETE to write. */
export class CypherAdapter implements IDataSourceAdapter
{
    public static readonly NodeVar = "n";
    public static readonly PropsAlias = "props";
    public static readonly VersionAlias = "ver";
    public static readonly KeyParam = "key";
    public static readonly FieldsParam = "fields";
    public static readonly Match = "MATCH";
    public static readonly Merge = "MERGE";
    public static readonly SetClause = "SET";
    public static readonly Return = "RETURN";
    public static readonly DetachDelete = "DETACH DELETE";
    public static readonly PropertiesFn = "properties";
    public static readonly AsKeyword = "AS";
    public static readonly ParamPrefix = "$";
    public static readonly OpenParen = "(";
    public static readonly CloseParen = ")";
    public static readonly OpenBrace = "{";
    public static readonly CloseBrace = "}";
    public static readonly Colon = ":";
    public static readonly Space = " ";
    public static readonly Dot = ".";
    public static readonly MergeAssign = "+=";
    public static readonly Where = "WHERE";
    public static readonly And = "AND";
    public static readonly OrderBy = "ORDER BY";
    public static readonly Limit = "LIMIT";
    public static readonly AfterParam = "after";
    public static readonly LimitParam = "limit";
    public static readonly WhereParamPrefix = "w";
    public static readonly GreaterOp = ">";
    public static readonly EqualOp = "=";
    public static readonly NotEqualOp = "<>";
    public static readonly ToIntegerFn = "toInteger";
    private static readonly InvalidLimitMessage = "QueryPage Limit must be a positive integer";
    private static readonly MissingOrderKeyMessage = "QueryPage requires request.OrderKey or at least one field to order by";
    private static readonly VersionConflictReason = "version mismatch";
    private static readonly AtomicUnsupportedReason = "atomic write not supported by this connector";

    private static readonly TransientCodes: ReadonlySet<string> = new Set(["ServiceUnavailable", "SessionExpired"]);
    private static readonly TransientPrefix = "Neo.TransientError.";
    private static readonly AuthPrefix = "Neo.ClientError.Security.";

    public constructor(private readonly session: ICypherSession)
    {
    }

    /** Whether this adapter can enforce an optimistic version guard: always, via a MATCH version probe. */
    public get CanVersion(): boolean
    {
        return true;
    }

    /** Whether this adapter supports keyset paging: always, via an ORDER BY / LIMIT / `>`-seeked MATCH. */
    public get CanPage(): boolean
    {
        return true;
    }

    /** Depends only on the driver error's string code; never stringifies the error or reads a secret. */
    public ClassifyFailure(error: unknown): ConnectionFailureKind
    {
        const code = (error !== null && typeof error === "object") ? (error as { code?: unknown }).code : undefined;
        if (typeof code !== "string")
        {
            return ConnectionFailureKind.Permanent;
        }
        if (CypherAdapter.TransientCodes.has(code) || code.startsWith(CypherAdapter.TransientPrefix))
        {
            return ConnectionFailureKind.Transient;
        }
        if (code.startsWith(CypherAdapter.AuthPrefix))
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
        const v = CypherAdapter.NodeVar;
        const label = CypherIdentifier.Quote(request.Source);
        const cypher = [CypherAdapter.Match, `${CypherAdapter.OpenParen}${v}${CypherAdapter.Colon}${label}${CypherAdapter.CloseParen}`,
            CypherAdapter.Return, `${CypherAdapter.PropertiesFn}${CypherAdapter.OpenParen}${v}${CypherAdapter.CloseParen}`,
            CypherAdapter.AsKeyword, CypherAdapter.PropsAlias].join(CypherAdapter.Space);
        const rows = await this.session.Run(cypher, {});
        const records = rows.map(r => (r[CypherAdapter.PropsAlias] ?? {}) as Record<string, unknown>);
        return ExternalQuery.Apply(records, request);
    }

    /**
     * Keyset page: MATCH with the Where terms and a strict `n.key > $after` seek ANDed, ordered ascending on
     * the key and limited to page.Limit at the source. Where is trusted to the source (not re-applied in
     * memory). NextAfter is the last fetched node's key, only when a full page came back.
     *
     * The order key MUST be unique and non-null for keyset paging: a non-unique key skips duplicates at
     * page boundaries; a null/missing key is dropped after page 1 (`>` excludes null) and a null last key
     * ends paging.
     */
    public async QueryPage(request: QueryRequest, page: PageQuery): Promise<PageSlice>
    {
        if (!Number.isInteger(page.Limit) || page.Limit <= 0)
        {
            throw new Error(CypherAdapter.InvalidLimitMessage);
        }
        const rawKey = request.OrderKey ?? request.Fields[0];
        if (rawKey === undefined)
        {
            throw new Error(CypherAdapter.MissingOrderKeyMessage);
        }
        const v = CypherAdapter.NodeVar;
        const keyRef = `${v}${CypherAdapter.Dot}${CypherIdentifier.Quote(rawKey)}`;
        const label = CypherIdentifier.Quote(request.Source);
        const params: Record<string, unknown> = {};
        const terms: string[] = [];
        if (page.After !== undefined)
        {
            terms.push([keyRef, CypherAdapter.GreaterOp, `${CypherAdapter.ParamPrefix}${CypherAdapter.AfterParam}`].join(CypherAdapter.Space));
            params[CypherAdapter.AfterParam] = page.After;
        }
        (request.Where?.All ?? []).forEach((c, i) =>
        {
            const name = `${CypherAdapter.WhereParamPrefix}${i}`;
            terms.push(CypherAdapter.WhereTerm(c, name));
            params[name] = c.Value;
        });
        params[CypherAdapter.LimitParam] = page.Limit;
        const parts = [CypherAdapter.Match, `${CypherAdapter.OpenParen}${v}${CypherAdapter.Colon}${label}${CypherAdapter.CloseParen}`];
        if (terms.length > 0)
        {
            parts.push(CypherAdapter.Where, terms.join(`${CypherAdapter.Space}${CypherAdapter.And}${CypherAdapter.Space}`));
        }
        parts.push(CypherAdapter.Return, `${CypherAdapter.PropertiesFn}${CypherAdapter.OpenParen}${v}${CypherAdapter.CloseParen}`,
            CypherAdapter.AsKeyword, CypherAdapter.PropsAlias, CypherAdapter.OrderBy, keyRef, CypherAdapter.Limit,
            `${CypherAdapter.ToIntegerFn}${CypherAdapter.OpenParen}${CypherAdapter.ParamPrefix}${CypherAdapter.LimitParam}${CypherAdapter.CloseParen}`);
        const rows = await this.session.Run(parts.join(CypherAdapter.Space), params);
        const raw = rows.map(r => (r[CypherAdapter.PropsAlias] ?? {}) as Record<string, unknown>);
        // Where is already enforced at the source; project only (no in-memory re-filter, which could drop source-matched rows).
        const records = ExternalQuery.Apply(raw, { ...request, Where: undefined });
        const lastKey = raw.length === page.Limit ? raw[raw.length - 1]![rawKey] : undefined;
        if (lastKey == null)
        {
            return { Records: records };
        }
        return { Records: records, NextAfter: lastKey as ExternalFieldValue };
    }

    private static WhereTerm(c: QueryComparison, param: string): string
    {
        const op = c.Op === QueryCompareOp.Neq ? CypherAdapter.NotEqualOp : CypherAdapter.EqualOp;
        return [`${CypherAdapter.NodeVar}${CypherAdapter.Dot}${CypherIdentifier.Quote(c.Field)}`, op, `${CypherAdapter.ParamPrefix}${param}`].join(CypherAdapter.Space);
    }

    /** Dispatches on the batch's atomicity axis: resilient Sequential apply, or all-or-nothing Transactional. */
    public async Apply(batch: WriteBatch): Promise<WriteResult>
    {
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
                    Reason: CypherAdapter.AtomicUnsupportedReason,
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
    private async ApplyOne(session: ICypherSession, batch: WriteBatch, op: WriteOperation): Promise<WriteFailure | undefined>
    {
        try
        {
            if (op.Kind === WriteOperationKind.Delete)
            {
                // Delete is unconditional in v1: no version guard.
                await this.Delete(session, batch, op);
                return undefined;
            }
            if (await this.ApplyUpsert(session, batch, op))
            {
                return undefined;
            }
            return { Key: op.Key, Kind: WriteFailureKind.Conflict, Reason: CypherAdapter.VersionConflictReason };
        }
        catch (error)
        {
            return { Key: op.Key, Kind: WriteFailureKind.Error, Reason: CypherAdapter.ErrorReason(error) };
        }
    }

    private IdPattern(batch: WriteBatch): string
    {
        const label = CypherIdentifier.Quote(batch.Source);
        const idKey = CypherIdentifier.Quote(batch.IdKey);
        const param = `${CypherAdapter.ParamPrefix}${CypherAdapter.KeyParam}`;
        return `${CypherAdapter.OpenParen}${CypherAdapter.NodeVar}${CypherAdapter.Colon}${label}${CypherAdapter.Space}`
            + `${CypherAdapter.OpenBrace}${idKey}${CypherAdapter.Colon}${CypherAdapter.Space}${param}${CypherAdapter.CloseBrace}${CypherAdapter.CloseParen}`;
    }

    /** Runs one upsert against the given session; returns false when a version-guarded upsert must not apply. */
    private async ApplyUpsert(session: ICypherSession, batch: WriteBatch, op: WriteOperation): Promise<boolean>
    {
        if (batch.Concurrency === WriteConcurrency.Optimistic && batch.VersionField !== undefined)
        {
            const state = await this.ReadVersionState(session, batch, op);
            if (state.Exists)
            {
                // Apply only when a present node's stored version matches op.Version with BOTH non-null.
                // A present-but-unversioned node (stored null), a null incoming version, or any difference
                // is a Conflict -- never a silent overwrite (the #7 fail-closed fix).
                const incoming = op.Version ?? null;
                if (state.Version === null || incoming === null || state.Version !== incoming)
                {
                    return false;
                }
            }
            // Exists:false -> absent -> writable (optimistic insert).
        }
        const cypher = [CypherAdapter.Merge, this.IdPattern(batch), CypherAdapter.SetClause, CypherAdapter.NodeVar,
            CypherAdapter.MergeAssign, `${CypherAdapter.ParamPrefix}${CypherAdapter.FieldsParam}`].join(CypherAdapter.Space);
        const fields: Record<string, unknown> = { ...op.Fields, [batch.IdKey]: op.Key };
        await session.Run(cypher, { [CypherAdapter.KeyParam]: op.Key, [CypherAdapter.FieldsParam]: fields });
        return true;
    }

    /**
     * Probes a node in a single MATCH, distinguishing three states so the adapter can fail CLOSED:
     * absent (zero rows -> Exists:false), present-but-unversioned (Version null), and versioned
     * (Version is the stored value).
     */
    private async ReadVersionState(session: ICypherSession, batch: WriteBatch, op: WriteOperation): Promise<NodeVersionState>
    {
        const versionField = CypherIdentifier.Quote(batch.VersionField!);
        const cypher = [CypherAdapter.Match, this.IdPattern(batch), CypherAdapter.Return,
            `${CypherAdapter.NodeVar}${CypherAdapter.Dot}${versionField}`, CypherAdapter.AsKeyword, CypherAdapter.VersionAlias].join(CypherAdapter.Space);
        const rows = await session.Run(cypher, { [CypherAdapter.KeyParam]: op.Key });
        if (rows.length === 0)
        {
            return { Exists: false };
        }
        return { Exists: true, Version: rows[0]![CypherAdapter.VersionAlias] ?? null };
    }

    private async Delete(session: ICypherSession, batch: WriteBatch, op: WriteOperation): Promise<void>
    {
        const cypher = [CypherAdapter.Match, this.IdPattern(batch), CypherAdapter.DetachDelete, CypherAdapter.NodeVar].join(CypherAdapter.Space);
        await session.Run(cypher, { [CypherAdapter.KeyParam]: op.Key });
    }

    private static ErrorReason(error: unknown): string
    {
        return error instanceof Error ? error.message : String(error);
    }
}
