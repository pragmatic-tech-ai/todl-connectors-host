import { test } from "node:test";
import assert from "node:assert/strict";
import { ServiceProvider } from "@pragmatic-tech-ai/todl-runtime";
import { DataSourceAdapterCatalog, DataSourceKind, ConnectionResolverKey, ResolutionAuditSinkKey } from "@pragmatic-tech-ai/todl";
import type { IConnectionResolver, ResolvedConnection, ConnectorSpec } from "@pragmatic-tech-ai/todl";
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
