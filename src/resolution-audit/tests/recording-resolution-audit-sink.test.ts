import { test } from "node:test";
import assert from "node:assert/strict";
import { RecordingResolutionAuditSink } from "../recording-resolution-audit-sink.js";

test("Record collects events and Events returns them in order", async () =>
{
    const sink = new RecordingResolutionAuditSink();
    assert.equal(sink.Events().length, 0);
    await sink.Record({ model: "m1", decisions: [] });
    await sink.Record({ model: "m2", decisions: [] });
    assert.deepEqual(sink.Events().map((e) => e.model), ["m1", "m2"]);
});
