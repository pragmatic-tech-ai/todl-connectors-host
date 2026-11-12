import { test } from "node:test";
import assert from "node:assert/strict";
import { newDb } from "pg-mem";
import { Pool } from "pg";
import { SqlAdapter, WriteAtomicity, WriteFailureKind } from "@pragmatic-tech-ai/todl";
import type { IDataSourceAdapter } from "@pragmatic-tech-ai/todl";
import { EngineBridgeErrorCode, ExternalWriteError } from "@pragmatic-tech-ai/todl/engine";
import { MemberKind, ValueType } from "@pragmatic-tech-ai/graph";
import { PgSqlSession } from "../sql/pg-sql-session.js";
import { DocumentAdapter } from "../document/document-adapter.js";
import { RestAdapter } from "../rest/rest-adapter.js";
import { RestConnectionConfig } from "../rest/rest-connection-config.js";
import { GraphQlAdapter, GraphQlConnectionConfig } from "../rest/graphql-adapter.js";
import { CypherAdapter } from "../cypher/cypher-adapter.js";
import { PgMemAdapterHarness } from "../testing/pg-mem-adapter.js";
import { FakeDocumentSession, TransactionalFakeDocumentSession } from "../testing/fake-document-session.js";
import { FakeRestHttpClient } from "../testing/fake-rest-http-client.js";
import { FakeGraphQlHttpClient } from "../testing/fake-graphql-http-client.js";
import { FilteringFakeCypherSession } from "../testing/fake-cypher-session.js";
import { ExternalConformanceRun, ExternalConnectorConformance } from "../testing/external-connector-conformance.js";

/** Every host adapter over the conformance fixture: source Customer seeded { id: 'c1', label: 'Acme' }. */
class HostAdapters
{
    public static readonly SqlName = "SQL (pg-mem)";
    public static readonly FaithfulSqlName = "SQL (pg-mem, version-faithful)";
    public static readonly ReplicaSetDocumentName = "Document (replica-set fake)";
    public static readonly StandaloneDocumentName = "Document (standalone fake)";
    public static readonly RestName = "REST (fake client)";
    public static readonly GraphQlName = "GraphQL (fake client)";
    public static readonly CypherName = "Cypher (filtering fake session)";
    private static readonly BaseUrl = "https://api.example/v1";
    private static readonly Endpoint = "https://api.example/graphql";
    private static readonly GraphQlStyle = "graphql";
    private static readonly QueryField = "customers";
    private static readonly UpsertMutation = "upsertCustomer";
    private static readonly DeleteMutation = "deleteCustomer";

    public static Seed(): Record<string, unknown>[]
    {
        return [{ [ExternalConformanceRun.IdKey]: ExternalConformanceRun.SeedId, [ExternalConformanceRun.LabelField]: ExternalConformanceRun.SeedLabel }];
    }

    public static async Sql(): Promise<IDataSourceAdapter>
    {
        return PgMemAdapterHarness.Make();
    }

    public static async FaithfulSql(): Promise<IDataSourceAdapter>
    {
        return PgMemAdapterHarness.MakeVersionFaithful();
    }

    public static async ReplicaSetDocument(): Promise<IDataSourceAdapter>
    {
        return new DocumentAdapter(new TransactionalFakeDocumentSession().Seed(ExternalConformanceRun.Source, HostAdapters.Seed()));
    }

    public static async StandaloneDocument(): Promise<IDataSourceAdapter>
    {
        return new DocumentAdapter(new FakeDocumentSession().Seed(ExternalConformanceRun.Source, HostAdapters.Seed()));
    }

    public static async Rest(): Promise<IDataSourceAdapter>
    {
        const client = new FakeRestHttpClient(HostAdapters.BaseUrl).Seed(ExternalConformanceRun.Source, HostAdapters.Seed());
        return new RestAdapter(client, RestConnectionConfig.From({ baseUrl: HostAdapters.BaseUrl }));
    }

    public static async GraphQl(): Promise<IDataSourceAdapter>
    {
        const config = GraphQlConnectionConfig.From({
            style: HostAdapters.GraphQlStyle, endpoint: HostAdapters.Endpoint, source: ExternalConformanceRun.Source,
            queryField: HostAdapters.QueryField, upsertMutation: HostAdapters.UpsertMutation, deleteMutation: HostAdapters.DeleteMutation,
        });
        const client = new FakeGraphQlHttpClient(config);
        client.Seed(HostAdapters.Seed());
        return new GraphQlAdapter(client, config);
    }

    public static async Cypher(): Promise<IDataSourceAdapter>
    {
        return new CypherAdapter(new FilteringFakeCypherSession().Seed(ExternalConformanceRun.Source, HostAdapters.Seed()));
    }
}

/**
 * A pg-mem Customer table whose `tier` column is NOT NULL, mapped as a String member, for the ChangeBatcher claim that a
 * Delete then Create nulling a NOT NULL column surfaces at Commit as ExternalWriteFailed (controller ruling P14).
 */
class NotNullSql
{
    public static readonly Tier = "tier";
    public static readonly Gold = "gold";
    private static readonly TitleOpen = "SQL (pg-mem, ";
    private static readonly TitleClose = "): Delete then Create nulling a NOT NULL column surfaces as ExternalWriteFailed, row intact";
    private static readonly CreateTableSql = 'CREATE TABLE "Customer" (id text primary key, label text, tier text not null)';
    private static readonly SeedSql = `INSERT INTO "Customer" (id, label, tier) VALUES ('c1', 'Acme', 'gold')`;

    public static Title(atomicity: WriteAtomicity): string
    {
        return NotNullSql.TitleOpen + atomicity + NotNullSql.TitleClose;
    }

    public static Make(): IDataSourceAdapter
    {
        const db = newDb();
        const pg = db.adapters.createPg();
        db.public.none(NotNullSql.CreateTableSql);
        db.public.none(NotNullSql.SeedSql);
        return new SqlAdapter(new PgSqlSession(new pg.Pool() as unknown as Pool));
    }
}

ExternalConnectorConformance.Describe(HostAdapters.SqlName, () => HostAdapters.Sql(), { HonorsVersionGuard: false, Paged: true, Links: true });
ExternalConnectorConformance.Describe(HostAdapters.FaithfulSqlName, () => HostAdapters.FaithfulSql(), { Paged: true, Links: true });
ExternalConnectorConformance.Describe(HostAdapters.ReplicaSetDocumentName, () => HostAdapters.ReplicaSetDocument(), { Paged: true, Links: true });
ExternalConnectorConformance.Describe(HostAdapters.StandaloneDocumentName, () => HostAdapters.StandaloneDocument(), { Paged: true, Links: true });
ExternalConnectorConformance.Describe(HostAdapters.RestName, () => HostAdapters.Rest(), { Links: true });
ExternalConnectorConformance.Describe(HostAdapters.GraphQlName, () => HostAdapters.GraphQl(), { Links: true });
ExternalConnectorConformance.Describe(HostAdapters.CypherName, () => HostAdapters.Cypher(), { Paged: true, Links: true });

for (const atomicity of [WriteAtomicity.Sequential, WriteAtomicity.Transactional])
{
    test(NotNullSql.Title(atomicity), async () =>
    {
        const run = ExternalConformanceRun.Open(NotNullSql.Make(), {
            Atomicity: atomicity,
            FieldMap: { ...ExternalConformanceRun.FieldMap(), [NotNullSql.Tier]: NotNullSql.Tier },
        }, [{ Name: NotNullSql.Tier, Kind: MemberKind.Property, Type: ValueType.String, Nullable: true }]);
        try
        {
            const id = run.Id(ExternalConformanceRun.SeedId);
            // Immediate writes: the delete-then-create merges to one upsert that nulls the NOT NULL column, and that fails
            // at the step (Apply), not at Commit. The row is untouched (nothing applied), and Revert compensates nothing.
            const tx = await run.Begin();
            await assert.rejects(run.Step(tx, [
                ExternalConformanceRun.Delete(id),
                ExternalConformanceRun.Create(id),
                ExternalConformanceRun.Set(id, ExternalConformanceRun.LabelMember, ExternalConformanceRun.NewLabel)]), (error: unknown) =>
                error instanceof ExternalWriteError
                && error.Code === EngineBridgeErrorCode.ExternalWriteFailed
                && error.Failures.length === 1
                && error.Failures[0]!.Kind === WriteFailureKind.Error);
            await tx.Revert();
            assert.deepEqual(await run.Rows([ExternalConformanceRun.IdKey, ExternalConformanceRun.LabelField, NotNullSql.Tier]), [
                { [ExternalConformanceRun.IdKey]: ExternalConformanceRun.SeedId, [ExternalConformanceRun.LabelField]: ExternalConformanceRun.SeedLabel, [NotNullSql.Tier]: NotNullSql.Gold }]);
        }
        finally
        {
            await run.dispose();
        }
    });
}
