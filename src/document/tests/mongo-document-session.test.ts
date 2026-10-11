import { test } from "node:test";
import assert from "node:assert/strict";
import { MongoDocumentSession } from "../mongo-document-session.js";

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
