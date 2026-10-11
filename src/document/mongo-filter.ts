import { QueryCompareOp } from "@pragmatic-tech-ai/todl";
import type { QueryComparison } from "@pragmatic-tech-ai/todl";
import { DocumentIdentifier } from "./document-identifier.js";

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
            // Two comparisons on the same field overwrite each other here; fine, as this is only a best-effort hint and ExternalQuery is authoritative.
            filter[DocumentIdentifier.Validate(c.Field)] = c.Op === QueryCompareOp.Neq ? { [MongoFilter.NotEqualOperator]: c.Value } : c.Value;
        }
        return filter;
    }
}
