import { test } from "node:test";
import assert from "node:assert/strict";
import { ConnectionFailureKind } from "@pragmatic-tech-ai/todl";
import { MongoDocumentSession } from "../mongo-document-session.js";
import { DocumentAdapter } from "../document-adapter.js";
import type { IDocumentSession } from "../document-session.js";

class MongoConnectFixture
{
    public static readonly Secret = "s3cret-value-xyz";
    public static readonly Url = "mongodb://localhost:27017";
    public static readonly Database = "db";
}

test("Connect with a secret but no user fails closed with a secret-free error", () =>
{
    let message = "";
    try
    {
        MongoDocumentSession.Connect({ url: MongoConnectFixture.Url, database: MongoConnectFixture.Database }, MongoConnectFixture.Secret);
        assert.fail("expected Connect to throw");
    }
    catch (error)
    {
        message = (error as Error).message;
    }
    assert.match(message, /requires a 'user' config key/);
    assert.ok(!message.includes(MongoConnectFixture.Secret));
});

test("Connect with a secret and a user, or with no secret, still succeeds", () =>
{
    assert.ok(MongoDocumentSession.Connect({ url: MongoConnectFixture.Url, database: MongoConnectFixture.Database, user: "u" }, MongoConnectFixture.Secret));
    assert.ok(MongoDocumentSession.Connect({ url: MongoConnectFixture.Url, database: MongoConnectFixture.Database }));
});

class MongoClassifyCases
{
    public static readonly Rows: readonly { Label: string; Error: unknown; Kind: ConnectionFailureKind }[] = [
        { Label: "network error", Error: { name: "MongoNetworkError" }, Kind: ConnectionFailureKind.Transient },
        { Label: "server selection", Error: { name: "MongoServerSelectionError" }, Kind: ConnectionFailureKind.Transient },
        { Label: "network timeout", Error: { name: "MongoNetworkTimeoutError" }, Kind: ConnectionFailureKind.Transient },
        { Label: "retryable write label", Error: { name: "MongoServerError", errorLabels: ["RetryableWriteError"] }, Kind: ConnectionFailureKind.Transient },
        { Label: "resumable change stream label", Error: { errorLabels: ["ResumableChangeStreamError"] }, Kind: ConnectionFailureKind.Transient },
        { Label: "AuthenticationFailed 18", Error: { code: 18 }, Kind: ConnectionFailureKind.Auth },
        { Label: "Unauthorized 13", Error: { code: 13 }, Kind: ConnectionFailureKind.Auth },
        { Label: "duplicate key", Error: { code: 11000 }, Kind: ConnectionFailureKind.Permanent },
        { Label: "server error code 2", Error: { name: "MongoServerError", code: 2 }, Kind: ConnectionFailureKind.Permanent },
        { Label: "unrelated label", Error: { errorLabels: ["Other"] }, Kind: ConnectionFailureKind.Permanent },
        { Label: "unknown", Error: new Error("boom"), Kind: ConnectionFailureKind.Permanent },
        { Label: "null", Error: null, Kind: ConnectionFailureKind.Permanent },
        { Label: "string", Error: "MongoNetworkError", Kind: ConnectionFailureKind.Permanent },
    ];
}

for (const row of MongoClassifyCases.Rows)
{
    test(`DocumentAdapter.ClassifyFailure: ${row.Label}`, () =>
    {
        const adapter = new DocumentAdapter({} as IDocumentSession);
        assert.equal(adapter.ClassifyFailure(row.Error), row.Kind);
    });
}
