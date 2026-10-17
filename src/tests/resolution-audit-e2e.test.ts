import { test } from "node:test";
import assert from "node:assert/strict";
import { newDb } from "pg-mem";
import type { Pool } from "pg";
import { ServiceProvider } from "@pragmatic-tech-ai/todl-runtime";
import { FederatedModelDataConnector, check, toJSON, DataSourceKind, WriteAtomicity, WriteConcurrency } from "@pragmatic-tech-ai/todl";
import type { ModelConnectorPlan } from "@pragmatic-tech-ai/todl";
import { ConnectorsHost } from "../connectors-host.js";
import { RecordingResolutionAuditSink } from "../resolution-audit/recording-resolution-audit-sink.js";

class ResolutionAuditE2e
{
    public static readonly Meta = `namespace shop
{
    concept Customer { customer_id : string; email : string; phone : string; }
    identity Customer key storageId;
    merge Customer { prefer source "opsdb.contacts" for email; prefer source "opsdb.crm_accounts" for phone; }
}`;

    private static readonly Statements = [
        "CREATE TABLE contacts (customer_id text, email text, phone text)",
        "CREATE TABLE crm_accounts (customer_id text, email text, phone text)",
        "INSERT INTO contacts (customer_id, email, phone) VALUES ('C1', 'a@contacts.example', '111')",
        "INSERT INTO crm_accounts (customer_id, email, phone) VALUES ('C1', 'b@crm.example', '222')",
    ];

    public static BuildPool(): Pool
    {
        const db = newDb();
        const pg = db.adapters.createPg();
        const pool = new pg.Pool() as unknown as Pool;
        for (const sql of ResolutionAuditE2e.Statements)
        {
            db.public.none(sql);
        }
        return pool;
    }

    public static Plan(): ModelConnectorPlan
    {
        const fieldMap = { customer_id: "customer_id", email: "email", phone: "phone" };
        return {
            Model: "shop", Version: "1",
            Connectors: [{ Name: "opsdb", Kind: DataSourceKind.Sql, Config: { database: "app" } }],
            Bindings: [
                { Concept: "shop.Customer", Connector: "opsdb", Source: "contacts", IdKey: "customer_id", FieldMap: fieldMap, Writable: true, Concurrency: WriteConcurrency.LastWriteWins, Atomicity: WriteAtomicity.Sequential },
                { Concept: "shop.Customer", Connector: "opsdb", Source: "crm_accounts", IdKey: "customer_id", FieldMap: fieldMap, Writable: true, Concurrency: WriteConcurrency.LastWriteWins, Atomicity: WriteAtomicity.Sequential },
            ],
        };
    }
}

test("a merging connector Prepared against a ConnectorsHost-registered sink delivers the decisions", async () =>
{
    const pool = ResolutionAuditE2e.BuildPool();
    const sink = new RecordingResolutionAuditSink();
    const host = new ConnectorsHost({ auditSink: sink, buildPool: () => pool });
    try
    {
        const services = new ServiceProvider();
        host.Register(services);
        const base = toJSON(check([{ uri: "shop.todl", text: ResolutionAuditE2e.Meta }]).model);
        const connector = new FederatedModelDataConnector(ResolutionAuditE2e.Plan(), base);
        await connector.Prepare(services);
        assert.equal(sink.Events().length, 1);
        assert.deepEqual(sink.Events()[0]!.decisions, connector.Decisions());
        assert.ok(sink.Events()[0]!.decisions.length > 0);
        assert.equal(JSON.stringify(sink.Events()).includes("password"), false);
    }
    finally
    {
        await host.Dispose();
    }
});
