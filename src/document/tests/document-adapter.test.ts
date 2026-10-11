import { test } from "node:test";
import assert from "node:assert/strict";
import { QueryCompareOp, WriteOperationKind } from "@pragmatic-tech-ai/todl";
import { DocumentAdapter } from "../document-adapter.js";
import { FakeDocumentSession } from "../../testing/fake-document-session.js";
import { describeDataSourceAdapter } from "../../testing/adapter-conformance.js";

class DocumentFixture
{
    public static Make(): DocumentAdapter
    {
        const session = new FakeDocumentSession();
        session.Seed("Customer", [{ id: "c1", label: "Acme" }]);
        return new DocumentAdapter(session);
    }
}

describeDataSourceAdapter("DocumentAdapter (fake session)", () => DocumentFixture.Make());

test("Neq over a null field never returns the null-field row (SQL-null, not Mongo $ne:null)", async () =>
{
    const session = new FakeDocumentSession();
    session.Seed("Customer", [{ id: "c1", label: "Acme", tier: null }, { id: "c2", label: "Globex", tier: "gold" }]);
    const rows = await new DocumentAdapter(session).Query(
        { Source: "Customer", Fields: ["id"], Where: { All: [{ Field: "tier", Op: QueryCompareOp.Neq, Value: "gold" }] } });
    assert.deepEqual(rows, []);
});

test("an optimistic version mismatch is a conflict, not applied, never thrown", async () =>
{
    const session = new FakeDocumentSession();
    session.Seed("Customer", [{ id: "c1", label: "Acme", rev: "v1" }]);
    const result = await new DocumentAdapter(session).Apply({ Source: "Customer", IdKey: "id", VersionField: "rev",
        Operations: [{ Kind: WriteOperationKind.Upsert, Key: "c1", Fields: { label: "x" }, Version: "stale" }] });
    assert.equal(result.Applied, 0);
    assert.match(result.Conflicts[0]!.Reason, /version/);
});
