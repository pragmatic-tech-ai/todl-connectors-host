import { test } from "node:test";
import assert from "node:assert/strict";
import { QueryCompareOp, WriteAtomicity, WriteConcurrency, WriteFailureKind, WriteOperationKind } from "@pragmatic-tech-ai/todl";
import { CypherAdapter } from "../cypher-adapter.js";
import { FakeCypherSession, TransactionalFakeCypherSession } from "../../testing/fake-cypher-session.js";
import { describeDataSourceAdapter } from "../../testing/adapter-conformance.js";

class CypherFixture
{
    public static readonly Customer = "Customer";
    public static readonly IdKey = "id";
    public static readonly Rev = "rev";
    public static readonly Hostile = "Evil`) DETACH DELETE (m";
    public static readonly HostileQuoted = "`Evil``) DETACH DELETE (m`";

    public static Make(): CypherAdapter
    {
        const session = new FakeCypherSession();
        session.Seed(CypherFixture.Customer, [{ id: "c1", label: "Acme" }]);
        return new CypherAdapter(session);
    }

    /** A transactional (and thus CanTransact) fixture so the conformance harness also drives the
     *  multi-op and atomic-rollback cases offline against the fake graph. */
    public static MakeTransactional(): CypherAdapter
    {
        const session = new TransactionalFakeCypherSession();
        session.Seed(CypherFixture.Customer, [{ id: "c1", label: "Acme" }]);
        return new CypherAdapter(session);
    }
}

describeDataSourceAdapter("CypherAdapter (fake session)", () => CypherFixture.Make());
describeDataSourceAdapter("CypherAdapter (transactional fake session)", () => CypherFixture.MakeTransactional());

test("CanVersion is advertised, and CanTransact tracks whether the session can transact", () =>
{
    assert.equal(CypherFixture.Make().CanVersion, true);
    assert.equal(CypherFixture.Make().CanTransact, false);
    assert.equal(CypherFixture.MakeTransactional().CanTransact, true);
});

test("Query re-applies Where in-adapter even though the session returns all nodes", async () =>
{
    const session = new FakeCypherSession();
    session.Seed(CypherFixture.Customer, [{ id: "c1", label: "Acme" }, { id: "c2", label: "Globex" }]);
    const rows = await new CypherAdapter(session).Query({
        Source: CypherFixture.Customer, Fields: [CypherFixture.IdKey],
        Where: { All: [{ Field: CypherFixture.IdKey, Op: QueryCompareOp.Eq, Value: "c2" }] },
    });
    assert.deepEqual(rows, [{ id: "c2" }]);
});

test("an optimistic version mismatch is a conflict, not applied, never thrown", async () =>
{
    const session = new FakeCypherSession();
    session.Seed(CypherFixture.Customer, [{ id: "c1", label: "Acme", rev: "v1" }]);
    const result = await new CypherAdapter(session).Apply({
        Source: CypherFixture.Customer, IdKey: CypherFixture.IdKey, VersionField: CypherFixture.Rev,
        Concurrency: WriteConcurrency.Optimistic, Atomicity: WriteAtomicity.Sequential,
        Operations: [{ Kind: WriteOperationKind.Upsert, Key: "c1", Fields: { label: "x" }, Version: "stale" }],
    });
    assert.equal(result.Applied, 0);
    assert.equal(result.Failures.length, 1);
    assert.match(result.Failures[0]!.Reason, /version/);
});

test("an optimistic write against a present-but-unversioned node is a Conflict (fail-closed, #7)", async () =>
{
    // c1 exists but carries no rev; a present-unversioned node must never be silently overwritten even
    // when op.Version is supplied -- it is a Conflict, and the stored node is left untouched.
    const session = new FakeCypherSession();
    session.Seed(CypherFixture.Customer, [{ id: "c1", label: "Acme" }]);
    const result = await new CypherAdapter(session).Apply({
        Source: CypherFixture.Customer, IdKey: CypherFixture.IdKey, VersionField: CypherFixture.Rev,
        Concurrency: WriteConcurrency.Optimistic, Atomicity: WriteAtomicity.Sequential,
        Operations: [{ Kind: WriteOperationKind.Upsert, Key: "c1", Fields: { label: "x" }, Version: "v1" }],
    });
    assert.equal(result.Applied, 0);
    assert.equal(result.Failures.length, 1);
    assert.equal(result.Failures[0]!.Kind, WriteFailureKind.Conflict);
    const rows = await new CypherAdapter(session).Query({ Source: CypherFixture.Customer, Fields: [CypherFixture.IdKey, "label"] });
    assert.deepEqual(rows, [{ id: "c1", label: "Acme" }]);
});

test("a Transactional batch rolls back entirely when a later op conflicts", async () =>
{
    // c2 would insert; c1 is present-but-unversioned (fail-closed Conflict). The Conflict aborts the
    // whole transaction, so c2 is rolled back too and nothing applies.
    const session = new TransactionalFakeCypherSession();
    session.Seed(CypherFixture.Customer, [{ id: "c1", label: "Acme" }]);
    const result = await new CypherAdapter(session).Apply({
        Source: CypherFixture.Customer, IdKey: CypherFixture.IdKey, VersionField: CypherFixture.Rev,
        Concurrency: WriteConcurrency.Optimistic, Atomicity: WriteAtomicity.Transactional,
        Operations: [
            { Kind: WriteOperationKind.Upsert, Key: "c2", Fields: { label: "Globex" } },
            { Kind: WriteOperationKind.Upsert, Key: "c1", Fields: { label: "x" }, Version: "v1" }],
    });
    assert.equal(result.Applied, 0);
    assert.equal(result.Failures.length, 1);
    assert.equal(result.Failures[0]!.Key, "c1");
    assert.equal(result.Failures[0]!.Kind, WriteFailureKind.Conflict);
    const rows = await new CypherAdapter(session).Query({ Source: CypherFixture.Customer, Fields: [CypherFixture.IdKey] });
    assert.deepEqual(rows, [{ id: "c1" }]);
});

test("a Transactional batch is wholly Unsupported when the session cannot transact", async () =>
{
    const session = new FakeCypherSession();
    session.Seed(CypherFixture.Customer, [{ id: "c1", label: "Acme" }]);
    const result = await new CypherAdapter(session).Apply({
        Source: CypherFixture.Customer, IdKey: CypherFixture.IdKey,
        Concurrency: WriteConcurrency.LastWriteWins, Atomicity: WriteAtomicity.Transactional,
        Operations: [
            { Kind: WriteOperationKind.Upsert, Key: "c1", Fields: { label: "x" } },
            { Kind: WriteOperationKind.Upsert, Key: "c2", Fields: { label: "y" } }],
    });
    assert.equal(result.Applied, 0);
    assert.deepEqual(result.Failures.map(f => f.Kind), [WriteFailureKind.Unsupported, WriteFailureKind.Unsupported]);
    assert.deepEqual(result.Failures.map(f => f.Key), ["c1", "c2"]);
});

test("a hostile Source containing a backtick is emitted backtick-escaped (no injection)", async () =>
{
    const session = new FakeCypherSession();
    await new CypherAdapter(session).Query({ Source: CypherFixture.Hostile, Fields: [CypherFixture.IdKey] });
    assert.equal(session.Statements.length, 1);
    assert.ok(session.Statements[0]!.cypher.includes(CypherFixture.HostileQuoted));
});

test("a version-guarded upsert of a new key proceeds", async () =>
{
    const session = new FakeCypherSession();
    session.Seed(CypherFixture.Customer, []);
    const result = await new CypherAdapter(session).Apply({
        Source: CypherFixture.Customer, IdKey: CypherFixture.IdKey, VersionField: CypherFixture.Rev,
        Concurrency: WriteConcurrency.Optimistic, Atomicity: WriteAtomicity.Sequential,
        Operations: [{ Kind: WriteOperationKind.Upsert, Key: "c9", Fields: { label: "New" }, Version: "v1" }],
    });
    assert.equal(result.Applied, 1);
    assert.equal(result.Failures.length, 0);
});
