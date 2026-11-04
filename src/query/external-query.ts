import { QueryFilterEvaluator } from "@pragmatic-tech-ai/todl";
import type { ExternalFieldValue, ExternalRecord, QueryRequest } from "@pragmatic-tech-ai/todl";

/** In-adapter filter + projection with SQL-null semantics, matching the engine's InMemoryAdapter. */
export class ExternalQuery
{
    public static Apply(records: readonly Record<string, unknown>[], request: QueryRequest): ExternalRecord[]
    {
        // Every operator, with the engine's shared SQL-null semantics (QueryFilterEvaluator).
        const matched = records.filter(row => QueryFilterEvaluator.Matches(row, request.Where));
        return matched.map(row => ExternalQuery.Project(row, request.Fields));
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
