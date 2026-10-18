import { test } from "node:test";
import assert from "node:assert/strict";
import { WriteAtomicity, WriteCapability, WriteConcurrency, WriteFailureKind, WriteOperationKind } from "@pragmatic-tech-ai/todl";
import type { IDataSourceAdapter } from "@pragmatic-tech-ai/todl";

const Customer = "Customer";
const UnknownSource = "Nope";
const IdKey = "id";
const Label = "label";
const VersionField = "rev";
const SeedId = "c1";
const SeedLabel = "Acme";
const NewId = "c2";
const NewLabel = "Globex";
const ThirdId = "c3";
const ThirdLabel = "Initech";
const UpdatedLabel = "Acme 2";

/** Per-fixture fidelity knobs for a conformance run (the backing store's limitations, not the adapter's). */
export interface AdapterConformanceOptions
{
    /**
     * Whether the backing store faithfully reports the affected-row count of an optimistic version guard.
     * Defaults true. The pg-mem fixture sets this false: its INSERT ... ON CONFLICT DO UPDATE ... WHERE
     * command tag reports rowCount 1 even when the WHERE excluded the row, so the guard's fail-closed /
     * mid-batch-conflict semantics cannot be validated offline. Real Postgres (the gated live conformance)
     * reports 0 correctly, so it leaves this at the default and exercises the version cases for real.
     */
    readonly HonorsVersionGuard?: boolean;
}

/**
 * Contract every data-source adapter must satisfy. The adapter returned by `make`
 * must hold source Customer seeded with a record { id, label } = c1/Acme.
 * Re-declared here because the engine's copy is a test-only helper not exported from its root barrel.
 * This is the sanctioned module-level function (test-contract helper, mirrors the engine's own).
 *
 * The transaction/version cases are parameterized by the adapter's advertised capabilities: the
 * multi-op and atomic-rollback cases register only when the adapter CanTransact (and the rollback case
 * additionally needs a honored version guard to drive a mid-batch conflict), and the optimistic
 * fail-closed case only when the adapter CanVersion. A version case additionally requires the fixture to
 * honor the guard (see {@link AdapterConformanceOptions.HonorsVersionGuard}), so a low-fidelity offline
 * backend can advertise the real capability yet skip cases it cannot emulate. An adapter that advertises
 * neither capability runs just the capability-free contract cases.
 */
export function describeDataSourceAdapter(name: string, make: () => IDataSourceAdapter, options?: AdapterConformanceOptions): void
{
    const caps = make();
    const canTransact = WriteCapability.CanTransact(caps);
    const canVersion = WriteCapability.CanVersion(caps);
    // A version-guard case needs both the adapter's capability and a fixture that honors the guard.
    const canVerifyVersionGuard = canVersion && (options?.HonorsVersionGuard ?? true);

    // The probe above is only consulted for its advertised capabilities; release its connection/pool
    // so it does not leak (every behavioral case below opens its own fresh adapter via make()).
    test(`${name}: releases the capability-probe adapter`, async () =>
    {
        await caps.Dispose();
    });

    test(`${name}: Query returns only the requested fields per record`, async () =>
    {
        const rows = await make().Query({ Source: Customer, Fields: [IdKey, Label] });
        assert.equal(rows.length, 1);
        assert.deepEqual(Object.keys(rows[0]!).sort(), [IdKey, Label]);
        assert.equal(rows[0]![IdKey], SeedId);
    });

    test(`${name}: an unknown source yields no records`, async () =>
    {
        const rows = await make().Query({ Source: UnknownSource, Fields: [IdKey] });
        assert.deepEqual(rows, []);
    });

    test(`${name}: projecting a subset of fields drops the others`, async () =>
    {
        const rows = await make().Query({ Source: Customer, Fields: [IdKey] });
        assert.deepEqual(rows[0], { [IdKey]: SeedId });
        assert.equal(Label in rows[0]!, false);
    });

    test(`${name}: Apply upserts a new row that Query then returns`, async () =>
    {
        const adapter = make();
        const result = await adapter.Apply({
            Source: Customer, IdKey, Concurrency: WriteConcurrency.LastWriteWins, Atomicity: WriteAtomicity.Sequential,
            Operations: [{ Kind: WriteOperationKind.Upsert, Key: NewId, Fields: { [Label]: NewLabel } }],
        });
        assert.equal(result.Applied, 1);
        assert.equal(result.Failures.length, 0);
        const rows = await adapter.Query({ Source: Customer, Fields: [IdKey, Label] });
        assert.equal(rows.length, 2);
        assert.deepEqual(rows.find(r => r[IdKey] === NewId), { [IdKey]: NewId, [Label]: NewLabel });
    });

    test(`${name}: Apply upsert on an existing key overwrites`, async () =>
    {
        const adapter = make();
        await adapter.Apply({
            Source: Customer, IdKey, Concurrency: WriteConcurrency.LastWriteWins, Atomicity: WriteAtomicity.Sequential,
            Operations: [{ Kind: WriteOperationKind.Upsert, Key: SeedId, Fields: { [Label]: UpdatedLabel } }],
        });
        const rows = await adapter.Query({ Source: Customer, Fields: [IdKey, Label] });
        assert.deepEqual(rows, [{ [IdKey]: SeedId, [Label]: UpdatedLabel }]);
    });

    test(`${name}: Apply delete removes the row`, async () =>
    {
        const adapter = make();
        const result = await adapter.Apply({
            Source: Customer, IdKey, Concurrency: WriteConcurrency.LastWriteWins, Atomicity: WriteAtomicity.Sequential,
            Operations: [{ Kind: WriteOperationKind.Delete, Key: SeedId, Fields: {} }],
        });
        assert.equal(result.Applied, 1);
        assert.deepEqual(await adapter.Query({ Source: Customer, Fields: [IdKey] }), []);
    });

    // CanVersion: an optimistic upsert with NO version against the present seed row must fail CLOSED --
    // a Conflict with the stored row untouched, never a silent overwrite (#7). Portable across adapters:
    // a record-reading adapter sees present-but-unversioned, a header-based one (REST) has no version to
    // enforce; both must refuse. Skipped by adapters that cannot version (GraphQL) and by fixtures that
    // cannot honor the guard (offline pg-mem; real Postgres runs it via the gated live conformance).
    if (canVerifyVersionGuard)
    {
        test(`${name}: an optimistic upsert with no version fails closed (Conflict), leaving the row intact`, async () =>
        {
            const adapter = make();
            const result = await adapter.Apply({
                Source: Customer, IdKey, VersionField, Concurrency: WriteConcurrency.Optimistic, Atomicity: WriteAtomicity.Sequential,
                Operations: [{ Kind: WriteOperationKind.Upsert, Key: SeedId, Fields: { [Label]: UpdatedLabel } }],
            });
            assert.equal(result.Applied, 0);
            assert.equal(result.Failures.length, 1);
            assert.equal(result.Failures[0]!.Kind, WriteFailureKind.Conflict);
            const rows = await adapter.Query({ Source: Customer, Fields: [IdKey, Label] });
            assert.deepEqual(rows, [{ [IdKey]: SeedId, [Label]: SeedLabel }]);
        });
    }

    // CanTransact: a transactional batch of independent upserts commits every op as a unit.
    if (canTransact)
    {
        test(`${name}: a transactional multi-op batch applies every op`, async () =>
        {
            const adapter = make();
            const result = await adapter.Apply({
                Source: Customer, IdKey, Concurrency: WriteConcurrency.LastWriteWins, Atomicity: WriteAtomicity.Transactional,
                Operations: [
                    { Kind: WriteOperationKind.Upsert, Key: NewId, Fields: { [Label]: NewLabel } },
                    { Kind: WriteOperationKind.Upsert, Key: ThirdId, Fields: { [Label]: ThirdLabel } }],
            });
            assert.equal(result.Applied, 2);
            assert.equal(result.Failures.length, 0);
            const rows = await adapter.Query({ Source: Customer, Fields: [IdKey, Label] });
            assert.equal(rows.length, 3);
            assert.deepEqual(rows.find(r => r[IdKey] === NewId), { [IdKey]: NewId, [Label]: NewLabel });
            assert.deepEqual(rows.find(r => r[IdKey] === ThirdId), { [IdKey]: ThirdId, [Label]: ThirdLabel });
        });
    }

    // CanTransact AND a honored version guard: a transactional batch whose later op conflicts (fail-closed
    // on the present-but-unversioned seed) rolls the whole batch back -- the earlier insert must not persist.
    if (canTransact && canVerifyVersionGuard)
    {
        test(`${name}: a transactional batch rolls back entirely when one op conflicts`, async () =>
        {
            const adapter = make();
            const result = await adapter.Apply({
                Source: Customer, IdKey, VersionField, Concurrency: WriteConcurrency.Optimistic, Atomicity: WriteAtomicity.Transactional,
                Operations: [
                    { Kind: WriteOperationKind.Upsert, Key: NewId, Fields: { [Label]: NewLabel } },
                    { Kind: WriteOperationKind.Upsert, Key: SeedId, Fields: { [Label]: UpdatedLabel } }],
            });
            assert.equal(result.Applied, 0);
            assert.ok(result.Failures.some(f => f.Kind === WriteFailureKind.Conflict));
            // Nothing persisted: the new key is absent and the seed row is unchanged.
            const rows = await adapter.Query({ Source: Customer, Fields: [IdKey, Label] });
            assert.equal(rows.length, 1);
            assert.deepEqual(rows[0], { [IdKey]: SeedId, [Label]: SeedLabel });
        });
    }
}
