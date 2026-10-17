import assert from "node:assert/strict";
import { test } from "node:test";
import { PackWorkerOp } from "../pack-worker-protocol.js";
import type { PackWorkerFailed, PackWorkerReady, PackWorkerRequest, PackWorkerResponse } from "../pack-worker-protocol.js";

test("PackWorkerOp carries the four protocol operation values", () =>
{
    assert.equal(PackWorkerOp.Open, "open");
    assert.equal(PackWorkerOp.Query, "query");
    assert.equal(PackWorkerOp.Apply, "apply");
    assert.equal(PackWorkerOp.Dispose, "dispose");
    assert.deepEqual(Object.values(PackWorkerOp).sort(), ["apply", "dispose", "open", "query"]);
});

test("a request/response round-trip object literal satisfies the protocol types", () =>
{
    const request: PackWorkerRequest =
    {
        id: 1,
        op: PackWorkerOp.Query,
        handle: 7,
        request: { Source: "widgets", Fields: ["id"] }
    };
    const response: PackWorkerResponse =
    {
        id: request.id,
        ok: true,
        records: [{ id: 1 }]
    };
    assert.equal(response.id, request.id);
    assert.equal(response.ok, true);
    assert.deepEqual(response.records, [{ id: 1 }]);
});

test("the startup signal is a discriminated union on ready", () =>
{
    const ready: PackWorkerReady = { ready: true };
    const failed: PackWorkerFailed = { ready: false, error: "boom" };
    assert.equal(ready.ready, true);
    assert.equal(failed.ready, false);
    assert.equal(failed.error, "boom");
});
