import { test } from "node:test";
import assert from "node:assert/strict";
import { ServiceProvider } from "@pragmatic-tech-ai/todl-runtime";
import { TruePredicate } from "@pragmatic-tech-ai/graph";
import type { ConnectorSpec } from "@pragmatic-tech-ai/todl";
import { EngineBridgeError, EngineBridgeErrorCode } from "@pragmatic-tech-ai/todl/engine";
import { E2eHarness } from "../testing/e2e-harness.js";
import { ExternalConformanceRun } from "../testing/external-connector-conformance.js";
import { PgSqlSession } from "../sql/pg-sql-session.js";

/**
 * Host-composed engine-path e2e: adapters are opened through the ConnectorsHost catalog (the real SQL + REST factories
 * over pg-mem and the fake REST client) from the E2eHarness plan, then driven by the engine DataSourceConnector.
 */
class EngineE2e
{
    public static readonly CustomerId = "c1";
    public static readonly OrderId = "o1";
    public static readonly Acme = "Acme";
    public static readonly AcmeCorp = "Acme Corp";
    public static readonly Submitted = "Submitted";
    public static readonly Nope = "Nope";
    public static readonly CustomerSource = "Customer";
    public static readonly OrderSource = "Order";
    public static readonly OrdersUrl = `${E2eHarness.RestBaseUrl}/Order`;
    public static readonly CustomerLabelSql = 'SELECT id, label FROM "Customer" WHERE id = $1';

    public static async OpenRun(fx: E2eHarness, services: ServiceProvider, connectorIndex: number, source: string, overrides = {}): Promise<ExternalConformanceRun>
    {
        const spec: ConnectorSpec = fx.Plan().Connectors[connectorIndex]!;
        const adapter = await fx.Host.Catalog.Open(spec, services);
        return ExternalConformanceRun.Open(adapter, overrides, [], false, source);
    }

    public static async Sql(fx: E2eHarness, services: ServiceProvider, overrides = {}): Promise<ExternalConformanceRun>
    {
        return EngineE2e.OpenRun(fx, services, 0, EngineE2e.CustomerSource, overrides);
    }

    public static async Rest(fx: E2eHarness, services: ServiceProvider): Promise<ExternalConformanceRun>
    {
        return EngineE2e.OpenRun(fx, services, 1, EngineE2e.OrderSource);
    }

    public static async Label(fx: E2eHarness): Promise<unknown>
    {
        const rows = await new PgSqlSession(fx.Pool).Query(EngineE2e.CustomerLabelSql, [EngineE2e.CustomerId]);
        return rows[0]![ExternalConformanceRun.LabelField];
    }
}

test("engine connector reads a SQL source and a REST source opened through the host", async () =>
{
    const fx = new E2eHarness();
    try
    {
        const services = new ServiceProvider();
        fx.Host.Register(services);
        const sql = await EngineE2e.Sql(fx, services);
        const rest = await EngineE2e.Rest(fx, services);
        const customers = await sql.Drain(TruePredicate.Instance);
        const orders = await rest.Drain(TruePredicate.Instance);
        assert.deepEqual(ExternalConformanceRun.Ids(customers.Rows), [sql.Id(EngineE2e.CustomerId)]);
        assert.deepEqual(ExternalConformanceRun.Ids(orders.Rows), [rest.Id(EngineE2e.OrderId)]);
    }
    finally
    {
        await fx.Host.Dispose();
    }
});

test("engine transactions write back to BOTH the SQL table and the REST store", async () =>
{
    const fx = new E2eHarness();
    try
    {
        const services = new ServiceProvider();
        fx.Host.Register(services);
        const sql = await EngineE2e.Sql(fx, services);
        const rest = await EngineE2e.Rest(fx, services);
        await sql.Write([ExternalConformanceRun.Set(sql.Id(EngineE2e.CustomerId), ExternalConformanceRun.LabelMember, EngineE2e.AcmeCorp)]);
        await rest.Write([ExternalConformanceRun.Set(rest.Id(EngineE2e.OrderId), ExternalConformanceRun.LabelMember, EngineE2e.Submitted)]);
        assert.equal(await EngineE2e.Label(fx), EngineE2e.AcmeCorp);
        const orders = await fx.RestClient.GetJson(EngineE2e.OrdersUrl, {}) as { id: string; label: string }[];
        assert.equal(orders.find(o => o.id === EngineE2e.OrderId)!.label, EngineE2e.Submitted);
    }
    finally
    {
        await fx.Host.Dispose();
    }
});

test("a read-only binding rejects the write with NotWritable and leaves the SQL row untouched", async () =>
{
    const fx = new E2eHarness();
    try
    {
        const services = new ServiceProvider();
        fx.Host.Register(services);
        const sql = await EngineE2e.Sql(fx, services, { Writable: false });
        const tx = await sql.Begin();
        await assert.rejects(
            sql.Step(tx, [ExternalConformanceRun.Set(sql.Id(EngineE2e.CustomerId), ExternalConformanceRun.LabelMember, EngineE2e.Nope)]),
            (e: unknown) => e instanceof EngineBridgeError && e.Code === EngineBridgeErrorCode.NotWritable);
        assert.equal(await EngineE2e.Label(fx), EngineE2e.Acme);
    }
    finally
    {
        await fx.Host.Dispose();
    }
});
