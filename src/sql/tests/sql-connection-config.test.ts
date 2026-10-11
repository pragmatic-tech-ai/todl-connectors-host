import { test } from "node:test";
import assert from "node:assert/strict";
import { SqlConnectionConfig } from "../sql-connection-config.js";

test("From builds discrete pool options and injects the secret as password", () =>
{
    const opts = SqlConnectionConfig.From(
        { host: "db.internal", port: "5432", database: "app", user: "svc", ssl: "true" }, "s3cret");
    assert.equal(opts.host, "db.internal");
    assert.equal(opts.port, 5432);
    assert.equal(opts.database, "app");
    assert.equal(opts.user, "svc");
    assert.equal(opts.ssl, true);
    assert.equal(opts.password, "s3cret");
});

test("From passes a connectionString through and still injects the secret", () =>
{
    const opts = SqlConnectionConfig.From({ connectionString: "postgres://svc@db/app" }, "pw");
    assert.equal(opts.connectionString, "postgres://svc@db/app");
    assert.equal(opts.password, "pw");
});

test("From throws a secret-free error when neither connectionString nor database is given", () =>
{
    assert.throws(() => SqlConnectionConfig.From({ host: "db" }, "S3cretValue_XYZ"), (err: Error) =>
    {
        assert.match(err.message, /database/);
        assert.doesNotMatch(err.message, /S3cretValue_XYZ/);
        return true;
    });
});

test("From rejects empty/Infinity port and accepts a valid one", () =>
{
    assert.throws(() => SqlConnectionConfig.From({ database: "app", port: "" }), /'port' must be a number/);
    assert.throws(() => SqlConnectionConfig.From({ database: "app", port: "Infinity" }), /'port' must be a number/);
    assert.equal(SqlConnectionConfig.From({ database: "app", port: "5432" }).port, 5432);
});

test("From treats an empty database/connectionString as missing", () =>
{
    assert.throws(() => SqlConnectionConfig.From({ database: "", connectionString: "" }, "S3cretValue_XYZ"), /database/);
});

test("From throws a secret-free error when port is not numeric", () =>
{
    assert.throws(() => SqlConnectionConfig.From({ database: "app", port: "abc" }, "S3cretValue_XYZ"), (err: Error) =>
    {
        assert.match(err.message, /port/);
        assert.doesNotMatch(err.message, /S3cretValue_XYZ/);
        return true;
    });
});

test("From omits password when no secret is supplied", () =>
{
    const opts = SqlConnectionConfig.From({ connectionString: "postgres://db/app" });
    assert.equal(opts.password, undefined);
});
