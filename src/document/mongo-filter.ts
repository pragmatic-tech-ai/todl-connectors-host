import { QueryCompareOp } from "@pragmatic-tech-ai/todl";
import type { QueryComparison } from "@pragmatic-tech-ai/todl";
import { DocumentIdentifier } from "./document-identifier.js";

/**
 * Mongo filter from filter terms, one `$and` clause per term (so two terms on one field both apply). It is a NARROWING
 * hint, never weaker than the terms: Mongo's null handling differs from SQL's (`$ne` / `$nin` match null and missing),
 * so the DocumentAdapter re-applies ExternalQuery after Find for the exact semantics.
 */
export class MongoFilter
{
    private static readonly AndOperator = "$and";
    private static readonly Operators: ReadonlyMap<QueryCompareOp, string> = new Map([
        [QueryCompareOp.Eq, "$eq"],
        [QueryCompareOp.Neq, "$ne"],
        [QueryCompareOp.Lt, "$lt"],
        [QueryCompareOp.Lte, "$lte"],
        [QueryCompareOp.Gt, "$gt"],
        [QueryCompareOp.Gte, "$gte"],
        [QueryCompareOp.In, "$in"],
        [QueryCompareOp.IsNotNull, "$ne"],
    ]);

    public static From(comparisons: readonly QueryComparison[]): Record<string, unknown>
    {
        if (comparisons.length === 0) return {};
        return { [MongoFilter.AndOperator]: comparisons.map(c => ({ [DocumentIdentifier.Validate(c.Field)]: MongoFilter.Condition(c) })) };
    }

    private static Condition(c: QueryComparison): unknown
    {
        // { field: null } matches null or missing: exactly IS NULL.
        if (c.Op === QueryCompareOp.IsNull) return null;
        const operator = MongoFilter.Operators.get(c.Op)!;
        if (c.Op === QueryCompareOp.IsNotNull) return { [operator]: null };
        if (c.Op === QueryCompareOp.In) return { [operator]: [...(c.Values ?? [])] };
        return { [operator]: c.Value };
    }
}
