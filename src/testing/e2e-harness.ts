import { newDb } from "pg-mem";
import type { Pool } from "pg";
import { DataSourceKind, WriteAtomicity, WriteConcurrency } from "@pragmatic-tech-ai/todl";
import type { ModelConnectorPlan } from "@pragmatic-tech-ai/todl";
import { ConnectorsHost } from "../connectors-host.js";
import { FakeRestHttpClient } from "./fake-rest-http-client.js";

/** Wires a ConnectorsHost over a shared pg-mem SQL source + a fake REST source for the end-to-end golden. */
export class E2eHarness
{
    public static readonly RestBaseUrl = "https://api.example/v1";
    private static readonly SqlConnector = "pg";
    private static readonly RestConnector = "api";
    private static readonly CustomerSource = "Customer";
    private static readonly OrderSource = "Order";
    private static readonly ModelName = "shop";
    private static readonly ModelVersion = "1";
    private static readonly IdKey = "id";
    private static readonly LabelKey = "label";
    private static readonly CustomerConcept = "shop.Customer";
    private static readonly OrderConcept = "shop.Order";
    private static readonly DatabaseKey = "database";
    private static readonly DatabaseName = "app";
    private static readonly BaseUrlKey = "baseUrl";
    private static readonly CreateCustomerSql = 'CREATE TABLE "Customer" (id text primary key, label text)';
    private static readonly InsertCustomerSql = `INSERT INTO "Customer" (id, label) VALUES ('c1', 'Acme')`;
    private static readonly OrderId = "o1";
    private static readonly OrderLabel = "Draft";

    public readonly Pool: Pool;
    public readonly RestClient = new FakeRestHttpClient(E2eHarness.RestBaseUrl);
    public readonly Host: ConnectorsHost;

    public constructor()
    {
        const db = newDb();
        const pg = db.adapters.createPg();
        this.Pool = new pg.Pool() as unknown as Pool;
        db.public.none(E2eHarness.CreateCustomerSql);
        db.public.query(E2eHarness.InsertCustomerSql);
        this.RestClient.Seed(E2eHarness.OrderSource, [{ id: E2eHarness.OrderId, label: E2eHarness.OrderLabel }]);
        this.Host = new ConnectorsHost({ buildPool: () => this.Pool, restClient: this.RestClient });
    }

    public Plan(): ModelConnectorPlan
    {
        const fieldMap = { [E2eHarness.IdKey]: E2eHarness.IdKey, [E2eHarness.LabelKey]: E2eHarness.LabelKey };
        return {
            Model: E2eHarness.ModelName, Version: E2eHarness.ModelVersion,
            Connectors: [
                { Name: E2eHarness.SqlConnector, Kind: DataSourceKind.Sql, Config: { [E2eHarness.DatabaseKey]: E2eHarness.DatabaseName } },
                { Name: E2eHarness.RestConnector, Kind: DataSourceKind.Rest, Config: { [E2eHarness.BaseUrlKey]: E2eHarness.RestBaseUrl } },
            ],
            Bindings: [
                { Concept: E2eHarness.CustomerConcept, Connector: E2eHarness.SqlConnector, Source: E2eHarness.CustomerSource,
                    IdKey: E2eHarness.IdKey, FieldMap: fieldMap, Writable: true, Concurrency: WriteConcurrency.LastWriteWins, Atomicity: WriteAtomicity.Sequential },
                { Concept: E2eHarness.OrderConcept, Connector: E2eHarness.RestConnector, Source: E2eHarness.OrderSource,
                    IdKey: E2eHarness.IdKey, FieldMap: fieldMap, Writable: true, Concurrency: WriteConcurrency.LastWriteWins, Atomicity: WriteAtomicity.Sequential },
            ],
        };
    }
}
