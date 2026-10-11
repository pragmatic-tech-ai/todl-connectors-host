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
    private static readonly Backtick = "`";
    private static readonly EscapedBacktick = "``";
    // (n:`Label` {`idField`: $key}) -- quoted names may contain doubled backticks.
    private static readonly QuotedName = "((?:[^`]|``)*)";
    private static readonly HeadPattern = new RegExp(
        "^(?:MATCH|MERGE) \\(n:`" + FakeCypherSession.QuotedName + "`(?: \\{`" + FakeCypherSession.QuotedName + "`:[^}]*\\})?\\)");
    private static readonly VersionFieldPattern = new RegExp("^n\\.`" + FakeCypherSession.QuotedName + "`");

    public readonly Statements: RecordedStatement[] = [];
    private readonly store = new Map<string, Map<string, Record<string, unknown>>>();

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
        const returned = tail.slice(CypherAdapter.Return.length).trimStart();
        const versionMatch = FakeCypherSession.VersionFieldPattern.exec(returned);
        if (versionMatch !== null)
        {
            const node = bucket?.get(key);
            const field = FakeCypherSession.Unescape(versionMatch[1]!);
            return node === undefined ? [] : [{ [CypherAdapter.VersionAlias]: node[field] ?? null }];
        }
        return [...(bucket?.values() ?? [])].map(props => ({ [CypherAdapter.PropsAlias]: props }));
    }

    private static Unescape(quoted: string): string
    {
        return quoted.replaceAll(FakeCypherSession.EscapedBacktick, FakeCypherSession.Backtick);
    }
}
