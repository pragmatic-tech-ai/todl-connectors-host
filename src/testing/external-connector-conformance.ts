import { test } from "node:test";
import assert from "node:assert/strict";
import {
    Compare,
    CompareOp,
    ConnectorChangeSet,
    MemberKind,
    TruePredicate,
    ValueType,
    WriteOp,
    type ConnectorChange,
    type IConnectorTransaction,
    type IFetchedRow,
    type IFetchRequest,
    type ISchemaDescription,
    type MemberInput,
    type Predicate,
} from "@pragmatic-tech-ai/graph";
import {
    DataSourceKind,
    VersionBumpingAdapter,
    WriteAtomicity,
    WriteConcurrency,
    WriteFailureKind,
    WriteOperationKind,
} from "@pragmatic-tech-ai/todl";
import type { ConnectorBinding, ExternalRecord, IDataSourceAdapter } from "@pragmatic-tech-ai/todl";
import {
    DataSourceConnector,
    EngineBridgeErrorCode,
    ExternalIdentity,
    ExternalWriteError,
    type IExternalBinding,
    type IExternalConnectorPlan,
} from "@pragmatic-tech-ai/todl/engine";

/** Per-fixture fidelity knobs for an external-connector conformance run (the backing store's limits, not the adapter's). */
export interface IExternalConformanceOptions
{
    /**
     * Whether the backing store faithfully reports the affected-row count of an optimistic version guard. Defaults true;
     * the per-op failure case then provokes a version conflict (when the adapter CanVersion). The pg-mem fixture sets it
     * false (its ON CONFLICT ... WHERE reports rowCount 1 even when the guard excluded the row), so that case writes to an
     * unknown source instead.
     */
    readonly HonorsVersionGuard?: boolean;
    /** Whether the adapter pages (CanPage); registers the `paged fetch drains` case. Defaults false. */
    readonly Paged?: boolean;
}

/**
 * One conformance case's DataSourceConnector over a fresh adapter, as an environment host opens it: the adapter wrapped
 * in VersionBumpingAdapter (as DataSourceAdapterCatalog wraps every adapter) and one binding of concept
 * `conformance.Customer` to source Customer (IdKey `id`, FieldMap id → id, label → label). The connector does not own
 * the adapter; dispose() releases it.
 */
export class ExternalConformanceRun
{
    public static readonly Model = "conformance";
    public static readonly Connector = "hostdb";
    public static readonly Concept = "conformance.Customer";
    public static readonly Source = "Customer";
    public static readonly UnknownSource = "Nope";
    public static readonly IdMember = "id";
    public static readonly LabelMember = "label";
    public static readonly IdKey = "id";
    public static readonly LabelField = "label";
    public static readonly VersionField = "rev";
    public static readonly SeedId = "c1";
    public static readonly SeedLabel = "Acme";
    public static readonly NewId = "c2";
    public static readonly NewLabel = "Globex";
    public static readonly ThirdId = "c3";
    public static readonly ThirdLabel = "Initech";
    public static readonly UpdatedLabel = "Acme 2";
    public static readonly MissingId = "c9";
    private static readonly DescriptionVersion = "external-conformance-v1";

    private constructor(
        public readonly Adapter: IDataSourceAdapter,
        public readonly Binding: IExternalBinding,
        public readonly Identity: ExternalIdentity,
        public readonly Connector: DataSourceConnector,
    )
    {
    }

    /** The fixture FieldMap: the id member on IdKey and the label member on its field. */
    public static FieldMap(): Record<string, string>
    {
        return { [ExternalConformanceRun.IdMember]: ExternalConformanceRun.IdKey, [ExternalConformanceRun.LabelMember]: ExternalConformanceRun.LabelField };
    }

    /** A connector over `adapter` with the fixture binding, `overrides` applied, and `members` added to the concept. */
    public static Open(adapter: IDataSourceAdapter, overrides: Partial<ConnectorBinding> = {}, members: readonly MemberInput[] = []): ExternalConformanceRun
    {
        const binding: IExternalBinding = {
            Model: ExternalConformanceRun.Model,
            Connector: ExternalConformanceRun.Connector,
            Binding: {
                Concept: ExternalConformanceRun.Concept, Connector: ExternalConformanceRun.Connector, Source: ExternalConformanceRun.Source,
                IdKey: ExternalConformanceRun.IdKey, FieldMap: ExternalConformanceRun.FieldMap(), Writable: true,
                Concurrency: WriteConcurrency.LastWriteWins, Atomicity: WriteAtomicity.Sequential,
                ...overrides,
            },
        };
        // The spec only names the connector here: the adapter is handed over directly, not opened by kind.
        const plan: IExternalConnectorPlan = {
            Name: ExternalConformanceRun.Connector,
            Spec: { Name: ExternalConformanceRun.Connector, Kind: DataSourceKind.Sql, Config: {} },
            Bindings: [binding],
        };
        const description = ExternalConformanceRun.Description(members);
        const identity = new ExternalIdentity(description, plan.Bindings);
        const connector = new DataSourceConnector(plan, new VersionBumpingAdapter(adapter), identity, description);
        return new ExternalConformanceRun(adapter, binding, identity, connector);
    }

    public static Create(publicId: string): ConnectorChange
    {
        return { Op: WriteOp.CreateNode, PublicId: publicId, Concept: ExternalConformanceRun.Concept, Owner: ExternalConformanceRun.Model };
    }

    public static Set(publicId: string, member: string, value: string): ConnectorChange
    {
        return { Op: WriteOp.SetProperty, PublicId: publicId, Member: member, Value: value, Concept: ExternalConformanceRun.Concept, Owner: ExternalConformanceRun.Model };
    }

    public static Delete(publicId: string): ConnectorChange
    {
        return { Op: WriteOp.DeleteNode, PublicId: publicId, Concept: ExternalConformanceRun.Concept, Owner: ExternalConformanceRun.Model };
    }

    /** The public id of `storageId` under this run's binding. */
    public Id(storageId: string): string
    {
        return this.Identity.Mint(this.Binding, storageId);
    }

    /** Every row of one fetch, following resume tokens until the connector gives none; also counts the pages. */
    public async Drain(predicate: Predicate, extra: Partial<IFetchRequest> = {}): Promise<{ Rows: IFetchedRow[]; Pages: number }>
    {
        const rows: IFetchedRow[] = [];
        let pages = 0;
        let resume: string | undefined;
        do
        {
            const request: IFetchRequest = {
                Model: ExternalConformanceRun.Model, Concept: ExternalConformanceRun.Concept, Predicate: predicate,
                Members: [ExternalConformanceRun.IdMember, ExternalConformanceRun.LabelMember], ...extra,
                ...(resume === undefined ? {} : { Resume: resume }),
            };
            const page = await this.Connector.Fetch(request);
            pages++;
            rows.push(...page.Rows);
            resume = page.Resume;
        }
        while (resume !== undefined);
        return { Rows: rows, Pages: pages };
    }

    /** Opens a transaction and applies `changes` (no remote effect yet); the caller commits or reverts it. */
    public async Stage(changes: readonly ConnectorChange[]): Promise<IConnectorTransaction>
    {
        const tx = await this.Connector.Begin();
        await tx.Apply(new ConnectorChangeSet(changes));
        return tx;
    }

    /** Stages and commits `changes`; returns the committed transaction (so a case can revert it). */
    public async Write(changes: readonly ConnectorChange[]): Promise<IConnectorTransaction>
    {
        const tx = await this.Stage(changes);
        await tx.Commit();
        return tx;
    }

    /** Writes rows straight to the source, bypassing the connector (last-write-wins). */
    public async Seed(rows: readonly (readonly [string, string])[]): Promise<void>
    {
        const result = await this.Adapter.Apply({
            Source: ExternalConformanceRun.Source, IdKey: ExternalConformanceRun.IdKey,
            Concurrency: WriteConcurrency.LastWriteWins, Atomicity: WriteAtomicity.Sequential,
            Operations: rows.map(([key, label]) => ({ Kind: WriteOperationKind.Upsert, Key: key, Fields: { [ExternalConformanceRun.LabelField]: label } })),
        });
        assert.equal(result.Failures.length, 0);
    }

    /** Every row of the source as it is now, in `fields`, sorted by key (bypassing the connector). */
    public async Rows(fields: readonly string[] = [ExternalConformanceRun.IdKey, ExternalConformanceRun.LabelField]): Promise<ExternalRecord[]>
    {
        const rows = await this.Adapter.Query({ Source: ExternalConformanceRun.Source, Fields: [...fields] });
        return [...rows].sort((a, b) => String(a[ExternalConformanceRun.IdKey]).localeCompare(String(b[ExternalConformanceRun.IdKey])));
    }

    public async dispose(): Promise<void>
    {
        await this.Adapter.Dispose();
    }

    /** One fixture source row in the conformance fields. */
    public static Row(key: string, label: string): ExternalRecord
    {
        return { [ExternalConformanceRun.IdKey]: key, [ExternalConformanceRun.LabelField]: label };
    }

    /** The public ids of `rows`, sorted. */
    public static Ids(rows: readonly IFetchedRow[]): string[]
    {
        return rows.map(r => r.PublicId).sort();
    }

    private static Description(members: readonly MemberInput[]): ISchemaDescription
    {
        return {
            Version: ExternalConformanceRun.DescriptionVersion,
            Indexes: [],
            Seed: [],
            Bindings: [{ Model: ExternalConformanceRun.Model, Concept: ExternalConformanceRun.Concept, Connector: ExternalConformanceRun.Connector }],
            Definitions: [{
                Name: ExternalConformanceRun.Concept, IsAspect: false, Parent: null, Aspects: [],
                Members: [
                    { Name: ExternalConformanceRun.IdMember, Kind: MemberKind.Property, Type: ValueType.String, Nullable: true },
                    { Name: ExternalConformanceRun.LabelMember, Kind: MemberKind.Property, Type: ValueType.String, Nullable: true },
                    ...members,
                ],
            }],
        };
    }
}

/**
 * The contract a host data-source adapter must satisfy when an engine DataSourceConnector serves it (M2.2 Task 9): reads
 * (scan, key lookup, advisory push-down, paging) and writes (create, update, delete, revert, per-op failure) through the
 * connector, checked against the source itself. `make` must return a fresh adapter holding source Customer seeded
 * { id: 'c1', label: 'Acme' } (the fixture contract of adapter-conformance.ts).
 */
export class ExternalConnectorConformance
{
    private static readonly Separator = ": ";
    private static readonly FailureCase = "per-op failure surfaces as ExternalWriteFailed";

    public static Describe(name: string, make: () => Promise<IDataSourceAdapter>, options?: IExternalConformanceOptions): void
    {
        const R = ExternalConformanceRun;
        const honorsVersionGuard = options?.HonorsVersionGuard ?? true;
        const run = (title: string, body: (r: ExternalConformanceRun) => Promise<void>): void =>
        {
            ExternalConnectorConformance.Case(name, title, make, body);
        };

        run("scan returns the seed row with a minted id", async r =>
        {
            const { Rows } = await r.Drain(TruePredicate.Instance);
            assert.equal(Rows.length, 1);
            const row = Rows[0]!;
            assert.equal(row.PublicId, r.Id(R.SeedId));
            assert.equal(row.Concept, R.Concept);
            assert.equal(row.Values.get(R.IdMember), R.SeedId);
            assert.equal(row.Values.get(R.LabelMember), R.SeedLabel);
        });

        run("key lookup finds c1 and misses c9", async r =>
        {
            const hit = await r.Drain(TruePredicate.Instance, { Keys: [r.Id(R.SeedId)] });
            assert.deepEqual(R.Ids(hit.Rows), [r.Id(R.SeedId)]);
            const miss = await r.Drain(TruePredicate.Instance, { Keys: [r.Id(R.MissingId)] });
            assert.deepEqual(miss.Rows, []);
        });

        run("push-down result equals no-push-down result", async r =>
        {
            await r.Seed([[R.NewId, R.NewLabel], [R.ThirdId, R.SeedLabel]]);
            // A String Eq is pushed to the source (P10); the unpushed fetch is filtered here as the engine would.
            const pushed = await r.Drain(new Compare(R.LabelMember, CompareOp.Eq, R.SeedLabel));
            const all = await r.Drain(TruePredicate.Instance);
            const unpushed = all.Rows.filter(row => row.Values.get(R.LabelMember) === R.SeedLabel);
            assert.equal(all.Rows.length, 3);
            assert.deepEqual(R.Ids(pushed.Rows), R.Ids(unpushed));
            assert.deepEqual(R.Ids(pushed.Rows), [r.Id(R.SeedId), r.Id(R.ThirdId)].sort());
        });

        if (options?.Paged === true)
        {
            run("paged fetch drains", async r =>
            {
                assert.equal(r.Adapter.CanPage, true);
                await r.Seed([[R.NewId, R.NewLabel], [R.ThirdId, R.ThirdLabel]]);
                const { Rows, Pages } = await r.Drain(TruePredicate.Instance, { Limit: 1 });
                assert.ok(Pages >= 3);
                assert.deepEqual(R.Ids(Rows), [r.Id(R.SeedId), r.Id(R.NewId), r.Id(R.ThirdId)].sort());
            });
        }

        run("create commits to the source", async r =>
        {
            const id = r.Id(R.NewId);
            await r.Write([R.Create(id), R.Set(id, R.LabelMember, R.NewLabel)]);
            assert.deepEqual(await r.Rows(), [R.Row(R.SeedId, R.SeedLabel), R.Row(R.NewId, R.NewLabel)]);
        });

        run("update commits to the source", async r =>
        {
            await r.Write([R.Set(r.Id(R.SeedId), R.LabelMember, R.UpdatedLabel)]);
            assert.deepEqual(await r.Rows(), [R.Row(R.SeedId, R.UpdatedLabel)]);
        });

        run("delete commits to the source", async r =>
        {
            await r.Write([R.Delete(r.Id(R.SeedId))]);
            assert.deepEqual(await r.Rows(), []);
        });

        // A delete of an absent key is no failure, so compensating a create that never applied cannot turn into a
        // spurious CompensationFailed.
        run("delete of a missing key is not a failure", async r =>
        {
            await r.Write([R.Delete(r.Id(R.MissingId))]);
            assert.deepEqual(await r.Rows(), [R.Row(R.SeedId, R.SeedLabel)]);
        });

        run("revert after commit restores the before-image", async r =>
        {
            const created = r.Id(R.NewId);
            const tx = await r.Write([
                R.Set(r.Id(R.SeedId), R.LabelMember, R.UpdatedLabel),
                R.Create(created),
                R.Set(created, R.LabelMember, R.NewLabel)]);
            assert.deepEqual(await r.Rows(), [R.Row(R.SeedId, R.UpdatedLabel), R.Row(R.NewId, R.NewLabel)]);
            await tx.Revert();
            assert.deepEqual(await r.Rows(), [R.Row(R.SeedId, R.SeedLabel)]);
        });

        test(ExternalConnectorConformance.Title(name, ExternalConnectorConformance.FailureCase), async () =>
        {
            const adapter = await make();
            // A version conflict needs an adapter that can version over a store that honors the guard: the seed row is
            // present but unversioned, so the before-image version (null) fails closed. Otherwise write to a source the
            // store does not hold.
            const versioned = honorsVersionGuard && adapter.CanVersion === true;
            const r = R.Open(adapter, versioned
                ? { Concurrency: WriteConcurrency.Optimistic, VersionField: R.VersionField }
                : { Source: R.UnknownSource });
            try
            {
                const id = r.Id(versioned ? R.SeedId : R.NewId);
                const changes = versioned
                    ? [R.Set(id, R.LabelMember, R.UpdatedLabel)]
                    : [R.Create(id), R.Set(id, R.LabelMember, R.NewLabel)];
                const tx = await r.Stage(changes);
                await assert.rejects(tx.Commit(), (error: unknown) =>
                {
                    assert.ok(error instanceof ExternalWriteError);
                    assert.equal(error.Code, EngineBridgeErrorCode.ExternalWriteFailed);
                    assert.equal(error.Failures.length, 1);
                    if (versioned)
                    {
                        assert.equal(error.Failures[0]!.Kind, WriteFailureKind.Conflict);
                    }
                    return true;
                });
                await tx.Revert();
                assert.deepEqual(await r.Rows(), [R.Row(R.SeedId, R.SeedLabel)]);
            }
            finally
            {
                await r.dispose();
            }
        });
    }

    /** Registers one case over a fresh run of the fixture binding, disposing it afterwards. */
    private static Case(name: string, title: string, make: () => Promise<IDataSourceAdapter>, body: (r: ExternalConformanceRun) => Promise<void>): void
    {
        test(ExternalConnectorConformance.Title(name, title), async () =>
        {
            const r = ExternalConformanceRun.Open(await make());
            try
            {
                await body(r);
            }
            finally
            {
                await r.dispose();
            }
        });
    }

    private static Title(name: string, title: string): string
    {
        return name + ExternalConnectorConformance.Separator + title;
    }
}
