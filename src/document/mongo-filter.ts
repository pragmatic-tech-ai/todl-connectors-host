import { QueryCompareOp } from "@pragmatic-tech-ai/todl";
import type { QueryComparison } from "@pragmatic-tech-ai/todl";
import { DocumentIdentifier } from "./document-identifier.js";

/**
 * A NARROWING hint sent to Mongo: the DocumentAdapter re-applies ExternalQuery after Find for the exact semantics, so a
 * term is pushed only when Mongo can never exclude a document the in-memory evaluator would keep. That holds for
 * equality and IN on scalars (as before), numeric ranges, and IS NULL ({ f: null } matches null or missing). Not pushed:
 * <> (Mongo matches null / per array element differently), string and boolean ranges (code-point vs code-unit order,
 * BSON type brackets), IS NOT NULL (excludes arrays holding null) and any unknown operator. One `$and` clause per pushed
 * term, so two terms on one field both apply.
 */
export class MongoFilter
{
    private static readonly AndOperator = "$and";
    private static readonly RangeOperators: ReadonlyMap<QueryCompareOp, string> = new Map([
        [QueryCompareOp.Lt, "$lt"],
        [QueryCompareOp.Lte, "$lte"],
        [QueryCompareOp.Gt, "$gt"],
        [QueryCompareOp.Gte, "$gte"],
    ]);
    private static readonly EqOperator = "$eq";
    private static readonly InOperator = "$in";

    public static From(comparisons: readonly QueryComparison[]): Record<string, unknown>
    {
        const clauses: Record<string, unknown>[] = [];
        for (const c of comparisons)
        {
            const condition = MongoFilter.Condition(c);
            if (condition !== MongoFilter.NotPushed) clauses.push({ [DocumentIdentifier.Validate(c.Field)]: condition });
        }
        return clauses.length === 0 ? {} : { [MongoFilter.AndOperator]: clauses };
    }

    private static readonly NotPushed = Symbol("not pushed");

    private static Condition(c: QueryComparison): unknown
    {
        switch (c.Op)
        {
            case QueryCompareOp.Eq: return c.Value === null ? MongoFilter.NotPushed : { [MongoFilter.EqOperator]: c.Value };
            case QueryCompareOp.In: return { [MongoFilter.InOperator]: (c.Values ?? []).filter(v => v !== null) };
            case QueryCompareOp.IsNull: return null;
            default: break;
        }
        const range = MongoFilter.RangeOperators.get(c.Op);
        return range !== undefined && typeof c.Value === "number" && Number.isFinite(c.Value) ? { [range]: c.Value } : MongoFilter.NotPushed;
    }
}
