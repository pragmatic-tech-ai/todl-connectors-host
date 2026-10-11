import { test } from "node:test";
import assert from "node:assert/strict";
import { QueryCompareOp, WriteOperationKind } from "@pragmatic-tech-ai/todl";
import { CypherAdapter } from "../cypher-adapter.js";
import { FakeCypherSession } from "../../testing/fake-cypher-session.js";
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
}

describeDataSourceAdapter("CypherAdapter (fake session)", () => CypherFixture.Make());

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
        Operations: [{ Kind: WriteOperationKind.Upsert, Key: "c1", Fields: { label: "x" }, Version: "stale" }],
    });
    assert.equal(result.Applied, 0);
    assert.equal(result.Conflicts.length, 1);
    assert.match(result.Conflicts[0]!.Reason, /version/);
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
        Operations: [{ Kind: WriteOperationKind.Upsert, Key: "c9", Fields: { label: "New" }, Version: "v1" }],
    });
    assert.equal(result.Applied, 1);
    assert.equal(result.Conflicts.length, 0);
});
