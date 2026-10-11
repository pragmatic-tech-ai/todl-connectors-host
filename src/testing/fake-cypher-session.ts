import type { CypherRow, ICypherSession } from "../cypher/cypher-session.js";

/** In-memory graph honoring the CypherAdapter's MATCH/MERGE/DETACH DELETE statements. */
export class FakeCypherSession implements ICypherSession
{
    private static readonly PropsAlias = "props";
    private static readonly VersionAlias = "ver";
    private static readonly KeyParam = "key";
    private static readonly FieldsParam = "fields";
    private static readonly SeedIdField = "id";
    private static readonly DetachDeleteKeyword = "DETACH DELETE";
    private static readonly MergeKeyword = "MERGE";
    private static readonly LabelPattern = /\(n:`([^`]+)`/;
    private static readonly IdFieldPattern = /\{`([^`]+)`:/;
    private static readonly ReturnedVersionPattern = /RETURN n\.`([^`]+)` AS ver/;

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
        const label = FakeCypherSession.LabelPattern.exec(cypher)?.[1] ?? "";
        const bucket = this.store.get(label);
        const key = String(params[FakeCypherSession.KeyParam]);
        if (cypher.includes(FakeCypherSession.DetachDeleteKeyword))
        {
            bucket?.delete(key);
            return [];
        }
        if (cypher.includes(FakeCypherSession.MergeKeyword))
        {
            const idField = FakeCypherSession.IdFieldPattern.exec(cypher)?.[1] ?? FakeCypherSession.SeedIdField;
            const live = bucket ?? new Map<string, Record<string, unknown>>();
            this.store.set(label, live);
            const fields = params[FakeCypherSession.FieldsParam] as Record<string, unknown>;
            live.set(key, { ...(live.get(key) ?? {}), ...fields, [idField]: params[FakeCypherSession.KeyParam] });
            return [];
        }
        const versionMatch = FakeCypherSession.ReturnedVersionPattern.exec(cypher);
        if (versionMatch !== null)
        {
            const node = bucket?.get(key);
            return node === undefined ? [] : [{ [FakeCypherSession.VersionAlias]: node[versionMatch[1]!] ?? null }];
        }
        return [...(bucket?.values() ?? [])].map(props => ({ [FakeCypherSession.PropsAlias]: props }));
    }
}
