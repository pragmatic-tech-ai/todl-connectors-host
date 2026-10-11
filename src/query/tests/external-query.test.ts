import { test } from "node:test";
import assert from "node:assert/strict";
import { QueryCompareOp } from "@pragmatic-tech-ai/todl";
import { ExternalQuery } from "../external-query.js";

const rows = [
    { id: "c1", label: "Acme", tier: null as unknown },
    { id: "c2", label: "Globex", tier: "gold" },
];

test("projects only requested fields and coerces values", () =>
{
    const out = ExternalQuery.Apply(rows, { Source: "Customer", Fields: ["id", "label"] });
    assert.deepEqual(out, [{ id: "c1", label: "Acme" }, { id: "c2", label: "Globex" }]);
});

test("Eq filter keeps matching rows", () =>
{
    const out = ExternalQuery.Apply(rows,
        { Source: "Customer", Fields: ["id"], Where: { All: [{ Field: "id", Op: QueryCompareOp.Eq, Value: "c2" }] } });
    assert.deepEqual(out, [{ id: "c2" }]);
});

test("Neq filter drops matching rows", () =>
{
    const out = ExternalQuery.Apply(rows,
        { Source: "Customer", Fields: ["id"], Where: { All: [{ Field: "id", Op: QueryCompareOp.Neq, Value: "c1" }] } });
    assert.deepEqual(out, [{ id: "c2" }]);
});

test("a null row value excludes the row for both Eq and Neq", () =>
{
    const eq = ExternalQuery.Apply(rows,
        { Source: "Customer", Fields: ["id"], Where: { All: [{ Field: "tier", Op: QueryCompareOp.Eq, Value: "gold" }] } });
    assert.deepEqual(eq, [{ id: "c2" }]);
    const neq = ExternalQuery.Apply(rows,
        { Source: "Customer", Fields: ["id"], Where: { All: [{ Field: "tier", Op: QueryCompareOp.Neq, Value: "gold" }] } });
    assert.deepEqual(neq, []);
});

test("a null operand excludes every row for both operators", () =>
{
    const out = ExternalQuery.Apply(rows,
        { Source: "Customer", Fields: ["id"], Where: { All: [{ Field: "label", Op: QueryCompareOp.Eq, Value: null }] } });
    assert.deepEqual(out, []);
    const neq = ExternalQuery.Apply(rows,
        { Source: "Customer", Fields: ["id"], Where: { All: [{ Field: "label", Op: QueryCompareOp.Neq, Value: null }] } });
    assert.deepEqual(neq, []);
});

test("an absent field is omitted from the projection, not set to null", () =>
{
    const result = ExternalQuery.Apply(rows, { Source: "Customer", Fields: ["id", "missing"] });
    assert.equal("missing" in result[0], false);
    assert.deepEqual(result[0], { id: "c1" });
});

test("non-scalar values are coerced with String(value)", () =>
{
    const when = new Date(0);
    const out = ExternalQuery.Apply([{ id: "d1", when, big: 10n }], { Source: "Customer", Fields: ["when", "big"] });
    assert.deepEqual(out, [{ when: String(when), big: "10" }]);
});
