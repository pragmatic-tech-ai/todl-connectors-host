import { test } from "node:test";
import assert from "node:assert/strict";
import { QueryCompareOp } from "@pragmatic-tech-ai/todl";
import { MongoFilter } from "../mongo-filter.js";

test("Eq maps to a direct equality", () =>
{
    assert.deepEqual(MongoFilter.From([{ Field: "id", Op: QueryCompareOp.Eq, Value: "c1" }]), { id: "c1" });
});

test("Neq maps to $ne", () =>
{
    assert.deepEqual(MongoFilter.From([{ Field: "id", Op: QueryCompareOp.Neq, Value: "c1" }]), { id: { $ne: "c1" } });
});

test("no comparisons is an empty filter", () =>
{
    assert.deepEqual(MongoFilter.From([]), {});
});
