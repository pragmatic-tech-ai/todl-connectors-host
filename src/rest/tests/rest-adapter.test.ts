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

test("Query re-applies Where even when the server returns unfiltered rows", async () =>
{
    const client = new FakeRestHttpClient(BaseUrl);
    client.Seed(Customer, [{ id: "c1", label: "Acme" }, { id: "c2", label: "Globex" }]);
    client.IgnoreQueryParams(); // server returns everything regardless of filter
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
