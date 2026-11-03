import { test } from "node:test";
import assert from "node:assert/strict";
import { QueryCompareOp } from "@pragmatic-tech-ai/todl";
import { MongoFilter } from "../mongo-filter.js";

test("each term becomes one $and clause, so two terms on a field both apply", () =>
{
    assert.deepEqual(MongoFilter.From([
        { Field: "n", Op: QueryCompareOp.Gte, Value: 1 },
        { Field: "n", Op: QueryCompareOp.Lt, Value: 9 },
    ]), { $and: [{ n: { $gte: 1 } }, { n: { $lt: 9 } }] });
});

test("every operator maps to its Mongo condition", () =>
{
    const one = (Op: QueryCompareOp, Value: string | null = "v", Values?: string[]) => MongoFilter.From([{ Field: "f", Op, Value, ...(Values ? { Values } : {}) }]);
    assert.deepEqual(one(QueryCompareOp.Eq), { $and: [{ f: { $eq: "v" } }] });
    assert.deepEqual(one(QueryCompareOp.Neq), { $and: [{ f: { $ne: "v" } }] });
    assert.deepEqual(one(QueryCompareOp.Lte), { $and: [{ f: { $lte: "v" } }] });
    assert.deepEqual(one(QueryCompareOp.Gt), { $and: [{ f: { $gt: "v" } }] });
    assert.deepEqual(one(QueryCompareOp.In, null, ["a", "b"]), { $and: [{ f: { $in: ["a", "b"] } }] });
    assert.deepEqual(one(QueryCompareOp.IsNull, null), { $and: [{ f: null }] });
    assert.deepEqual(one(QueryCompareOp.IsNotNull, null), { $and: [{ f: { $ne: null } }] });
});

test("no comparisons is an empty filter", () =>
{
    assert.deepEqual(MongoFilter.From([]), {});
});
