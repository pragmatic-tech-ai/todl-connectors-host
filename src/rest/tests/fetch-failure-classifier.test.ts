import { test } from "node:test";
import assert from "node:assert/strict";
import { ConnectionFailureKind } from "@pragmatic-tech-ai/todl";
import { FetchFailureClassifier } from "../fetch-failure-classifier.js";
import { FetchRestHttpClient, HttpStatusError } from "../rest-http-client.js";

class FetchClassifyCases
{
    public static readonly Rows: readonly { Label: string; Error: unknown; Kind: ConnectionFailureKind }[] = [
        { Label: "TypeError", Error: new TypeError("fetch failed"), Kind: ConnectionFailureKind.Transient },
        { Label: "AbortError", Error: { name: "AbortError" }, Kind: ConnectionFailureKind.Transient },
        { Label: "TimeoutError", Error: { name: "TimeoutError" }, Kind: ConnectionFailureKind.Transient },
        ...[502, 503, 504, 429].map(s => ({ Label: `status ${s}`, Error: { status: s }, Kind: ConnectionFailureKind.Transient })),
        ...[401, 403].map(s => ({ Label: `status ${s}`, Error: { status: s }, Kind: ConnectionFailureKind.Auth })),
        ...[400, 404, 409, 500].map(s => ({ Label: `status ${s}`, Error: { status: s }, Kind: ConnectionFailureKind.Permanent })),
        { Label: "message 503", Error: new Error("http request failed with status 503"), Kind: ConnectionFailureKind.Transient },
        { Label: "message 401", Error: new Error("http request failed with status 401"), Kind: ConnectionFailureKind.Auth },
        { Label: "message 404", Error: new Error("http request failed with status 404"), Kind: ConnectionFailureKind.Permanent },
        { Label: "unrecognized", Error: new Error("boom"), Kind: ConnectionFailureKind.Permanent },
        { Label: "null", Error: null, Kind: ConnectionFailureKind.Permanent },
        { Label: "string", Error: "503", Kind: ConnectionFailureKind.Permanent },
    ];
}

for (const row of FetchClassifyCases.Rows)
{
    test(`FetchFailureClassifier.Classify: ${row.Label}`, () =>
    {
        assert.equal(FetchFailureClassifier.Classify(row.Error), row.Kind);
    });
}

test("FetchRestHttpClient throws a status-carrying error with the unchanged message", async () =>
{
    const fake = (async () => ({ ok: false, status: 503, json: async () => ({}) })) as unknown as typeof fetch;
    const client = new FetchRestHttpClient({ fetch: fake });
    await assert.rejects(client.GetJson("https://api.example/x", {}), (e: unknown) =>
        e instanceof HttpStatusError && e.status === 503 && e.message === "http request failed with status 503"
        && FetchFailureClassifier.Classify(e) === ConnectionFailureKind.Transient);
});
