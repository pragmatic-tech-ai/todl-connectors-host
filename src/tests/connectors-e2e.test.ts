import { test } from "node:test";
import assert from "node:assert/strict";
import { ServiceProvider } from "@pragmatic-tech-ai/todl-runtime";
import { FederatedModelDataConnector } from "@pragmatic-tech-ai/todl";
import { E2eHarness } from "../testing/e2e-harness.js";
import { PgSqlSession } from "../sql/pg-sql-session.js";

class E2eSupport
{
    public static readonly CustomerId = "c1";
    public static readonly OrderId = "o1";
    public static readonly Label = "label";
    public static readonly Acme = "Acme";
    public static readonly AcmeCorp = "Acme Corp";
    public static readonly Submitted = "Submitted";
    public static readonly Nope = "Nope";
    public static readonly OrdersUrl = `${E2eHarness.RestBaseUrl}/Order`;
    public static readonly CustomerLabelSql = 'SELECT id, label FROM "Customer" WHERE id = $1';
    public static readonly SqlReadMessage = "SQL customer read";
    public static readonly RestReadMessage = "REST order read";
    public static readonly ReadOnlyDiagMessage = "read-only MarkDirty returns a diagnostic";
    public static readonly ReadOnlyAppliedMessage = "read-only binding applied no write";
}

test("reads instances from a SQL source and a REST source through the host", async () =>
{
    const fx = new E2eHarness();
    try
    {
        const services = new ServiceProvider();
        fx.Host.Register(services);
        const connector = new FederatedModelDataConnector(fx.Plan(), { nodes: [], edges: [] });
        const doc = await connector.Prepare(services);
        assert.ok(doc.nodes.some(n => n.storageId === E2eSupport.CustomerId), E2eSupport.SqlReadMessage);
        assert.ok(doc.nodes.some(n => n.storageId === E2eSupport.OrderId), E2eSupport.RestReadMessage);
    }
    finally
    {
        await fx.Host.Dispose();
    }
});

test("edits flush back to BOTH the SQL table and the REST store", async () =>
{
    const fx = new E2eHarness();
    try
    {
        const services = new ServiceProvider();
        fx.Host.Register(services);
        const connector = new FederatedModelDataConnector(fx.Plan(), { nodes: [], edges: [] });
        const doc = await connector.Prepare(services);

        const customer = doc.nodes.find(n => n.storageId === E2eSupport.CustomerId)!;
        customer.attrs[E2eSupport.Label] = E2eSupport.AcmeCorp;
        const order = doc.nodes.find(n => n.storageId === E2eSupport.OrderId)!;
        order.attrs[E2eSupport.Label] = E2eSupport.Submitted;

        const wc = connector.WorkingCopy();
        wc.MarkDirty(customer.id);
        wc.MarkDirty(order.id);
        const outcome = await wc.Flush(fx.Host.Catalog, services);
        assert.equal(outcome.Results.reduce((n, r) => n + r.Applied, 0), 2);

        const sqlRows = await new PgSqlSession(fx.Pool).Query(E2eSupport.CustomerLabelSql, [E2eSupport.CustomerId]);
        assert.equal(sqlRows[0]![E2eSupport.Label], E2eSupport.AcmeCorp);

        const orders = await fx.RestClient.GetJson(E2eSupport.OrdersUrl, {}) as { id: string; label: string }[];
        assert.equal(orders.find(o => o.id === E2eSupport.OrderId)!.label, E2eSupport.Submitted);
    }
    finally
    {
        await fx.Host.Dispose();
    }
});

test("a read-only binding yields a ConnectorReadOnly diagnostic and sends no write", async () =>
{
    const fx = new E2eHarness();
    try
    {
        const plan = fx.Plan();
        plan.Bindings[0]!.Writable = false;
        const services = new ServiceProvider();
        fx.Host.Register(services);
        const connector = new FederatedModelDataConnector(plan, { nodes: [], edges: [] });
        const doc = await connector.Prepare(services);
        const customer = doc.nodes.find(n => n.storageId === E2eSupport.CustomerId)!;
        customer.attrs[E2eSupport.Label] = E2eSupport.Nope;
        const wc = connector.WorkingCopy();
        const diag = wc.MarkDirty(customer.id);
        assert.ok(diag, E2eSupport.ReadOnlyDiagMessage);
        const outcome = await wc.Flush(fx.Host.Catalog, services);
        assert.equal(outcome.Results.reduce((n, r) => n + r.Applied, 0), 0, E2eSupport.ReadOnlyAppliedMessage);
        const sqlRows = await new PgSqlSession(fx.Pool).Query(E2eSupport.CustomerLabelSql, [E2eSupport.CustomerId]);
        assert.equal(sqlRows[0]![E2eSupport.Label], E2eSupport.Acme);
    }
    finally
    {
        await fx.Host.Dispose();
    }
});
