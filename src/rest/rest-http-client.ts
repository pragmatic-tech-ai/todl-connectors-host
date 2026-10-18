/** HTTP verbs this host issues for writes/GraphQL. */
export enum RestHttpMethod
{
    Put = "PUT",
    Delete = "DELETE",
    Post = "POST",
}

/** A raw HTTP response the adapter inspects (status drives conflict mapping). */
export interface RestResponse
{
    readonly Status: number;
    readonly Body: unknown;
}

/** The injected HTTP seam: adapters own URLs/bodies, the host owns transport. */
export interface IRestHttpClient
{
    GetJson(url: string, headers: Record<string, string>): Promise<unknown>;
    Send(method: RestHttpMethod, url: string, headers: Record<string, string>, body?: unknown): Promise<RestResponse>;
}

/** A non-2xx transport failure carrying its numeric HTTP status (the message stays "http request failed with status <N>"). */
export class HttpStatusError extends Error
{
    private static readonly ErrorName = "HttpStatusError";

    public constructor(message: string, public readonly status: number)
    {
        super(message);
        this.name = HttpStatusError.ErrorName;
    }
}

/** Production client over global fetch: HTTPS enforced for non-localhost, bounded timeout. */
export class FetchRestHttpClient implements IRestHttpClient
{
    private static readonly HttpsProtocol = "https:";
    private static readonly LocalHosts: readonly string[] = ["localhost", "127.0.0.1", "[::1]"];
    private static readonly InsecureMessage = "refusing non-https request to non-localhost host";
    private static readonly ContentTypeHeader = "content-type";
    private static readonly JsonContentType = "application/json";
    private static readonly DefaultTimeoutMs = 30000;
    private static readonly NonOkMessage = "http request failed with status";

    private readonly fetchFn: typeof fetch;
    private readonly timeoutMs: number;

    public constructor(options?: { fetch?: typeof fetch; timeoutMs?: number })
    {
        this.fetchFn = options?.fetch ?? fetch;
        this.timeoutMs = options?.timeoutMs ?? FetchRestHttpClient.DefaultTimeoutMs;
    }

    public async GetJson(url: string, headers: Record<string, string>): Promise<unknown>
    {
        FetchRestHttpClient.EnforceTransport(url);
        const response = await this.fetchFn(url, { headers, signal: AbortSignal.timeout(this.timeoutMs) });
        if (!response.ok) throw new HttpStatusError(`${FetchRestHttpClient.NonOkMessage} ${response.status}`, response.status);
        return response.json();
    }

    public async Send(method: RestHttpMethod, url: string, headers: Record<string, string>, body?: unknown): Promise<RestResponse>
    {
        FetchRestHttpClient.EnforceTransport(url);
        const init: RequestInit = { method, headers: { ...headers }, signal: AbortSignal.timeout(this.timeoutMs) };
        if (body !== undefined)
        {
            (init.headers as Record<string, string>)[FetchRestHttpClient.ContentTypeHeader] = FetchRestHttpClient.JsonContentType;
            init.body = JSON.stringify(body);
        }
        const response = await this.fetchFn(url, init);
        const payload = await response.json().catch(() => undefined);
        return { Status: response.status, Body: payload };
    }

    private static EnforceTransport(url: string): void
    {
        const parsed = new URL(url);
        if (parsed.protocol === FetchRestHttpClient.HttpsProtocol) return;
        if (FetchRestHttpClient.LocalHosts.includes(parsed.hostname)) return;
        throw new Error(FetchRestHttpClient.InsecureMessage);
    }
}
