import { test } from "node:test";
import assert from "node:assert/strict";
import {
    Compare,
    CompareOp,
    ConnectorChangeSet,
    IdIn,
    In,
    IsNull,
    MemberKind,
    Not,
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
import type {
    ConnectionFailureKind,
    ConnectorBinding,
    ExternalFieldValue,
    ExternalRecord,
    IDataSourceAdapter,
    PageQuery,
    PageSlice,
    QueryRequest,
    WriteBatch,
    WriteResult,
} from "@pragmatic-tech-ai/todl";
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
     * the per-op failure case then provokes a version conflict (when the adapter CanVersion). The plain pg-mem fixture
     * sets it false (its ON CONFLICT ... WHERE reports rowCount 1 even when the guard excluded the row), so that case
     * writes to an unknown source instead.
     */
    readonly HonorsVersionGuard?: boolean;
    /** Whether the adapter pages (CanPage) over a store that really pages; registers `paged fetch drains`. Defaults false. */
    readonly Paged?: boolean;
    /**
     * Whether the source can hold the fixture's `parent` field (a foreign key to Customer; schemaless stores, or a table
     * with that column). Maps relationship `parent` in every case and registers `reverse lookup equals unpushed result`.
     * Defaults false.
     */
    readonly Links?: boolean;
    /**
     * The source (table, collection or label) the fixture binds; defaults to ExternalConformanceRun.Source (Customer).
     * A live registration gives its own name so suites that run concurrently over one store never reset each other's rows.
     */
    readonly Source?: string;
}

/**
 * Sits between the connector and the adapter under test: records every read (Query and QueryPage) and every batch the
 * connector sends, and with `ThrowNextApply` makes the next Apply throw before reaching the adapter (a write that never
 * applied). Optional capabilities are present exactly when the wrapped adapter has them.
 */
export class RecordingSourceAdapter implements IDataSourceAdapter
{
    private static readonly Simulated = "simulated adapter failure before the write reached the source";

    public readonly Batches: WriteBatch[] = [];
    public readonly Reads: QueryRequest[] = [];
    public ThrowNextApply = false;
    public readonly ClassifyFailure?: (error: unknown) => ConnectionFailureKind;
    public readonly QueryPage?: (request: QueryRequest, page: PageQuery) => Promise<PageSlice>;

    public constructor(private readonly inner: IDataSourceAdapter)
    {
        if (inner.ClassifyFailure !== undefined) this.ClassifyFailure = error => inner.ClassifyFailure!(error);
        if (inner.QueryPage !== undefined) this.QueryPage = (request, page) =>
        {
            this.Reads.push(request);
            return inner.QueryPage!(request, page);
        };
    }

    public get CanTransact(): boolean | undefined
    {
        return this.inner.CanTransact;
    }

    public get CanVersion(): boolean | undefined
    {
        return this.inner.CanVersion;
    }

    public get CanPage(): boolean | undefined
    {
        return this.inner.CanPage;
    }

    public get SourceManagesVersions(): boolean | undefined
    {
        return this.inner.SourceManagesVersions;
    }

    public Query(request: QueryRequest): Promise<readonly ExternalRecord[]>
    {
        this.Reads.push(request);
        return this.inner.Query(request);
    }

    /** The reads recorded so far, and forgets them. */
    public TakeReads(): QueryRequest[]
    {
        return this.Reads.splice(0);
    }

    public async Apply(batch: WriteBatch): Promise<WriteResult>
    {
        this.Batches.push(batch);
        if (this.ThrowNextApply)
        {
            this.ThrowNextApply = false;
            throw new Error(RecordingSourceAdapter.Simulated);
        }
        return this.inner.Apply(batch);
    }

    public Dispose(): Promise<void>
    {
        return this.inner.Dispose();
    }

    /** Every Delete the connector sent, by key, in order. */
    public DeletedKeys(): ExternalFieldValue[]
    {
        return this.Batches.flatMap(b => b.Operations.filter(o => o.Kind === WriteOperationKind.Delete).map(o => o.Key));
    }
}

/**
 * One conformance case's DataSourceConnector over a fresh adapter, as an environment host opens it: the adapter wrapped
 * in a RecordingSourceAdapter, then in VersionBumpingAdapter (as DataSourceAdapterCatalog wraps every adapter), and one
 * binding of concept `conformance.Customer` to source `SourceName` (default Customer; IdKey `id`, FieldMap id → id, label → label, and
 * parent → parent when the run maps links). The connector does not own the adapter; dispose() releases it.
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
    public static readonly ParentMember = "parent";
    public static readonly IdKey = "id";
    public static readonly LabelField = "label";
    public static readonly ParentField = "parent";
    public static readonly VersionField = "rev";
    public static readonly SeedId = "c1";
    public static readonly SeedLabel = "Acme";
    public static readonly NewId = "c2";
    public static readonly NewLabel = "Globex";
    public static readonly ThirdId = "c3";
    public static readonly ThirdLabel = "Initech";
    public static readonly FourthId = "c4";
    public static readonly UpdatedLabel = "Acme 2";
    public static readonly MissingId = "c9";
    /** A public id of no binding of this connector (it never parses, so push-down drops it). */
    public static readonly ForeignId = "other.Thing#elsewhere.Thing#c1";
    private static readonly DescriptionVersion = "external-conformance-v1";

    private constructor(
        public readonly Adapter: IDataSourceAdapter,
        public readonly Recorder: RecordingSourceAdapter,
        public readonly Binding: IExternalBinding,
        public readonly Identity: ExternalIdentity,
        public readonly Connector: DataSourceConnector,
        public readonly Links: boolean,
        public readonly SourceName: string,
    )
    {
    }

    /** The fixture FieldMap: the id member on IdKey, the label member on its field, and parent when `links`. */
    public static FieldMap(links = false): Record<string, string>
    {
        const map: Record<string, string> = {
            [ExternalConformanceRun.IdMember]: ExternalConformanceRun.IdKey, [ExternalConformanceRun.LabelMember]: ExternalConformanceRun.LabelField,
        };
        if (links)
        {
            map[ExternalConformanceRun.ParentMember] = ExternalConformanceRun.ParentField;
        }
        return map;
    }

    /**
     * A connector over `adapter` with the fixture binding (relationship `parent` mapped when `links`), `overrides` applied,
     * and `members` added to the concept, bound to `source`.
     */
    public static Open(adapter: IDataSourceAdapter, overrides: Partial<ConnectorBinding> = {}, members: readonly MemberInput[] = [], links = false,
        source: string = ExternalConformanceRun.Source): ExternalConformanceRun
    {
        const binding: IExternalBinding = {
            Model: ExternalConformanceRun.Model,
            Connector: ExternalConformanceRun.Connector,
            Binding: {
                Concept: ExternalConformanceRun.Concept, Connector: ExternalConformanceRun.Connector, Source: source,
                IdKey: ExternalConformanceRun.IdKey, FieldMap: ExternalConformanceRun.FieldMap(links), Writable: true,
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
        const recorder = new RecordingSourceAdapter(adapter);
        const connector = new DataSourceConnector(plan, new VersionBumpingAdapter(recorder), identity);
        return new ExternalConformanceRun(adapter, recorder, binding, identity, connector, links, source);
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

    /** Writes `rows` (each holding IdKey) straight to the source, bypassing the connector (last-write-wins). */
    public async Seed(rows: readonly ExternalRecord[]): Promise<void>
    {
        const result = await this.Adapter.Apply({
            Source: this.SourceName, IdKey: ExternalConformanceRun.IdKey,
            Concurrency: WriteConcurrency.LastWriteWins, Atomicity: WriteAtomicity.Sequential,
            Operations: rows.map(row =>
            {
                const fields = { ...row };
                delete fields[ExternalConformanceRun.IdKey];
                return { Kind: WriteOperationKind.Upsert, Key: row[ExternalConformanceRun.IdKey] ?? null, Fields: fields };
            }),
        });
        assert.equal(result.Failures.length, 0);
    }

    /**
     * Seeds the push-down rows next to c1 (Acme): c2 Globex, c3 Acme and c4 with a null label, with parents c1, c1 and c2
     * when the run maps links.
     */
    public async SeedPushDown(): Promise<void>
    {
        const R = ExternalConformanceRun;
        await this.Seed([
            this.Fixture(R.NewId, R.NewLabel, R.SeedId),
            this.Fixture(R.ThirdId, R.SeedLabel, R.SeedId),
            this.Fixture(R.FourthId, null, R.NewId)]);
    }

    /** Every row of the source as it is now, in `fields`, sorted by key (bypassing the connector). */
    public async Rows(fields: readonly string[] = [ExternalConformanceRun.IdKey, ExternalConformanceRun.LabelField]): Promise<ExternalRecord[]>
    {
        const rows = await this.Adapter.Query({ Source: this.SourceName, Fields: [...fields] });
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

    private Fixture(key: string, label: string | null, parent: string): ExternalRecord
    {
        const row: Record<string, ExternalFieldValue> = { [ExternalConformanceRun.IdKey]: key, [ExternalConformanceRun.LabelField]: label };
        if (this.Links)
        {
            row[ExternalConformanceRun.ParentField] = parent;
        }
        return row;
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
                    { Name: ExternalConformanceRun.ParentMember, Kind: MemberKind.Relationship, Targets: [ExternalConformanceRun.Concept] },
                    ...members,
                ],
            }],
        };
    }
}

/** One advisory push-down case: the pushed predicate, the engine's own test of a row, and the ids it must select. */
interface IPushDownCase
{
    readonly Title: string;
    /** The source field the pushed Where must test. */
    readonly Field: string;
    readonly Predicate: (r: ExternalConformanceRun) => Predicate;
    readonly Admits: (r: ExternalConformanceRun, row: IFetchedRow) => boolean;
    readonly Expected: readonly string[];
}

/**
 * The contract a host data-source adapter must satisfy when an engine DataSourceConnector serves it (M2.2 Task 9): reads
 * (scan, key lookup, every advisory push-down of the P10 set, reverse lookup, paging) and writes (create, update,
 * delete, delete of a missing key, revert, per-op failure) through the connector, checked against the source itself.
 * `make` must return a fresh adapter holding source `options.Source` (default Customer) seeded { id: 'c1', label: 'Acme' }
 * (the fixture contract of adapter-conformance.ts).
 */
export class ExternalConnectorConformance
{
    private static readonly Separator = ": ";
    private static readonly ErrNotPushed = "the fetch reached the source without a Where on ";
    private static readonly ScanTitle = "scan returns the seed row with a minted id";
    private static readonly KeyLookupTitle = "key lookup finds c1 and misses c9";
    private static readonly EqTitle = "push-down result equals no-push-down result";
    private static readonly InTitle = "push-down In on label equals no-push-down result";
    private static readonly IsNullTitle = "push-down IsNull on label equals no-push-down result";
    private static readonly NotNullTitle = "push-down Not(IsNull) on label equals no-push-down result";
    private static readonly IdInTitle = "push-down IdIn equals no-push-down result";
    private static readonly ReverseTitle = "reverse lookup equals no-push-down result";
    private static readonly PagedTitle = "paged fetch drains";
    private static readonly CreateTitle = "create commits to the source";
    private static readonly UpdateTitle = "update commits to the source";
    private static readonly DeleteTitle = "delete commits to the source";
    private static readonly DeleteMissingTitle = "delete of a missing key is not a failure";
    private static readonly CompensateTitle = "revert of a create that never applied is not a CompensationFailed";
    private static readonly RevertTitle = "revert after commit restores the before-image";
    private static readonly FailureTitle = "per-op failure surfaces as ExternalWriteFailed";

    public static Describe(name: string, make: () => Promise<IDataSourceAdapter>, options?: IExternalConformanceOptions): void
    {
        const C = ExternalConnectorConformance;
        const R = ExternalConformanceRun;
        const honorsVersionGuard = options?.HonorsVersionGuard ?? true;
        const links = options?.Links ?? false;
        const source = options?.Source ?? R.Source;
        const run = (title: string, body: (r: ExternalConformanceRun) => Promise<void>): void =>
        {
            C.Case(name, title, make, links, source, body);
        };

        run(C.ScanTitle, async r =>
        {
            const { Rows } = await r.Drain(TruePredicate.Instance);
            assert.equal(Rows.length, 1);
            const row = Rows[0]!;
            assert.equal(row.PublicId, r.Id(R.SeedId));
            assert.equal(row.Concept, R.Concept);
            assert.equal(row.Values.get(R.IdMember), R.SeedId);
            assert.equal(row.Values.get(R.LabelMember), R.SeedLabel);
        });

        run(C.KeyLookupTitle, async r =>
        {
            const hit = await r.Drain(TruePredicate.Instance, { Keys: [r.Id(R.SeedId)] });
            assert.deepEqual(R.Ids(hit.Rows), [r.Id(R.SeedId)]);
            const miss = await r.Drain(TruePredicate.Instance, { Keys: [r.Id(R.MissingId)] });
            assert.deepEqual(miss.Rows, []);
        });

        for (const pushDown of C.PushDownCases())
        {
            run(pushDown.Title, async r =>
            {
                await r.SeedPushDown();
                r.Recorder.TakeReads();
                const pushed = await r.Drain(pushDown.Predicate(r));
                C.AssertPushed(r.Recorder.TakeReads(), pushDown.Field);
                const all = await r.Drain(TruePredicate.Instance);
                C.AssertUnpushed(r.Recorder.TakeReads());
                assert.equal(all.Rows.length, 4);
                const unpushed = all.Rows.filter(row => pushDown.Admits(r, row));
                assert.deepEqual(R.Ids(pushed.Rows), R.Ids(unpushed));
                assert.deepEqual(R.Ids(pushed.Rows), pushDown.Expected.map(id => r.Id(id)).sort());
            });
        }

        if (links)
        {
            run(C.ReverseTitle, async r =>
            {
                await r.SeedPushDown();
                const target = r.Id(R.SeedId);
                r.Recorder.TakeReads();
                const reverse = await r.Drain(TruePredicate.Instance, { Reverse: { Relationship: R.ParentMember, Target: target } });
                C.AssertPushed(r.Recorder.TakeReads(), R.ParentField);
                const all = await r.Drain(TruePredicate.Instance);
                C.AssertUnpushed(r.Recorder.TakeReads());
                const unpushed = all.Rows.filter(row => (row.Links.get(R.ParentMember) ?? []).includes(target));
                assert.deepEqual(R.Ids(reverse.Rows), R.Ids(unpushed));
                assert.deepEqual(R.Ids(reverse.Rows), [r.Id(R.NewId), r.Id(R.ThirdId)].sort());
            });
        }

        if (options?.Paged === true)
        {
            run(C.PagedTitle, async r =>
            {
                assert.equal(r.Adapter.CanPage, true);
                await r.Seed([R.Row(R.NewId, R.NewLabel), R.Row(R.ThirdId, R.ThirdLabel)]);
                const { Rows, Pages } = await r.Drain(TruePredicate.Instance, { Limit: 1 });
                assert.ok(Pages >= 3);
                assert.deepEqual(R.Ids(Rows), [r.Id(R.SeedId), r.Id(R.NewId), r.Id(R.ThirdId)].sort());
            });
        }

        run(C.CreateTitle, async r =>
        {
            const id = r.Id(R.NewId);
            await r.Write([R.Create(id), R.Set(id, R.LabelMember, R.NewLabel)]);
            assert.deepEqual(await r.Rows(), [R.Row(R.SeedId, R.SeedLabel), R.Row(R.NewId, R.NewLabel)]);
        });

        run(C.UpdateTitle, async r =>
        {
            await r.Write([R.Set(r.Id(R.SeedId), R.LabelMember, R.UpdatedLabel)]);
            assert.deepEqual(await r.Rows(), [R.Row(R.SeedId, R.UpdatedLabel)]);
        });

        run(C.DeleteTitle, async r =>
        {
            await r.Write([R.Delete(r.Id(R.SeedId))]);
            assert.deepEqual(await r.Rows(), []);
        });

        run(C.DeleteMissingTitle, async r =>
        {
            await r.Write([R.Delete(r.Id(R.MissingId))]);
            // The Delete really reached the adapter (it was not optimised away before the source).
            assert.deepEqual(r.Recorder.DeletedKeys(), [R.MissingId]);
            assert.deepEqual(await r.Rows(), [R.Row(R.SeedId, R.SeedLabel)]);
        });

        // A create whose adapter call threw counts as applied, so Revert compensates it with a Delete of a key the source
        // never held; that Delete must not fail, or harmless compensation turns into a spurious CompensationFailed.
        run(C.CompensateTitle, async r =>
        {
            const id = r.Id(R.NewId);
            const tx = await r.Stage([R.Create(id), R.Set(id, R.LabelMember, R.NewLabel)]);
            r.Recorder.ThrowNextApply = true;
            await assert.rejects(tx.Commit());
            await tx.Revert();
            assert.deepEqual(r.Recorder.DeletedKeys(), [R.NewId]);
            assert.deepEqual(await r.Rows(), [R.Row(R.SeedId, R.SeedLabel)]);
        });

        run(C.RevertTitle, async r =>
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

        test(C.Title(name, C.FailureTitle), async () =>
        {
            const adapter = await make();
            // A version conflict needs an adapter that can version over a store that honors the guard: the seed row is
            // present but unversioned, so the before-image version (null) fails closed. Otherwise write to a source the
            // store does not hold.
            const versioned = honorsVersionGuard && adapter.CanVersion === true;
            const r = R.Open(adapter, versioned
                ? { Concurrency: WriteConcurrency.Optimistic, VersionField: R.VersionField }
                : { Source: R.UnknownSource }, [], links, source);
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

    /** The P10 push-down set over `label` and ids, each with the engine's own row test and the ids it must select. */
    private static PushDownCases(): IPushDownCase[]
    {
        const C = ExternalConnectorConformance;
        const R = ExternalConformanceRun;
        const label = (row: IFetchedRow): unknown => row.Values.get(R.LabelMember) ?? null;
        return [
            {
                Title: C.EqTitle,
                Field: R.LabelField,
                Predicate: () => new Compare(R.LabelMember, CompareOp.Eq, R.SeedLabel),
                Admits: (_r, row) => label(row) === R.SeedLabel,
                Expected: [R.SeedId, R.ThirdId],
            },
            {
                Title: C.InTitle,
                Field: R.LabelField,
                Predicate: () => new In(R.LabelMember, [R.NewLabel, R.ThirdLabel]),
                Admits: (_r, row) => label(row) === R.NewLabel || label(row) === R.ThirdLabel,
                Expected: [R.NewId],
            },
            {
                Title: C.IsNullTitle,
                Field: R.LabelField,
                Predicate: () => new IsNull(R.LabelMember),
                Admits: (_r, row) => label(row) === null,
                Expected: [R.FourthId],
            },
            {
                Title: C.NotNullTitle,
                Field: R.LabelField,
                Predicate: () => new Not(new IsNull(R.LabelMember)),
                Admits: (_r, row) => label(row) !== null,
                Expected: [R.SeedId, R.NewId, R.ThirdId],
            },
            {
                Title: C.IdInTitle,
                Field: R.IdKey,
                Predicate: r => new IdIn(new Set([r.Id(R.SeedId), r.Id(R.FourthId), r.Id(R.MissingId), R.ForeignId])),
                Admits: (r, row) => row.PublicId === r.Id(R.SeedId) || row.PublicId === r.Id(R.FourthId),
                Expected: [R.SeedId, R.FourthId],
            },
        ];
    }

    /** Every read of a pushed fetch carried a Where testing `field` (the connector really pushed the predicate). */
    private static AssertPushed(reads: readonly QueryRequest[], field: string): void
    {
        assert.ok(reads.length > 0);
        for (const read of reads)
        {
            assert.ok((read.Where?.All ?? []).some(term => term.Field === field), ExternalConnectorConformance.ErrNotPushed + field);
        }
    }

    /** No read of the unpushed comparison fetch carried a Where. */
    private static AssertUnpushed(reads: readonly QueryRequest[]): void
    {
        assert.ok(reads.length > 0);
        for (const read of reads)
        {
            assert.equal(read.Where, undefined);
        }
    }

    /** Registers one case over a fresh run of the fixture binding, disposing it afterwards. */
    private static Case(name: string, title: string, make: () => Promise<IDataSourceAdapter>, links: boolean, source: string,
        body: (r: ExternalConformanceRun) => Promise<void>): void
    {
        test(ExternalConnectorConformance.Title(name, title), async () =>
        {
            const r = ExternalConformanceRun.Open(await make(), {}, [], links, source);
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
