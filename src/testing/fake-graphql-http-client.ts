import { RestHttpMethod } from "../rest/rest-http-client.js";
import type { IRestHttpClient, RestResponse } from "../rest/rest-http-client.js";
import type { GraphQlConnection } from "../rest/graphql-adapter.js";

/** A GraphQL error the fake backend can inject, carrying an optional `extensions.code`, `path`, and extra extensions. */
export interface FakeGraphQlError
{
    readonly Message: string;
    readonly Code?: string;
    readonly Path?: readonly (string | number)[];
    readonly Extensions?: Record<string, unknown>;
}

/** Per-op injection: fail with errors, override the returned id, keep a data payload alongside errors, or override status. */
export interface FakeGraphQlInjection
{
    readonly Errors?: readonly FakeGraphQlError[];
    readonly ReturnId?: string;
    readonly WithData?: boolean;
    readonly Status?: number;
}

/** A captured request so tests can assert the exact document and variables the adapter sent. */
export interface FakeGraphQlRequest
{
    readonly Query: string;
    readonly Variables: Record<string, unknown>;
}

/** In-memory GraphQL backend: recognizes the configured query/mutation names, records sent requests, and injects per-op errors. */
export class FakeGraphQlHttpClient implements IRestHttpClient
{
    private static readonly OkStatus = 200;
    private static readonly IdKey = "id";
    private static readonly DataKey = "data";
    private static readonly ErrorsKey = "errors";
    private static readonly MessageKey = "message";
    private static readonly PathKey = "path";
    private static readonly ExtensionsKey = "extensions";
    private static readonly CodeKey = "code";
    private readonly store = new Map<string, Record<string, unknown>>();
    private readonly injections = new Map<string, FakeGraphQlInjection>();

    /** Every request the adapter sent, in order, for exact document/variable assertions. */
    public readonly Sent: FakeGraphQlRequest[] = [];

    public constructor(private readonly connection: GraphQlConnection)
    {
    }

    public Seed(records: Record<string, unknown>[]): this
    {
        for (const r of records) this.store.set(String(r[FakeGraphQlHttpClient.IdKey]), { ...r });
        return this;
    }

    /** Programs the per-op response for a given key (matched by the op's id in the request variables). */
    public Inject(key: string, injection: FakeGraphQlInjection): this
    {
        this.injections.set(key, injection);
        return this;
    }

    public async GetJson(): Promise<unknown>
    {
        return undefined; // GraphQL goes through Send(POST)
    }

    public async Send(_method: RestHttpMethod, _url: string, _headers: Record<string, string>, body?: unknown): Promise<RestResponse>
    {
        const doc = body as { query?: string; variables?: Record<string, unknown> } | undefined;
        const query = doc?.query ?? "";
        const vars = doc?.variables ?? {};
        this.Sent.push({ Query: query, Variables: vars });
        if (this.connection.upsertMutation !== undefined && query.includes(this.connection.upsertMutation))
        {
            return this.HandleUpsert(this.connection.upsertMutation, vars);
        }
        if (this.connection.deleteMutation !== undefined && query.includes(this.connection.deleteMutation))
        {
            return this.HandleDelete(this.connection.deleteMutation, vars);
        }
        return this.Ok({ [this.connection.queryField]: [...this.store.values()] });
    }

    private HandleUpsert(mutation: string, vars: Record<string, unknown>): RestResponse
    {
        const input = vars[this.connection.upsertInputArg] as Record<string, unknown>;
        const key = String(input[FakeGraphQlHttpClient.IdKey]);
        const injection = this.injections.get(key);
        if (injection?.Errors !== undefined)
        {
            return this.Fail(injection, mutation, input);
        }
        this.store.set(key, { ...input });
        const payload = injection?.ReturnId !== undefined ? { ...input, [FakeGraphQlHttpClient.IdKey]: injection.ReturnId } : input;
        return { Status: injection?.Status ?? FakeGraphQlHttpClient.OkStatus, Body: { [FakeGraphQlHttpClient.DataKey]: { [mutation]: payload } } };
    }

    private HandleDelete(mutation: string, vars: Record<string, unknown>): RestResponse
    {
        const key = String(vars[this.connection.deleteIdArg]);
        const injection = this.injections.get(key);
        if (injection?.Errors !== undefined)
        {
            return this.Fail(injection, mutation, true);
        }
        this.store.delete(key);
        return this.Ok({ [mutation]: true });
    }

    /** Emits a GraphQL `errors` array; a null `data` unless the injection asks for a partial-success payload. */
    private Fail(injection: FakeGraphQlInjection, mutation: string, successPayload: unknown): RestResponse
    {
        const errors = injection.Errors!.map(e => FakeGraphQlHttpClient.ToGraphQlError(e));
        const data = injection.WithData === true ? { [mutation]: successPayload } : null;
        return { Status: injection.Status ?? FakeGraphQlHttpClient.OkStatus, Body: { [FakeGraphQlHttpClient.DataKey]: data, [FakeGraphQlHttpClient.ErrorsKey]: errors } };
    }

    private static ToGraphQlError(error: FakeGraphQlError): Record<string, unknown>
    {
        const extensions: Record<string, unknown> = { ...(error.Extensions ?? {}) };
        if (error.Code !== undefined) extensions[FakeGraphQlHttpClient.CodeKey] = error.Code;
        const out: Record<string, unknown> = { [FakeGraphQlHttpClient.MessageKey]: error.Message };
        if (error.Path !== undefined) out[FakeGraphQlHttpClient.PathKey] = error.Path;
        if (Object.keys(extensions).length > 0) out[FakeGraphQlHttpClient.ExtensionsKey] = extensions;
        return out;
    }

    private Ok(data: Record<string, unknown>): RestResponse
    {
        return { Status: FakeGraphQlHttpClient.OkStatus, Body: { [FakeGraphQlHttpClient.DataKey]: data } };
    }
}
