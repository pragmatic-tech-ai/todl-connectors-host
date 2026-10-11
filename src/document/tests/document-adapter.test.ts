import { test } from "node:test";
import assert from "node:assert/strict";
import { QueryCompareOp, WriteOperationKind } from "@pragmatic-tech-ai/todl";
import { DocumentAdapter } from "../document-adapter.js";
import { FakeDocumentSession } from "../../testing/fake-document-session.js";
import { describeDataSourceAdapter } from "../../testing/adapter-conformance.js";

class DocumentFixture
{
    public static readonly Collection = "Customer";
    public static readonly IdField = "id";
    public static readonly Label = "label";
    public static readonly Tier = "tier";
    public static readonly Gold = "gold";
    public static readonly Rev = "rev";
    public static readonly OperatorKey = "$where";
    public static readonly DottedKey = "a.b";

    public static Make(): DocumentAdapter
    {
        const session = new FakeDocumentSession();
        session.Seed(DocumentFixture.Collection, [{ [DocumentFixture.IdField]: "c1", [DocumentFixture.Label]: "Acme" }]);
        return new DocumentAdapter(session);
    }
}

describeDataSourceAdapter("DocumentAdapter (fake session)", () => DocumentFixture.Make());

test("Neq over a null field never returns the null-field row (SQL-null, not Mongo $ne:null)", async () =>
{
    const session = new FakeDocumentSession();
    session.Seed(DocumentFixture.Collection, [
        { [DocumentFixture.IdField]: "c1", [DocumentFixture.Label]: "Acme", [DocumentFixture.Tier]: null },
        { [DocumentFixture.IdField]: "c2", [DocumentFixture.Label]: "Globex", [DocumentFixture.Tier]: DocumentFixture.Gold }]);
    const rows = await new DocumentAdapter(session).Query(
        { Source: DocumentFixture.Collection, Fields: [DocumentFixture.IdField],
            Where: { All: [{ Field: DocumentFixture.Tier, Op: QueryCompareOp.Neq, Value: DocumentFixture.Gold }] } });
    assert.deepEqual(rows, []);
});

test("an optimistic version mismatch is a conflict, not applied, never thrown", async () =>
{
    const session = new FakeDocumentSession();
    session.Seed(DocumentFixture.Collection, [{ [DocumentFixture.IdField]: "c1", [DocumentFixture.Label]: "Acme", [DocumentFixture.Rev]: "v1" }]);
    const result = await new DocumentAdapter(session).Apply({ Source: DocumentFixture.Collection, IdKey: DocumentFixture.IdField, VersionField: DocumentFixture.Rev,
        Operations: [{ Kind: WriteOperationKind.Upsert, Key: "c1", Fields: { [DocumentFixture.Label]: "x" }, Version: "stale" }] });
    assert.equal(result.Applied, 0);
    assert.match(result.Conflicts[0]!.Reason, /version/);
});

test("an upsert with an operator-prefixed field key is rejected", async () =>
{
    const adapter = new DocumentAdapter(new FakeDocumentSession());
    await assert.rejects(adapter.Apply({ Source: DocumentFixture.Collection, IdKey: DocumentFixture.IdField,
        Operations: [{ Kind: WriteOperationKind.Upsert, Key: "c1", Fields: { [DocumentFixture.OperatorKey]: "x" } }] }));
});

test("a query filtering on an operator-prefixed or dotted field is rejected", async () =>
{
    const adapter = new DocumentAdapter(new FakeDocumentSession());
    for (const field of [DocumentFixture.OperatorKey, DocumentFixture.DottedKey])
    {
        await assert.rejects(adapter.Query({ Source: DocumentFixture.Collection, Fields: [DocumentFixture.IdField],
            Where: { All: [{ Field: field, Op: QueryCompareOp.Eq, Value: "x" }] } }));
    }
});
