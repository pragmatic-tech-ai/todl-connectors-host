import { QueryCompareOp } from "@pragmatic-tech-ai/todl";
import type { ExternalFieldValue, ExternalRecord, QueryComparison, QueryRequest } from "@pragmatic-tech-ai/todl";

/** In-adapter filter + projection with SQL-null semantics, matching the engine's InMemoryAdapter. */
export class ExternalQuery
{
    public static Apply(records: readonly Record<string, unknown>[], request: QueryRequest): ExternalRecord[]
    {
        const comparisons = request.Where?.All ?? [];
        const matched = records.filter(row => comparisons.every(c => ExternalQuery.Matches(row, c)));
        return matched.map(row => ExternalQuery.Project(row, request.Fields));
    }

    private static Matches(row: Record<string, unknown>, c: QueryComparison): boolean
    {
        const value = ExternalQuery.Coerce(row[c.Field]);
        // NULL operand -> SQL UNKNOWN for both = and <> -> row excluded.
        if (value === null || c.Value === null) return false;
        return c.Op === QueryCompareOp.Neq ? value !== c.Value : value === c.Value;
    }

    private static Project(row: Record<string, unknown>, fields: readonly string[]): ExternalRecord
    {
        const projected: { [field: string]: ExternalFieldValue } = {};
        for (const field of fields)
        {
            if (field in row) projected[field] = ExternalQuery.Coerce(row[field]);
        }
        return projected;
    }

    /** string/number/boolean/null pass through; undefined -> null; anything else -> String(value). */
    private static Coerce(value: unknown): ExternalFieldValue
    {
        if (value === undefined || value === null) return null;
        if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
        return String(value);
    }
}
