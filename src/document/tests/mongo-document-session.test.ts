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

type RecordedCursor = { Filter?: unknown; FindOptions?: unknown; Sort?: unknown; Limit?: unknown };

class StubMongoFixture
{
    public static readonly Collection = "Customer";
    public static readonly Key = "id";
    public static readonly After = "k5";
    public static readonly Tier = "tier";
    public static readonly Gold = "gold";

    public static Make(): { Rec: RecordedCursor; Session: MongoDocumentSession }
    {
        const rec: RecordedCursor = {};
        const cursor = {
            sort: (s: unknown) => { rec.Sort = s; return cursor; },
            limit: (l: unknown) => { rec.Limit = l; return cursor; },
            toArray: async () => [],
        };
        const client = { db: () => ({ collection: () => ({ find: (f: unknown, o: unknown) => { rec.Filter = f; rec.FindOptions = o; return cursor; } }) }) };
        return { Rec: rec, Session: new MongoDocumentSession(client as never, "db") };
    }
}

test("paged Find ANDs the base filter with a strict $gt seek, sorts, limits and projects out _id", async () =>
{
    const { Rec, Session } = StubMongoFixture.Make();
    await Session.Find(StubMongoFixture.Collection, { [StubMongoFixture.Tier]: StubMongoFixture.Gold },
        { Sort: { [StubMongoFixture.Key]: 1 }, After: { Field: StubMongoFixture.Key, Value: StubMongoFixture.After }, Limit: 2 });
    assert.deepEqual(Rec.Filter, { $and: [{ [StubMongoFixture.Tier]: StubMongoFixture.Gold }, { [StubMongoFixture.Key]: { $gt: StubMongoFixture.After } }] });
    assert.deepEqual(Rec.Sort, { [StubMongoFixture.Key]: 1 });
    assert.equal(Rec.Limit, 2);
    assert.deepEqual(Rec.FindOptions, { projection: { _id: 0 } });
});

test("paged Find with an empty base filter uses the bare seek; the no-options path is unchanged", async () =>
{
    const first = StubMongoFixture.Make();
    await first.Session.Find(StubMongoFixture.Collection, {}, { After: { Field: StubMongoFixture.Key, Value: StubMongoFixture.After } });
    assert.deepEqual(first.Rec.Filter, { [StubMongoFixture.Key]: { $gt: StubMongoFixture.After } });
    const plain = StubMongoFixture.Make();
    await plain.Session.Find(StubMongoFixture.Collection, { [StubMongoFixture.Tier]: StubMongoFixture.Gold });
    assert.deepEqual(plain.Rec.Filter, { [StubMongoFixture.Tier]: StubMongoFixture.Gold });
    assert.equal(plain.Rec.Sort, undefined);
    assert.equal(plain.Rec.Limit, undefined);
    assert.deepEqual(plain.Rec.FindOptions, { projection: { _id: 0 } });
});
