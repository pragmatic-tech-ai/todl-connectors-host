import { test } from "node:test";
import assert from "node:assert/strict";
import { FetchRestHttpClient, RestHttpMethod } from "../rest-http-client.js";

class FakeFetch
{
    public static Calls = 0;

    public static CreateNonJson(status: number): typeof fetch
    {
        return (async () =>
        {
            return { ok: false, status, json: async () => { throw new SyntaxError("not json"); } } as unknown as Response;
        }) as unknown as typeof fetch;
    }

    public static CreateCounting(status: number, body: unknown): typeof fetch
    {
        const inner = FakeFetch.Create(status, body);
        return (async (url: string | URL, init?: RequestInit) =>
        {
            FakeFetch.Calls++;
            return inner(url, init);
        }) as unknown as typeof fetch;
    }

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

test("Send refuses plain http to a non-localhost host without calling fetch", async () =>
{
    FakeFetch.Calls = 0;
    const client = new FetchRestHttpClient({ fetch: FakeFetch.CreateCounting(200, {}) });
    await assert.rejects(() => client.Send(RestHttpMethod.Put, "http://api.example/x", {}, { label: "x" }), /https/i);
    assert.equal(FakeFetch.Calls, 0);
});

test("Send resolves with undefined Body for a non-JSON response", async () =>
{
    const client = new FetchRestHttpClient({ fetch: FakeFetch.CreateNonJson(502) });
    const res = await client.Send(RestHttpMethod.Post, "https://api.example/x", {}, { a: 1 });
    assert.deepEqual(res, { Status: 502, Body: undefined });
});

test("allows plain http to 127.0.0.1", async () =>
{
    const client = new FetchRestHttpClient({ fetch: FakeFetch.Create(200, []) });
    const json = await client.GetJson("http://127.0.0.1:5432/x", {});
    assert.deepEqual(json, []);
});
