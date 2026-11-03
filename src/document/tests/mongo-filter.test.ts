import { test } from "node:test";
import assert from "node:assert/strict";
import { QueryCompareOp } from "@pragmatic-tech-ai/todl";
import { MongoFilter } from "../mongo-filter.js";

test("each pushed term becomes one $and clause, so two terms on a field both apply", () =>
{
    assert.deepEqual(MongoFilter.From([
        { Field: "n", Op: QueryCompareOp.Gte, Value: 1 },
        { Field: "n", Op: QueryCompareOp.Lt, Value: 9 },
    ]), { $and: [{ n: { $gte: 1 } }, { n: { $lt: 9 } }] });
});

test("equality, IN, numeric ranges and IS NULL are pushed", () =>
{
    const one = (Op: QueryCompareOp, Value: string | number | null = "v", Values?: (string | null)[]) => MongoFilter.From([{ Field: "f", Op, Value, ...(Values ? { Values } : {}) }]);
    assert.deepEqual(one(QueryCompareOp.Eq), { $and: [{ f: { $eq: "v" } }] });
    assert.deepEqual(one(QueryCompareOp.Gt, 3), { $and: [{ f: { $gt: 3 } }] });
    assert.deepEqual(one(QueryCompareOp.In, null, ["a", null, "b"]), { $and: [{ f: { $in: ["a", "b"] } }] });
    assert.deepEqual(one(QueryCompareOp.IsNull, null), { $and: [{ f: null }] });
});

test("terms Mongo could evaluate more narrowly than the engine are left to the in-memory re-filter", () =>
{
    const one = (Op: QueryCompareOp, Value: string | number | null = "v") => MongoFilter.From([{ Field: "f", Op, Value }]);
    assert.deepEqual(one(QueryCompareOp.Neq), {});
    assert.deepEqual(one(QueryCompareOp.Gt, "2024"), {});
    assert.deepEqual(one(QueryCompareOp.IsNotNull, null), {});
    assert.deepEqual(one("like" as QueryCompareOp), {});
});

test("no comparisons is an empty filter", () =>
{
    assert.deepEqual(MongoFilter.From([]), {});
});
