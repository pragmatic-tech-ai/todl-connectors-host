import { mock, test } from "node:test";
import assert from "node:assert/strict";
import { ServiceProvider } from "@pragmatic-tech-ai/todl-runtime";
import { DataSourceAdapterCatalog, DataSourceKind, ConnectionResolverKey, ResolutionAuditSinkKey } from "@pragmatic-tech-ai/todl";
import type { IConnectionResolver, ResolvedConnection, ConnectorSpec, IDataSourceAdapter, IDataSourceAdapterFactory, IDataSourceAdapterProvider } from "@pragmatic-tech-ai/todl";
import { ConnectorsHost } from "../connectors-host.js";
import { RecordingResolutionAuditSink } from "../resolution-audit/recording-resolution-audit-sink.js";
import { FakeRestHttpClient } from "../testing/fake-rest-http-client.js";
import type { Pool } from "pg";

class HostTestSupport
{
    public static readonly RestBaseUrl = "https://api.example";
    public static readonly SqlConnectorName = "s";
    public static readonly Database = "app";
    public static readonly BaseUrlKey = "baseUrl";

    public static SpecOf(name: string, kind: DataSourceKind, config: Record<string, string>): ConnectorSpec
    {
        return { Name: name, Kind: kind, Config: config };
    }

    public static FakePool(onEnd: () => void): Pool
    {
        return {
            query: async () => ({ rows: [], rowCount: 0 }),
            end: async () => { onEnd(); }
        } as unknown as Pool;
    }
}

test("Register places the catalog under DataSourceAdapterCatalog.ServiceKey", () =>
{
    const services = new ServiceProvider();
    const host = new ConnectorsHost();
    host.Register(services);
    assert.equal(services.getRequired(DataSourceAdapterCatalog.ServiceKey), host.Catalog);
});

test("all four kinds route to a factory (not the 'no adapter for kind' error)", async () =>
{
    const host = new ConnectorsHost();
    const services = new ServiceProvider();
    await assert.rejects(() => host.Catalog.Open(HostTestSupport.SpecOf("c", DataSourceKind.Cypher, {}), services), /uri/);
    await assert.rejects(() => host.Catalog.Open(HostTestSupport.SpecOf("d", DataSourceKind.Document, {}), services), /url/);
    await assert.rejects(() => host.Catalog.Open(HostTestSupport.SpecOf(HostTestSupport.SqlConnectorName, DataSourceKind.Sql, {}), services), /database|connectionString/);
    const withRest = new ConnectorsHost({ restClient: new FakeRestHttpClient(HostTestSupport.RestBaseUrl) });
    const rest = await withRest.Catalog.Open(HostTestSupport.SpecOf("r", DataSourceKind.Rest, { [HostTestSupport.BaseUrlKey]: HostTestSupport.RestBaseUrl }), services);
    assert.ok(rest);
});

test("Dispose tears down the catalog without throwing", async () =>
{
    let ended = 0;
    const host = new ConnectorsHost({ buildPool: () => HostTestSupport.FakePool(() => { ended++; }) });
    const services = new ServiceProvider();
    await host.Catalog.Open(HostTestSupport.SpecOf(HostTestSupport.SqlConnectorName, DataSourceKind.Sql, { database: HostTestSupport.Database }), services);
    await host.Dispose();
    assert.equal(ended, 1);
});

test("an options resolver is registered under ConnectionResolverKey", () =>
{
    const resolver: IConnectionResolver = { Resolve: async (spec): Promise<ResolvedConnection> => ({ Kind: spec.Kind, Config: spec.Config }) };
    const services = new ServiceProvider();
    new ConnectorsHost({ connectionResolver: resolver }).Register(services);
    assert.equal(services.getRequired(ConnectionResolverKey), resolver);
});

test("Register wires the audit sink under ResolutionAuditSinkKey when provided", () =>
{
    const sink = new RecordingResolutionAuditSink();
    const services = new ServiceProvider();
    new ConnectorsHost({ auditSink: sink }).Register(services);
    assert.equal(services.getRequired(ResolutionAuditSinkKey), sink);
});

test("without an audit sink the key is absent", () =>
{
    const services = new ServiceProvider();
    new ConnectorsHost().Register(services);
    assert.equal(services.has(ResolutionAuditSinkKey), false);
});

class FakeProvider implements IDataSourceAdapterProvider
{
    public Disposed = 0;
    public readonly Requests: { Kind: DataSourceKind; Provider?: string }[] = [];

    public constructor(private readonly adapter: IDataSourceAdapter)
    {
    }

    public async Resolve(request: { Kind: DataSourceKind; Provider?: string }): Promise<IDataSourceAdapterFactory>
    {
        this.Requests.push(request);
        const adapter = this.adapter;
        return { Kind: request.Kind, Open: async () => adapter };
    }

    public async Dispose(): Promise<void>
    {
        this.Disposed++;
    }
}

test("a connector naming a provider resolves through the host's provider", async () =>
{
    const adapter = { Dispose: async () => { } } as unknown as IDataSourceAdapter;
    const provider = new FakeProvider(adapter);
    const host = new ConnectorsHost({ provider });
    const spec: ConnectorSpec = { Name: "p", Kind: DataSourceKind.Rest, Config: {}, Provider: "pack@1" };
    const opened = await host.Catalog.Open(spec, new ServiceProvider());
    assert.equal(opened, adapter);
    assert.deepEqual(provider.Requests, [{ Kind: DataSourceKind.Rest, Provider: "pack@1" }]);
});

test("host Dispose disposes the provider", async () =>
{
    const provider = new FakeProvider({} as unknown as IDataSourceAdapter);
    const host = new ConnectorsHost({ provider });
    await host.Dispose();
    assert.equal(provider.Disposed, 1);
});

test("host Dispose tolerates a provider without Dispose", async () =>
{
    const plain: IDataSourceAdapterProvider = { Resolve: async () => { throw new Error("unused"); } };
    await new ConnectorsHost({ provider: plain }).Dispose();
});

test("host Dispose swallows a provider Dispose rejection", async () =>
{
    const failing = { Resolve: async () => { throw new Error("unused"); }, Dispose: async () => { throw new Error("boom"); } };
    const warn = mock.method(console, "warn", () => { });
    try
    {
        await new ConnectorsHost({ provider: failing as IDataSourceAdapterProvider }).Dispose();
        assert.equal(warn.mock.callCount(), 1, "the swallowed provider error must be surfaced, not silently dropped");
    }
    finally
    {
        warn.mock.restore();
    }
});

test("host Dispose disposes the catalog before the provider", async () =>
{
    const order: string[] = [];
    const provider = new FakeProvider({} as unknown as IDataSourceAdapter);
    provider.Dispose = async (): Promise<void> => { order.push("provider"); };
    const host = new ConnectorsHost({ provider });
    host.Catalog.Dispose = async (): Promise<void> => { order.push("catalog"); };
    await host.Dispose();
    assert.deepEqual(order, ["catalog", "provider"]);
});

test("a second host Dispose is harmless", async () =>
{
    const provider = new FakeProvider({} as unknown as IDataSourceAdapter);
    const host = new ConnectorsHost({ provider });
    await host.Dispose();
    await host.Dispose();
    assert.equal(provider.Disposed, 2, "provider Dispose is invoked each time; its own guard makes repeats idempotent");
});

test("a throwing catalog Dispose still disposes the provider and then surfaces the catalog error", async () =>
{
    const provider = new FakeProvider({} as unknown as IDataSourceAdapter);
    const host = new ConnectorsHost({ provider });
    host.Catalog.Dispose = async (): Promise<void> => { throw new Error("catalog boom"); };
    await assert.rejects(host.Dispose(), /catalog boom/);
    assert.equal(provider.Disposed, 1);
});

test("InvalidateProvider forwards the pack name to the provider's Invalidate", async () =>
{
    const seen: string[] = [];
    const provider = { Resolve: async () => { throw new Error("unused"); }, Invalidate: async (n: string) => { seen.push(n); } };
    await new ConnectorsHost({ provider: provider as IDataSourceAdapterProvider }).InvalidateProvider("acme@^1");
    assert.deepEqual(seen, ["acme@^1"]);
});

test("InvalidateProvider tolerates a provider without Invalidate", async () =>
{
    const plain: IDataSourceAdapterProvider = { Resolve: async () => { throw new Error("unused"); } };
    await new ConnectorsHost({ provider: plain }).InvalidateProvider("acme@^1");
});

test("InvalidateProvider tolerates a host with no provider", async () =>
{
    await new ConnectorsHost().InvalidateProvider("acme@^1");
});

test("script-allowlist passthroughs on a host with no provider are no-ops and list is empty", async () =>
{
    const host = new ConnectorsHost();
    assert.deepEqual(await host.ListPackScriptAllowlist(), []);
    await host.AllowPackScripts("acme");
    await host.DenyPackScripts("acme");
});

test("script-allowlist passthroughs forward to the provider", async () =>
{
    const seen: string[] = [];
    const provider = {
        Resolve: async () => { throw new Error("unused"); },
        AllowScripts: async (n: string) => { seen.push(`allow:${n}`); },
        DenyScripts: async (n: string) => { seen.push(`deny:${n}`); },
        ListScriptAllowlist: async () => ["a"],
    };
    const host = new ConnectorsHost({ provider: provider as IDataSourceAdapterProvider });
    await host.AllowPackScripts("p");
    await host.DenyPackScripts("q");
    assert.deepEqual(seen, ["allow:p", "deny:q"]);
    assert.deepEqual(await host.ListPackScriptAllowlist(), ["a"]);
});
