import { RestHttpMethod } from "../rest/rest-http-client.js";
import type { IRestHttpClient, RestResponse } from "../rest/rest-http-client.js";

/** How the fake backend reports a source-assigned key after a POST insert. */
export enum RestInsertKeyMode
{
    /** The assigned key comes back as the id field in the response body. */
    Body = "body",
    /** The assigned key comes back only as the last path segment of a Location header. */
    Location = "location",
    /** Neither a body id nor a Location header (the adapter must report a failure). */
    None = "none",
}

/** In-memory REST backend honoring GET {base}/{source}, POST {base}/{source}, PUT/DELETE {base}/{source}/{key}. */
export class FakeRestHttpClient implements IRestHttpClient
{
    public static readonly FailField = "__fail";
    private static readonly OkStatus = 200;
    private static readonly CreatedStatus = 201;
    private static readonly ErrorStatus = 500;
    private static readonly IdField = "id";
    private static readonly VersionField = "rev";
    private static readonly ETagHeader = "ETag";
    private static readonly LocationHeader = "Location";
    private static readonly ETagValue = "v1";
    private static readonly IfMatchHeader = "If-Match";
    private static readonly PreconditionFailedStatus = 412;
    private static readonly PathSeparator = "/";
    private static readonly NoSource = "";
    private static readonly TrailingSlashes = /\/+$/;
    private readonly basePath: string;
    private readonly store = new Map<string, Map<string, Record<string, unknown>>>();
    private failStatus: number | undefined;
    private insertKeyMode: RestInsertKeyMode = RestInsertKeyMode.Body;
    private nextInsertId = 0;

    public constructor(baseUrl: string)
    {
        this.basePath = new URL(baseUrl).pathname.replace(FakeRestHttpClient.TrailingSlashes, "");
    }

    /** Choose how a POST insert reports its source-assigned key (body id, Location header, or neither). */
    public WithInsertKeyMode(mode: RestInsertKeyMode): this
    {
        this.insertKeyMode = mode;
        return this;
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

    public async Send(method: RestHttpMethod, url: string, headers: Record<string, string>, body?: unknown): Promise<RestResponse>
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
        if (method === RestHttpMethod.Post)
        {
            return this.Insert(source, bucket, body as Record<string, unknown> | undefined);
        }
        if (method === RestHttpMethod.Delete)
        {
            if (key !== undefined)
            {
                // A delete carrying If-Match is honored as a server would: it applies only when the stored version matches.
                const expected = headers[FakeRestHttpClient.IfMatchHeader];
                if (expected !== undefined && String(bucket.get(key)?.[FakeRestHttpClient.VersionField]) !== expected)
                {
                    return { Status: FakeRestHttpClient.PreconditionFailedStatus, Body: undefined };
                }
                bucket.delete(key);
            }
        }
        else if (key !== undefined)
        {
            bucket.set(key, { ...(body as Record<string, unknown>), [FakeRestHttpClient.IdField]: key });
        }
        return { Status: FakeRestHttpClient.OkStatus, Body: undefined };
    }

    /** Handles a POST insert: a FailField marker yields a 500; otherwise the server assigns the next id and reports it per the key mode. */
    private Insert(source: string, bucket: Map<string, Record<string, unknown>>, body: Record<string, unknown> | undefined): RestResponse
    {
        if (body !== undefined && FakeRestHttpClient.FailField in body)
        {
            return { Status: FakeRestHttpClient.ErrorStatus, Body: undefined };
        }
        const id = String(++this.nextInsertId);
        bucket.set(id, { ...(body ?? {}), [FakeRestHttpClient.IdField]: id });
        const etag = { [FakeRestHttpClient.ETagHeader]: FakeRestHttpClient.ETagValue };
        if (this.insertKeyMode === RestInsertKeyMode.Body)
        {
            return { Status: FakeRestHttpClient.CreatedStatus, Body: { [FakeRestHttpClient.IdField]: id }, Headers: etag };
        }
        if (this.insertKeyMode === RestInsertKeyMode.Location)
        {
            const location = `${this.basePath}${FakeRestHttpClient.PathSeparator}${source}${FakeRestHttpClient.PathSeparator}${id}`;
            return { Status: FakeRestHttpClient.CreatedStatus, Body: undefined, Headers: { ...etag, [FakeRestHttpClient.LocationHeader]: location } };
        }
        return { Status: FakeRestHttpClient.CreatedStatus, Body: undefined, Headers: {} };
    }

    private PathParts(url: string): [string, string | undefined]
    {
        const path = new URL(url).pathname;
        const tail = path.startsWith(this.basePath) ? path.slice(this.basePath.length) : path;
        const segments = tail.split(FakeRestHttpClient.PathSeparator).filter(s => s.length > 0).map(s => decodeURIComponent(s));
        return [segments[0] ?? FakeRestHttpClient.NoSource, segments[1]];
    }
}
