import { test } from "node:test";
import assert from "node:assert/strict";
import { QueryCompareOp, WriteOperationKind } from "@pragmatic-tech-ai/todl";
import { RestAdapter } from "../rest-adapter.js";
import { RestConnectionConfig } from "../rest-connection-config.js";
import { FakeRestHttpClient } from "../../testing/fake-rest-http-client.js";
import { describeDataSourceAdapter } from "../../testing/adapter-conformance.js";

const BaseUrl = "https://api.example/v1";
const Customer = "Customer";
const Token = "tok";

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

test("a 409 on an optimistic upsert is a conflict, not applied, never thrown", async () =>
{
    const client = new FakeRestHttpClient(BaseUrl);
    client.Seed(Customer, [{ id: "c1", label: "Acme" }]);
    client.FailNextWith(409);
    const adapter = new RestAdapter(client, RestConnectionConfig.From({ baseUrl: BaseUrl }));
    const result = await adapter.Apply({ Source: Customer, IdKey: "id", VersionField: "rev",
        Operations: [{ Kind: WriteOperationKind.Upsert, Key: "c1", Fields: { label: "x" }, Version: "stale" }] });
    assert.equal(result.Applied, 0);
    assert.equal(result.Conflicts.length, 1);
    assert.equal(result.Conflicts[0]!.Key, "c1");
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

    public static Upsert(version: boolean): { Source: string; IdKey: string; VersionField?: string; Operations: any[] }
    {
        return { Source: Customer, IdKey: "id", ...(version ? { VersionField: "rev" } : {}),
            Operations: [{ Kind: WriteOperationKind.Upsert, Key: "c1", Fields: { label: "x" }, ...(version ? { Version: "v1" } : {}) }] };
    }

    public static Delete(): { Source: string; IdKey: string; Operations: any[] }
    {
        return { Source: Customer, IdKey: "id", Operations: [{ Kind: WriteOperationKind.Delete, Key: "c1", Fields: {} }] };
    }
}

test("a 500 on upsert throws a status-only error without the secret", async () =>
{
    await assert.rejects(RestFailureFixture.Make(500).Apply(RestFailureFixture.Upsert(false)),
        (e: Error) => e.message.includes("500") && !e.message.includes(Token) && !e.message.includes(BaseUrl));
});

test("a 412 on an optimistic upsert is a conflict, not applied, not thrown", async () =>
{
    const result = await RestFailureFixture.Make(412).Apply(RestFailureFixture.Upsert(true));
    assert.equal(result.Applied, 0);
    assert.equal(result.Conflicts.length, 1);
});

test("a 404 on delete is tolerated as already absent", async () =>
{
    const result = await RestFailureFixture.Make(404).Apply(RestFailureFixture.Delete());
    assert.equal(result.Applied, 1);
    assert.equal(result.Conflicts.length, 0);
});

test("a 500 on delete throws", async () =>
{
    await assert.rejects(RestFailureFixture.Make(500).Apply(RestFailureFixture.Delete()), /500/);
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
