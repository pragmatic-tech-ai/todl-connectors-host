import { test } from "node:test";
import assert from "node:assert/strict";
import { FetchRestHttpClient, RestHttpMethod } from "../rest-http-client.js";

class FakeFetch
{
    public static Create(status: number, body: unknown): typeof fetch
    {
        return (async (url: string | URL) =>
        {
            void url;
            return {
                ok: status >= 200 && status < 300,
                status,
                json: async () => body,
            } as Response;
        }) as unknown as typeof fetch;
    }
}

test("GetJson returns parsed JSON on 2xx", async () =>
{
    const client = new FetchRestHttpClient({ fetch: FakeFetch.Create(200, [{ id: "c1" }]) });
    const json = await client.GetJson("https://api.example/Customer", {});
    assert.deepEqual(json, [{ id: "c1" }]);
});

test("GetJson throws on a non-2xx status", async () =>
{
    const client = new FetchRestHttpClient({ fetch: FakeFetch.Create(500, {}) });
    await assert.rejects(() => client.GetJson("https://api.example/Customer", {}));
});

test("Send returns the status and body", async () =>
{
    const client = new FetchRestHttpClient({ fetch: FakeFetch.Create(409, { error: "conflict" }) });
    const res = await client.Send(RestHttpMethod.Put, "https://api.example/Customer/c1", {}, { label: "x" });
    assert.equal(res.Status, 409);
});

test("refuses plain http to a non-localhost host", async () =>
{
    const client = new FetchRestHttpClient({ fetch: FakeFetch.Create(200, []) });
    await assert.rejects(() => client.GetJson("http://api.example/Customer", {}), /https/i);
});

test("allows plain http to localhost", async () =>
{
    const client = new FetchRestHttpClient({ fetch: FakeFetch.Create(200, []) });
    const json = await client.GetJson("http://localhost:3000/Customer", {});
    assert.deepEqual(json, []);
});
