import { CypherAdapter } from "../cypher/cypher-adapter.js";
import type { CypherRow, ICypherSession } from "../cypher/cypher-session.js";

/** One statement the fake received, for assertions. */
export interface RecordedStatement
{
    readonly cypher: string;
    readonly params: Record<string, unknown>;
}

/** In-memory graph honoring the CypherAdapter's MATCH/MERGE/DETACH DELETE statements (dispatch by leading keyword). */
export class FakeCypherSession implements ICypherSession
{
    private static readonly SeedIdField = "id";
    private static readonly Empty = "";
    private static readonly ReturnMarker = ` ${CypherAdapter.Return} `;
    private static readonly Backtick = "`";
    private static readonly EscapedBacktick = "``";
    // (n:`Label` {`idField`: $key}) -- quoted names may contain doubled backticks.
    private static readonly QuotedName = "((?:[^`]|``)*)";
    private static readonly HeadPattern = new RegExp(
        "^(?:MATCH|MERGE) \\(n:`" + FakeCypherSession.QuotedName + "`(?: \\{`" + FakeCypherSession.QuotedName + "`:[^}]*\\})?\\)");
    private static readonly VersionFieldPattern = new RegExp("^n\\.`" + FakeCypherSession.QuotedName + "`");

    public readonly Statements: RecordedStatement[] = [];
    protected readonly store = new Map<string, Map<string, Record<string, unknown>>>();

    public Seed(label: string, records: Record<string, unknown>[]): this
    {
        const bucket = new Map<string, Record<string, unknown>>();
        for (const r of records)
        {
            bucket.set(String(r[FakeCypherSession.SeedIdField]), { ...r });
        }
        this.store.set(label, bucket);
        return this;
    }

    public async Run(cypher: string, params: Record<string, unknown>): Promise<readonly CypherRow[]>
    {
        this.Statements.push({ cypher, params });
        const head = FakeCypherSession.HeadPattern.exec(cypher);
        const label = FakeCypherSession.Unescape(head?.[1] ?? FakeCypherSession.Empty);
        const idField = FakeCypherSession.Unescape(head?.[2] ?? FakeCypherSession.SeedIdField);
        const tail = cypher.slice(head?.[0].length ?? 0).trimStart();
        const bucket = this.store.get(label);
        const key = String(params[CypherAdapter.KeyParam]);
        if (cypher.startsWith(CypherAdapter.Merge))
        {
            const live = bucket ?? new Map<string, Record<string, unknown>>();
            this.store.set(label, live);
            const fields = params[CypherAdapter.FieldsParam] as Record<string, unknown>;
            live.set(key, { ...(live.get(key) ?? {}), ...fields, [idField]: params[CypherAdapter.KeyParam] });
            return [];
        }
        if (tail.startsWith(CypherAdapter.DetachDelete))
        {
            bucket?.delete(key);
            return [];
        }
        // A paged read carries a WHERE clause before RETURN; skip it (the adapter re-applies Where in memory).
        const returnAt = tail.indexOf(FakeCypherSession.ReturnMarker);
        const afterWhere = tail.startsWith(CypherAdapter.Where) && returnAt >= 0 ? tail.slice(returnAt + 1) : tail;
        const returned = afterWhere.slice(CypherAdapter.Return.length).trimStart();
        const versionMatch = FakeCypherSession.VersionFieldPattern.exec(returned);
        if (versionMatch !== null)
        {
            const node = bucket?.get(key);
            const field = FakeCypherSession.Unescape(versionMatch[1]!);
            return node === undefined ? [] : [{ [CypherAdapter.VersionAlias]: node[field] ?? null }];
        }
        return [...(bucket?.values() ?? [])].map(props => ({ [CypherAdapter.PropsAlias]: props }));
    }

    /** Deep-copies the store so a transaction can roll back to this point. */
    protected Snapshot(): Map<string, Map<string, Record<string, unknown>>>
    {
        const copy = new Map<string, Map<string, Record<string, unknown>>>();
        for (const [label, bucket] of this.store)
        {
            const clone = new Map<string, Record<string, unknown>>();
            for (const [key, record] of bucket)
            {
                clone.set(key, { ...record });
            }
            copy.set(label, clone);
        }
        return copy;
    }

    /** Replaces the live store with a prior snapshot (rollback). */
    protected Restore(snapshot: Map<string, Map<string, Record<string, unknown>>>): void
    {
        this.store.clear();
        for (const [label, bucket] of snapshot)
        {
            this.store.set(label, bucket);
        }
    }

    private static Unescape(quoted: string): string
    {
        return quoted.replaceAll(FakeCypherSession.EscapedBacktick, FakeCypherSession.Backtick);
    }
}

/** A fake that CAN transact: runs work against itself, restoring the pre-transaction snapshot if it throws. */
export class TransactionalFakeCypherSession extends FakeCypherSession
{
    public async Transaction<T>(work: (tx: ICypherSession) => Promise<T>): Promise<T>
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

/**
 * A source-faithful fake for reads: a `MATCH (n:L) [WHERE ...] RETURN properties(n) AS props [ORDER BY n.k LIMIT ...]`
 * statement is answered as Neo4j would, evaluating each ANDed WHERE term (`=`, `<>`, `<`, `<=`, `>`, `>=`, `IN`,
 * `IS NULL`, `IS NOT NULL`, with Cypher's null semantics: a comparison with a missing or null property excludes the
 * row), ordering ascending and applying the limit. The base fake returns every node unfiltered (its own tests prove the
 * emitted Cypher instead); the external-connector conformance needs a source that really filters and pages, since
 * CypherAdapter trusts the source's WHERE. Writes and version probes behave as in the base fake.
 */
export class FilteringFakeCypherSession extends FakeCypherSession
{
    private static readonly ReadReturn = ` ${CypherAdapter.Return} ${CypherAdapter.PropertiesFn}(${CypherAdapter.NodeVar}) ${CypherAdapter.AsKeyword} ${CypherAdapter.PropsAlias}`;
    private static readonly WhereMarker = ` ${CypherAdapter.Where} `;
    private static readonly AndSeparator = ` ${CypherAdapter.And} `;
    private static readonly OrderByPattern = new RegExp(`${CypherAdapter.OrderBy} n\.\`((?:[^\`]|\`\`)*)\``);
    private static readonly LimitMarker = ` ${CypherAdapter.Limit} `;
    private static readonly TermPattern = /^n\.`((?:[^`]|``)*)` (IS NOT NULL|IS NULL|<>|<=|>=|=|<|>|IN)(?: \$(\w+))?$/;
    private static readonly ErrTerm = "FilteringFakeCypherSession cannot evaluate WHERE term: ";
    private static readonly IsNull = "IS NULL";
    private static readonly IsNotNull = "IS NOT NULL";
    private static readonly InOp = "IN";
    private static readonly LessOp = "<";
    private static readonly LessEqualOp = "<=";
    private static readonly Tick = "`";
    private static readonly DoubledTick = "``";

    public override async Run(cypher: string, params: Record<string, unknown>): Promise<readonly CypherRow[]>
    {
        const rows = await super.Run(cypher, params);
        const returnAt = cypher.indexOf(FilteringFakeCypherSession.ReadReturn);
        if (!cypher.startsWith(CypherAdapter.Match) || returnAt < 0)
        {
            return rows;
        }
        const whereAt = cypher.indexOf(FilteringFakeCypherSession.WhereMarker);
        const terms = whereAt < 0 || whereAt > returnAt
            ? []
            : cypher.slice(whereAt + FilteringFakeCypherSession.WhereMarker.length, returnAt).split(FilteringFakeCypherSession.AndSeparator);
        let matched = rows.filter(row => terms.every(term => FilteringFakeCypherSession.Holds(term, FilteringFakeCypherSession.Props(row), params)));
        const order = FilteringFakeCypherSession.OrderByPattern.exec(cypher.slice(returnAt));
        if (order !== null)
        {
            const key = FilteringFakeCypherSession.Name(order[1]!);
            matched = [...matched].sort((a, b) => FilteringFakeCypherSession.Ascending(FilteringFakeCypherSession.Props(a)[key], FilteringFakeCypherSession.Props(b)[key]));
        }
        if (cypher.includes(FilteringFakeCypherSession.LimitMarker))
        {
            matched = matched.slice(0, Number(params[CypherAdapter.LimitParam]));
        }
        return matched;
    }

    private static Props(row: CypherRow): Record<string, unknown>
    {
        return (row[CypherAdapter.PropsAlias] ?? {}) as Record<string, unknown>;
    }

    private static Holds(term: string, props: Record<string, unknown>, params: Record<string, unknown>): boolean
    {
        const match = FilteringFakeCypherSession.TermPattern.exec(term);
        if (match === null)
        {
            throw new Error(FilteringFakeCypherSession.ErrTerm + term);
        }
        const value = props[FilteringFakeCypherSession.Name(match[1]!)] ?? null;
        const op = match[2]!;
        if (op === FilteringFakeCypherSession.IsNull) return value === null;
        if (op === FilteringFakeCypherSession.IsNotNull) return value !== null;
        const operand = params[match[3]!];
        if (value === null) return false;
        if (op === FilteringFakeCypherSession.InOp) return (operand as unknown[]).some(v => v === value);
        if (operand === null || operand === undefined || typeof operand !== typeof value) return false;
        const order = FilteringFakeCypherSession.Ascending(value, operand);
        switch (op)
        {
            case CypherAdapter.EqualOp: return order === 0;
            case CypherAdapter.NotEqualOp: return order !== 0;
            case FilteringFakeCypherSession.LessOp: return order < 0;
            case FilteringFakeCypherSession.LessEqualOp: return order <= 0;
            case CypherAdapter.GreaterOp: return order > 0;
            default: return order >= 0;
        }
    }

    private static Name(quoted: string): string
    {
        return quoted.replaceAll(FilteringFakeCypherSession.DoubledTick, FilteringFakeCypherSession.Tick);
    }

    private static Ascending(a: unknown, b: unknown): number
    {
        if (a === b) return 0;
        return (a as string | number) < (b as string | number) ? -1 : 1;
    }
}
