import { RestHttpMethod } from "../rest/rest-http-client.js";
import type { IRestHttpClient, RestResponse } from "../rest/rest-http-client.js";

/** In-memory REST backend honoring GET {base}/{source}, PUT/DELETE {base}/{source}/{key}. */
export class FakeRestHttpClient implements IRestHttpClient
{
    private static readonly OkStatus = 200;
    private static readonly IdField = "id";
    private static readonly PathSeparator = "/";
    private static readonly NoSource = "";
    private static readonly TrailingSlashes = /\/+$/;
    private readonly basePath: string;
    private readonly store = new Map<string, Map<string, Record<string, unknown>>>();
    private failStatus: number | undefined;

    public constructor(baseUrl: string)
    {
        this.basePath = new URL(baseUrl).pathname.replace(FakeRestHttpClient.TrailingSlashes, "");
    }

    public Seed(source: string, records: Record<string, unknown>[]): this
    {
        const bucket = new Map<string, Record<string, unknown>>();
        for (const r of records) bucket.set(String(r[FakeRestHttpClient.IdField]), { ...r });
        this.store.set(source, bucket);
        return this;
    }

    /** Force the next Send to return this status (e.g. 409). */
    public FailNextWith(status: number): this { this.failStatus = status; return this; }

    public async GetJson(url: string, _headers?: Record<string, string>): Promise<unknown>
    {
        const [source] = this.PathParts(url);
        return [...(this.store.get(source)?.values() ?? [])];
    }

    public async Send(method: RestHttpMethod, url: string, _headers: Record<string, string>, body?: unknown): Promise<RestResponse>
    {
        if (this.failStatus !== undefined)
        {
            const status = this.failStatus;
            this.failStatus = undefined;
            return { Status: status, Body: undefined };
        }
        const [source, key] = this.PathParts(url);
        const bucket = this.store.get(source) ?? new Map<string, Record<string, unknown>>();
        this.store.set(source, bucket);
        if (method === RestHttpMethod.Delete)
        {
            if (key !== undefined) bucket.delete(key);
        }
        else if (key !== undefined)
        {
            bucket.set(key, { ...(body as Record<string, unknown>), [FakeRestHttpClient.IdField]: key });
        }
        return { Status: FakeRestHttpClient.OkStatus, Body: undefined };
    }

    private PathParts(url: string): [string, string | undefined]
    {
        const path = new URL(url).pathname;
        const tail = path.startsWith(this.basePath) ? path.slice(this.basePath.length) : path;
        const segments = tail.split(FakeRestHttpClient.PathSeparator).filter(s => s.length > 0).map(s => decodeURIComponent(s));
        return [segments[0] ?? FakeRestHttpClient.NoSource, segments[1]];
    }
}
