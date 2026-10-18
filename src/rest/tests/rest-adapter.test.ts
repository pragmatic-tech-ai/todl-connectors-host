import { test } from "node:test";
import assert from "node:assert/strict";
import { ConnectionFailureKind, QueryCompareOp, WriteAtomicity, WriteConcurrency, WriteFailureKind, WriteOperationKind } from "@pragmatic-tech-ai/todl";
import type { WriteBatch } from "@pragmatic-tech-ai/todl";
import { RestAdapter } from "../rest-adapter.js";
import { RestConnectionConfig } from "../rest-connection-config.js";
import { RestHttpMethod } from "../rest-http-client.js";
import type { RestResponse } from "../rest-http-client.js";
import { FakeRestHttpClient } from "../../testing/fake-rest-http-client.js";
import { describeDataSourceAdapter } from "../../testing/adapter-conformance.js";

const BaseUrl = "https://api.example/v1";
const Customer = "Customer";
const Token = "tok";
const IfMatch = "If-Match";

/** Records every Send so a test can assert which headers (If-Match) went out, or that no PUT issued. */
class CapturingRestHttpClient extends FakeRestHttpClient
{
    public readonly Sends: { method: RestHttpMethod; headers: Record<string, string> }[] = [];

    public override async Send(method: RestHttpMethod, url: string, headers: Record<string, string>, body?: unknown): Promise<RestResponse>
    {
        this.Sends.push({ method, headers: { ...headers } });
        return super.Send(method, url, headers, body);
    }
}

/** Throws a transport fault on any Send whose url carries the given key; other ops succeed. */
class ThrowingRestHttpClient extends FakeRestHttpClient
{
    public constructor(baseUrl: string, private readonly throwKey: string)
    {
        super(baseUrl);
    }

    public override async Send(method: RestHttpMethod, url: string, headers: Record<string, string>, body?: unknown): Promise<RestResponse>
    {
        if (url.includes(this.throwKey)) throw new Error("transport exploded");
        return super.Send(method, url, headers, body);
    }
}

class RestAdapterFixture
{
    public static Make(): RestAdapter
    {
        const client = new FakeRestHttpClient(BaseUrl);
        client.Seed(Customer, [{ id: "c1", label: "Acme" }]);
        return new RestAdapter(client, RestConnectionConfig.From({ baseUrl: BaseUrl }));
    }
}

describeDataSourceAdapter("RestAdapter (fake client)", () => RestAdapterFixture.Make());

test("RestConnectionConfig turns a secret into a bearer header, not a url", () =>
{
    const cfg = RestConnectionConfig.From({ baseUrl: BaseUrl }, Token);
    assert.equal(cfg.headers["Authorization"], `Bearer ${Token}`);
    assert.doesNotMatch(cfg.baseUrl, new RegExp(Token));
});

test("Query re-applies Where even when the server returns unfiltered rows (fake returns both)", async () =>
{
    const client = new FakeRestHttpClient(BaseUrl);
    client.Seed(Customer, [{ id: "c1", label: "Acme" }, { id: "c2", label: "Globex" }]);
    const adapter = new RestAdapter(client, RestConnectionConfig.From({ baseUrl: BaseUrl }));
    const rows = await adapter.Query(
        { Source: Customer, Fields: ["id"], Where: { All: [{ Field: "id", Op: QueryCompareOp.Eq, Value: "c2" }] } });
    assert.deepEqual(rows, [{ id: "c2" }]);
});

test("REST advertises CanVersion (via If-Match) but not CanTransact", () =>
{
    const adapter = RestAdapterFixture.Make();
    assert.equal(adapter.CanVersion, true);
    assert.equal(adapter.CanTransact, false);
});

test("a LastWriteWins upsert PUTs unconditionally, sending no If-Match", async () =>
{
    const client = new CapturingRestHttpClient(BaseUrl);
    client.Seed(Customer, [{ id: "c1", label: "Acme" }]);
    const adapter = new RestAdapter(client, RestConnectionConfig.From({ baseUrl: BaseUrl }));
    const result = await adapter.Apply({
        Source: Customer, IdKey: "id", Concurrency: WriteConcurrency.LastWriteWins, Atomicity: WriteAtomicity.Sequential,
        Operations: [{ Kind: WriteOperationKind.Upsert, Key: "c1", Fields: { label: "x" } }],
    });
    assert.equal(result.Applied, 1);
    assert.equal(client.Sends.length, 1);
    assert.equal(client.Sends[0]!.method, RestHttpMethod.Put);
    assert.equal(IfMatch in client.Sends[0]!.headers, false);
});

test("an Optimistic upsert sends If-Match with the op version", async () =>
{
    const client = new CapturingRestHttpClient(BaseUrl);
    client.Seed(Customer, [{ id: "c1", label: "Acme" }]);
    const adapter = new RestAdapter(client, RestConnectionConfig.From({ baseUrl: BaseUrl }));
    const result = await adapter.Apply({
        Source: Customer, IdKey: "id", Concurrency: WriteConcurrency.Optimistic, Atomicity: WriteAtomicity.Sequential, VersionField: "rev",
        Operations: [{ Kind: WriteOperationKind.Upsert, Key: "c1", Fields: { label: "x" }, Version: "v1" }],
    });
    assert.equal(result.Applied, 1);
    assert.equal(client.Sends[0]!.headers[IfMatch], "v1");
});

test("an Optimistic upsert with a missing op version is a Conflict and issues no PUT (fail-closed)", async () =>
{
    const client = new CapturingRestHttpClient(BaseUrl);
    client.Seed(Customer, [{ id: "c1", label: "Acme" }]);
    const adapter = new RestAdapter(client, RestConnectionConfig.From({ baseUrl: BaseUrl }));
    const result = await adapter.Apply({
        Source: Customer, IdKey: "id", Concurrency: WriteConcurrency.Optimistic, Atomicity: WriteAtomicity.Sequential, VersionField: "rev",
        Operations: [{ Kind: WriteOperationKind.Upsert, Key: "c1", Fields: { label: "x" } }],
    });
    assert.equal(result.Applied, 0);
    assert.equal(result.Failures.length, 1);
    assert.equal(result.Failures[0]!.Kind, WriteFailureKind.Conflict);
    assert.equal(client.Sends.length, 0);
});

test("a Transactional batch is wholly Unsupported on REST, with nothing applied and no request issued", async () =>
{
    const client = new CapturingRestHttpClient(BaseUrl);
    client.Seed(Customer, [{ id: "c1", label: "Acme" }]);
    const adapter = new RestAdapter(client, RestConnectionConfig.From({ baseUrl: BaseUrl }));
    const result = await adapter.Apply({
        Source: Customer, IdKey: "id", Concurrency: WriteConcurrency.LastWriteWins, Atomicity: WriteAtomicity.Transactional,
        Operations: [
            { Kind: WriteOperationKind.Upsert, Key: "c1", Fields: { label: "x" } },
            { Kind: WriteOperationKind.Upsert, Key: "c2", Fields: { label: "y" } },
        ],
    });
    assert.equal(result.Applied, 0);
    assert.equal(result.Failures.length, 2);
    assert.ok(result.Failures.every(f => f.Kind === WriteFailureKind.Unsupported));
    assert.equal(client.Sends.length, 0);
});

test("a mid-batch transport error is collected as an Error and the loop continues", async () =>
{
    const client = new ThrowingRestHttpClient(BaseUrl, "c1");
    client.Seed(Customer, [{ id: "c1", label: "Acme" }]);
    const adapter = new RestAdapter(client, RestConnectionConfig.From({ baseUrl: BaseUrl }));
    const result = await adapter.Apply({
        Source: Customer, IdKey: "id", Concurrency: WriteConcurrency.LastWriteWins, Atomicity: WriteAtomicity.Sequential,
        Operations: [
            { Kind: WriteOperationKind.Upsert, Key: "c1", Fields: { label: "x" } },
            { Kind: WriteOperationKind.Upsert, Key: "c2", Fields: { label: "y" } },
        ],
    });
    assert.equal(result.Applied, 1);
    assert.equal(result.Failures.length, 1);
    assert.equal(result.Failures[0]!.Key, "c1");
    assert.equal(result.Failures[0]!.Kind, WriteFailureKind.Error);
});

test("a 409 on an optimistic upsert is a conflict, not applied, never thrown", async () =>
{
    const client = new FakeRestHttpClient(BaseUrl);
    client.Seed(Customer, [{ id: "c1", label: "Acme" }]);
    client.FailNextWith(409);
    const adapter = new RestAdapter(client, RestConnectionConfig.From({ baseUrl: BaseUrl }));
    const result = await adapter.Apply({ Source: Customer, IdKey: "id", VersionField: "rev",
        Concurrency: WriteConcurrency.Optimistic, Atomicity: WriteAtomicity.Sequential,
        Operations: [{ Kind: WriteOperationKind.Upsert, Key: "c1", Fields: { label: "x" }, Version: "stale" }] });
    assert.equal(result.Applied, 0);
    assert.equal(result.Failures.length, 1);
    assert.equal(result.Failures[0]!.Key, "c1");
    assert.equal(result.Failures[0]!.Kind, WriteFailureKind.Conflict);
});

class RestFailureFixture
{
    public static Make(status: number): RestAdapter
    {
        const client = new FakeRestHttpClient(BaseUrl);
        client.Seed(Customer, [{ id: "c1", label: "Acme" }]);
        client.FailNextWith(status);
        return new RestAdapter(client, RestConnectionConfig.From({ baseUrl: BaseUrl }, Token));
    }

    public static Upsert(version: boolean): WriteBatch
    {
        return {
            Source: Customer, IdKey: "id",
            Concurrency: version ? WriteConcurrency.Optimistic : WriteConcurrency.LastWriteWins,
            Atomicity: WriteAtomicity.Sequential,
            ...(version ? { VersionField: "rev" } : {}),
            Operations: [{ Kind: WriteOperationKind.Upsert, Key: "c1", Fields: { label: "x" }, ...(version ? { Version: "v1" } : {}) }],
        };
    }

    public static Delete(): WriteBatch
    {
        return {
            Source: Customer, IdKey: "id",
            Concurrency: WriteConcurrency.LastWriteWins, Atomicity: WriteAtomicity.Sequential,
            Operations: [{ Kind: WriteOperationKind.Delete, Key: "c1", Fields: {} }],
        };
    }
}

test("a 500 on upsert is collected as a status-only Error without the secret, not thrown", async () =>
{
    const result = await RestFailureFixture.Make(500).Apply(RestFailureFixture.Upsert(false));
    assert.equal(result.Applied, 0);
    assert.equal(result.Failures.length, 1);
    assert.equal(result.Failures[0]!.Kind, WriteFailureKind.Error);
    assert.match(result.Failures[0]!.Reason, /500/);
    assert.ok(!result.Failures[0]!.Reason.includes(Token));
    assert.ok(!result.Failures[0]!.Reason.includes(BaseUrl));
});

test("a 412 on an optimistic upsert is a conflict, not applied, not thrown", async () =>
{
    const result = await RestFailureFixture.Make(412).Apply(RestFailureFixture.Upsert(true));
    assert.equal(result.Applied, 0);
    assert.equal(result.Failures.length, 1);
    assert.equal(result.Failures[0]!.Kind, WriteFailureKind.Conflict);
});

test("a 404 on delete is tolerated as already absent", async () =>
{
    const result = await RestFailureFixture.Make(404).Apply(RestFailureFixture.Delete());
    assert.equal(result.Applied, 1);
    assert.equal(result.Failures.length, 0);
});

test("a 500 on delete is collected as an Error, not thrown", async () =>
{
    const result = await RestFailureFixture.Make(500).Apply(RestFailureFixture.Delete());
    assert.equal(result.Applied, 0);
    assert.equal(result.Failures.length, 1);
    assert.equal(result.Failures[0]!.Kind, WriteFailureKind.Error);
});

test("a trailing slash on baseUrl is normalized away", () =>
{
    assert.equal(RestConnectionConfig.From({ baseUrl: `${BaseUrl}/` }).baseUrl, BaseUrl);
});

test("a non-array GET payload throws instead of reading as empty", async () =>
{
    const client = { GetJson: async () => ({ not: "array" }), Send: async () => ({ Status: 200, Body: undefined }) };
    const adapter = new RestAdapter(client, RestConnectionConfig.From({ baseUrl: BaseUrl }));
    await assert.rejects(adapter.Query({ Source: Customer, Fields: ["id"] }), /non-array/);
});

test("RestAdapter.ClassifyFailure delegates to the fetch classifier", () =>
{
    const adapter = new RestAdapter({ GetJson: async () => [], Send: async () => ({ Status: 200, Body: undefined }) }, RestConnectionConfig.From({ baseUrl: BaseUrl }));
    assert.equal(adapter.ClassifyFailure({ status: 503 }), ConnectionFailureKind.Transient);
    assert.equal(adapter.ClassifyFailure(new TypeError("fetch failed")), ConnectionFailureKind.Transient);
    assert.equal(adapter.ClassifyFailure({ status: 401 }), ConnectionFailureKind.Auth);
    assert.equal(adapter.ClassifyFailure({ status: 404 }), ConnectionFailureKind.Permanent);
});
