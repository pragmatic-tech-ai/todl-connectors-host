import { test } from "node:test";
import assert from "node:assert/strict";
import { QueryCompareOp, WriteAtomicity, WriteConcurrency, WriteFailureKind, WriteOperationKind } from "@pragmatic-tech-ai/todl";
import { DocumentAdapter } from "../document-adapter.js";
import { FakeDocumentSession, TransactionalFakeDocumentSession } from "../../testing/fake-document-session.js";
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
        Concurrency: WriteConcurrency.Optimistic, Atomicity: WriteAtomicity.Sequential,
        Operations: [{ Kind: WriteOperationKind.Upsert, Key: "c1", Fields: { [DocumentFixture.Label]: "x" }, Version: "stale" }] });
    assert.equal(result.Applied, 0);
    assert.match(result.Failures[0]!.Reason, /version/);
});

test("an upsert with an operator-prefixed field key is rejected", async () =>
{
    const adapter = new DocumentAdapter(new FakeDocumentSession());
    await assert.rejects(adapter.Apply({ Source: DocumentFixture.Collection, IdKey: DocumentFixture.IdField,
        Concurrency: WriteConcurrency.LastWriteWins, Atomicity: WriteAtomicity.Sequential,
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

test("the adapter itself rejects an invalid Source on Query and an invalid IdKey or Source on Apply", async () =>
{
    const adapter = new DocumentAdapter(new FakeDocumentSession());
    for (const source of [DocumentFixture.OperatorKey, DocumentFixture.DottedKey])
    {
        await assert.rejects(adapter.Query({ Source: source, Fields: [DocumentFixture.IdField] }));
        await assert.rejects(adapter.Apply({ Source: source, IdKey: DocumentFixture.IdField,
            Concurrency: WriteConcurrency.LastWriteWins, Atomicity: WriteAtomicity.Sequential, Operations: [] }));
    }
    await assert.rejects(adapter.Apply({ Source: DocumentFixture.Collection, IdKey: DocumentFixture.OperatorKey,
        Concurrency: WriteConcurrency.LastWriteWins, Atomicity: WriteAtomicity.Sequential, Operations: [] }));
});

test("absent doc applies (optimistic)", async () =>
{
    // The key is absent (ReadVersionState -> Exists:false): optimistic insert is writable regardless of op.Version.
    const session = new FakeDocumentSession();
    session.Seed(DocumentFixture.Collection, [{ [DocumentFixture.IdField]: "c1", [DocumentFixture.Label]: "Acme" }]);
    const result = await new DocumentAdapter(session).Apply({ Source: DocumentFixture.Collection, IdKey: DocumentFixture.IdField,
        VersionField: DocumentFixture.Rev, Concurrency: WriteConcurrency.Optimistic, Atomicity: WriteAtomicity.Sequential,
        Operations: [{ Kind: WriteOperationKind.Upsert, Key: "c2", Fields: { [DocumentFixture.Label]: "Globex" } }] });
    assert.equal(result.Applied, 1);
    assert.equal(result.Failures.length, 0);
    const rows = await new DocumentAdapter(session).Query({ Source: DocumentFixture.Collection, Fields: [DocumentFixture.IdField, DocumentFixture.Label] });
    assert.deepEqual(rows.find(r => r[DocumentFixture.IdField] === "c2"), { [DocumentFixture.IdField]: "c2", [DocumentFixture.Label]: "Globex" });
});

test("present + matching version applies", async () =>
{
    const session = new FakeDocumentSession();
    session.Seed(DocumentFixture.Collection, [{ [DocumentFixture.IdField]: "c1", [DocumentFixture.Label]: "Acme", [DocumentFixture.Rev]: "v1" }]);
    const result = await new DocumentAdapter(session).Apply({ Source: DocumentFixture.Collection, IdKey: DocumentFixture.IdField,
        VersionField: DocumentFixture.Rev, Concurrency: WriteConcurrency.Optimistic, Atomicity: WriteAtomicity.Sequential,
        Operations: [{ Kind: WriteOperationKind.Upsert, Key: "c1", Fields: { [DocumentFixture.Label]: "Acme 2" }, Version: "v1" }] });
    assert.equal(result.Applied, 1);
    assert.equal(result.Failures.length, 0);
});

test("present + mismatched version is a Conflict", async () =>
{
    const session = new FakeDocumentSession();
    session.Seed(DocumentFixture.Collection, [{ [DocumentFixture.IdField]: "c1", [DocumentFixture.Label]: "Acme", [DocumentFixture.Rev]: "v1" }]);
    const result = await new DocumentAdapter(session).Apply({ Source: DocumentFixture.Collection, IdKey: DocumentFixture.IdField,
        VersionField: DocumentFixture.Rev, Concurrency: WriteConcurrency.Optimistic, Atomicity: WriteAtomicity.Sequential,
        Operations: [{ Kind: WriteOperationKind.Upsert, Key: "c1", Fields: { [DocumentFixture.Label]: "x" }, Version: "v2" }] });
    assert.equal(result.Applied, 0);
    assert.equal(result.Failures.length, 1);
    assert.equal(result.Failures[0]!.Kind, WriteFailureKind.Conflict);
});

test("present + unversioned is a Conflict (fail-closed) — the #7 case", async () =>
{
    // The row exists but carries no version field; a present-but-unversioned record must never be
    // silently overwritten -- even when op.Version matches nothing, it is a Conflict, not an apply.
    const session = new FakeDocumentSession();
    session.Seed(DocumentFixture.Collection, [{ [DocumentFixture.IdField]: "c1", [DocumentFixture.Label]: "Acme" }]);
    const result = await new DocumentAdapter(session).Apply({ Source: DocumentFixture.Collection, IdKey: DocumentFixture.IdField,
        VersionField: DocumentFixture.Rev, Concurrency: WriteConcurrency.Optimistic, Atomicity: WriteAtomicity.Sequential,
        Operations: [{ Kind: WriteOperationKind.Upsert, Key: "c1", Fields: { [DocumentFixture.Label]: "x" }, Version: "v1" }] });
    assert.equal(result.Applied, 0);
    assert.equal(result.Failures.length, 1);
    assert.equal(result.Failures[0]!.Kind, WriteFailureKind.Conflict);
    // The stored doc is untouched.
    const rows = await new DocumentAdapter(session).Query({ Source: DocumentFixture.Collection, Fields: [DocumentFixture.IdField, DocumentFixture.Label] });
    assert.deepEqual(rows, [{ [DocumentFixture.IdField]: "c1", [DocumentFixture.Label]: "Acme" }]);
});

test("LastWriteWins overwrites an unversioned present doc", async () =>
{
    const session = new FakeDocumentSession();
    session.Seed(DocumentFixture.Collection, [{ [DocumentFixture.IdField]: "c1", [DocumentFixture.Label]: "Acme" }]);
    const result = await new DocumentAdapter(session).Apply({ Source: DocumentFixture.Collection, IdKey: DocumentFixture.IdField,
        VersionField: DocumentFixture.Rev, Concurrency: WriteConcurrency.LastWriteWins, Atomicity: WriteAtomicity.Sequential,
        Operations: [{ Kind: WriteOperationKind.Upsert, Key: "c1", Fields: { [DocumentFixture.Label]: "Overwritten" }, Version: "v9" }] });
    assert.equal(result.Applied, 1);
    assert.equal(result.Failures.length, 0);
    const rows = await new DocumentAdapter(session).Query({ Source: DocumentFixture.Collection, Fields: [DocumentFixture.IdField, DocumentFixture.Label] });
    assert.deepEqual(rows, [{ [DocumentFixture.IdField]: "c1", [DocumentFixture.Label]: "Overwritten" }]);
});

test("Transactional rolls back on a failure when supported", async () =>
{
    // c1 matches its version (would apply); c2 is present-but-unversioned (fail-closed Conflict).
    // The Conflict aborts the whole transaction, so even c1's update is rolled back and nothing applies.
    const session = new TransactionalFakeDocumentSession();
    session.Seed(DocumentFixture.Collection, [
        { [DocumentFixture.IdField]: "c1", [DocumentFixture.Label]: "Acme", [DocumentFixture.Rev]: "v1" },
        { [DocumentFixture.IdField]: "c2", [DocumentFixture.Label]: "Globex" }]);
    const result = await new DocumentAdapter(session).Apply({ Source: DocumentFixture.Collection, IdKey: DocumentFixture.IdField,
        VersionField: DocumentFixture.Rev, Concurrency: WriteConcurrency.Optimistic, Atomicity: WriteAtomicity.Transactional,
        Operations: [
            { Kind: WriteOperationKind.Upsert, Key: "c1", Fields: { [DocumentFixture.Label]: "Acme 2" }, Version: "v1" },
            { Kind: WriteOperationKind.Upsert, Key: "c2", Fields: { [DocumentFixture.Label]: "x" }, Version: "v1" }] });
    assert.equal(result.Applied, 0);
    assert.equal(result.Failures.length, 1);
    assert.equal(result.Failures[0]!.Key, "c2");
    assert.equal(result.Failures[0]!.Kind, WriteFailureKind.Conflict);
    // c1 was rolled back to its seeded label.
    const rows = await new DocumentAdapter(session).Query({ Source: DocumentFixture.Collection, Fields: [DocumentFixture.IdField, DocumentFixture.Label] });
    assert.equal(rows.find(r => r[DocumentFixture.IdField] === "c1")![DocumentFixture.Label], "Acme");
});

test("Transactional returns Unsupported when the session can't transact", async () =>
{
    const session = new FakeDocumentSession();
    session.Seed(DocumentFixture.Collection, [{ [DocumentFixture.IdField]: "c1", [DocumentFixture.Label]: "Acme" }]);
    const result = await new DocumentAdapter(session).Apply({ Source: DocumentFixture.Collection, IdKey: DocumentFixture.IdField,
        Concurrency: WriteConcurrency.LastWriteWins, Atomicity: WriteAtomicity.Transactional,
        Operations: [
            { Kind: WriteOperationKind.Upsert, Key: "c1", Fields: { [DocumentFixture.Label]: "x" } },
            { Kind: WriteOperationKind.Upsert, Key: "c2", Fields: { [DocumentFixture.Label]: "y" } }] });
    assert.equal(result.Applied, 0);
    assert.equal(result.Failures.length, 2);
    assert.deepEqual(result.Failures.map(f => f.Kind), [WriteFailureKind.Unsupported, WriteFailureKind.Unsupported]);
    assert.deepEqual(result.Failures.map(f => f.Key), ["c1", "c2"]);
});
