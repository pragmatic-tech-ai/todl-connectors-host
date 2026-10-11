import { QueryCompareOp } from "@pragmatic-tech-ai/todl";
import type { QueryComparison } from "@pragmatic-tech-ai/todl";

/**
 * Best-effort Mongo filter from push-down comparisons. NOTE: Mongo's `$ne: null` does NOT match
 * SQL-null semantics, so the DocumentAdapter re-applies ExternalQuery after Find; this filter is
 * only a narrowing hint sent to the server.
 */
export class MongoFilter
{
    private static readonly NotEqualOperator = "$ne";

    public static From(comparisons: readonly QueryComparison[]): Record<string, unknown>
    {
        const filter: Record<string, unknown> = {};
        for (const c of comparisons)
        {
            filter[c.Field] = c.Op === QueryCompareOp.Neq ? { [MongoFilter.NotEqualOperator]: c.Value } : c.Value;
        }
        return filter;
    }
}
