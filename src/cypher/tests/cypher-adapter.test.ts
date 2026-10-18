import { test } from "node:test";
import assert from "node:assert/strict";
import { QueryCompareOp, WriteAtomicity, WriteConcurrency, WriteFailureKind, WriteOperationKind } from "@pragmatic-tech-ai/todl";
import type { QueryRequest } from "@pragmatic-tech-ai/todl";
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

/** The recording fake only proves the emitted Cypher + params (it does not sort/limit/seek/filter); behavior is proven by the pushed-down Cypher. */
class CypherPagingFixture
{
    public static readonly Key = "id";
    public static readonly After = "k5";
    public static readonly Tier = "tier";
    public static readonly Gold = "gold";
    public static readonly Plain = "plain";

    public static Request(): QueryRequest
    {
        return {
            Source: CypherFixture.Customer, Fields: [CypherPagingFixture.Key, "label"], OrderKey: CypherPagingFixture.Key,
            Where: { All: [
                { Field: CypherPagingFixture.Tier, Op: QueryCompareOp.Eq, Value: CypherPagingFixture.Gold },
                { Field: "label", Op: QueryCompareOp.Neq, Value: CypherPagingFixture.Plain },
            ] },
        };
    }

    public static Make(rows: Record<string, unknown>[]): { Session: FakeCypherSession; Adapter: CypherAdapter }
    {
        const session = new FakeCypherSession();
        session.Seed(CypherFixture.Customer, rows);
        return { Session: session, Adapter: new CypherAdapter(session) };
    }
}

test("CanPage is advertised", () =>
{
    assert.equal(CypherFixture.Make().CanPage, true);
});

test("QueryPage emits a strict > keyset term ANDed with Where, ordered ascending and limited at the source", async () =>
{
    const t = CypherPagingFixture.Make([{ id: "k6", label: "a", tier: "gold" }, { id: "k7", label: "b", tier: "gold" }]);
    const slice = await t.Adapter.QueryPage(CypherPagingFixture.Request(), { After: CypherPagingFixture.After, Limit: 2 });
    assert.equal(t.Session.Statements.length, 1);
    const st = t.Session.Statements[0]!;
    assert.equal(st.cypher, "MATCH (n:`Customer`) WHERE n.`id` > $after AND n.`tier` = $w0 AND n.`label` <> $w1 "
        + "RETURN properties(n) AS props ORDER BY n.`id` LIMIT toInteger($limit)");
    assert.deepEqual(st.params, { after: "k5", limit: 2, w0: "gold", w1: "plain" });
    assert.equal(slice.NextAfter, "k7");
    assert.deepEqual(slice.Records, [{ id: "k6", label: "a" }, { id: "k7", label: "b" }]);
});

test("QueryPage first page has no keyset term but still orders and limits", async () =>
{
    const t = CypherPagingFixture.Make([]);
    await t.Adapter.QueryPage({ Source: CypherFixture.Customer, Fields: ["id"], OrderKey: "id" }, { Limit: 3 });
    const st = t.Session.Statements[0]!;
    assert.equal(st.cypher, "MATCH (n:`Customer`) RETURN properties(n) AS props ORDER BY n.`id` LIMIT toInteger($limit)");
    assert.deepEqual(st.params, { limit: 3 });
});

test("QueryPage short slice has no NextAfter; full slice with a null last key has none either", async () =>
{
    const short = CypherPagingFixture.Make([{ id: "k6" }]);
    assert.equal((await short.Adapter.QueryPage({ Source: CypherFixture.Customer, Fields: ["id"] }, { Limit: 2 })).NextAfter, undefined);
    const nul = CypherPagingFixture.Make([]);
    nul.Session.Seed(CypherFixture.Customer, [{ id: "k6" }, { id: "k7", rank: null }]);
    const slice = await nul.Adapter.QueryPage({ Source: CypherFixture.Customer, Fields: ["rank"], OrderKey: "rank" }, { Limit: 2 });
    assert.equal(slice.NextAfter, undefined);
});

test("QueryPage defaults the order key to the first field and rejects bad limits / no key", async () =>
{
    const t = CypherPagingFixture.Make([]);
    await t.Adapter.QueryPage({ Source: CypherFixture.Customer, Fields: ["label"] }, { Limit: 1 });
    assert.match(t.Session.Statements[0]!.cypher, /ORDER BY n\.`label` LIMIT/);
    await assert.rejects(t.Adapter.QueryPage({ Source: CypherFixture.Customer, Fields: ["id"] }, { Limit: 0 }), /positive integer/);
    await assert.rejects(t.Adapter.QueryPage({ Source: CypherFixture.Customer, Fields: ["id"] }, { Limit: 1.5 }), /positive integer/);
    await assert.rejects(t.Adapter.QueryPage({ Source: CypherFixture.Customer, Fields: [] }, { Limit: 1 }), /order/);
});
