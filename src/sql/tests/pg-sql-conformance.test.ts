import { after, test } from "node:test";
import assert from "node:assert/strict";
import { WriteAtomicity, WriteConcurrency, WriteFailureKind, WriteOperationKind } from "@pragmatic-tech-ai/todl";
import { describeDataSourceAdapter } from "../../testing/adapter-conformance.js";
import { PgLiveHarness, PgMemAdapterHarness } from "../../testing/pg-mem-adapter.js";

const LiveEnvVar = "CONNECTORS_LIVE_PG";

/** The conformance registration names. */
class PgConformanceNames
{
    public static readonly PgMem = "PgSql (pg-mem)";
    public static readonly FaithfulPgMem = "PgSql (pg-mem, version-faithful)";
    public static readonly Live = "PgSql (live)";
}

/** Conformance options for the SQL registrations: the SQL adapter is TODL's, and its delete is not yet version-guarded there. */
class SqlDeleteOptions
{
    public static readonly Unguarded = { GuardsVersionedDelete: false };
}

// OFFLINE: real SQL execution via pg-mem. Always runs. pg-mem cannot honor the optimistic version guard
// (its ON CONFLICT DO UPDATE ... WHERE command tag mis-reports the affected-row count), so the version-
// guard cases are opted out here; the gated live conformance below exercises them against real Postgres.
describeDataSourceAdapter(PgConformanceNames.PgMem, () => PgMemAdapterHarness.Make(), { HonorsVersionGuard: false, ...SqlDeleteOptions.Unguarded });

// OFFLINE, version-faithful: pg-mem with the guarded upsert's affected-row count and rollback made Postgres-like
// (PgMemFaithfulSession), so the version-guard cases (fail-closed, transactional rollback on conflict) run offline too.
describeDataSourceAdapter(PgConformanceNames.FaithfulPgMem, () => PgMemAdapterHarness.MakeVersionFaithful(), SqlDeleteOptions.Unguarded);

/** A versioned row and a stale write against it, for the version-faithful pg-mem session. */
class StaleVersionFixture
{
    public static readonly Title = "PgSql (pg-mem, version-faithful): a stale optimistic version is a per-op Conflict, the row intact";
    public static readonly Source = "Customer";
    public static readonly IdKey = "id";
    public static readonly Label = "label";
    public static readonly Rev = "rev";
    public static readonly Key = "c1";
    public static readonly Acme = "Acme";
    public static readonly Changed = "Changed";
    public static readonly Current = "2";
    public static readonly Stale = "1";
}

test(StaleVersionFixture.Title, async () =>
{
    const F = StaleVersionFixture;
    const adapter = PgMemAdapterHarness.MakeVersionFaithful();
    try
    {
        const last = { Source: F.Source, IdKey: F.IdKey, Concurrency: WriteConcurrency.LastWriteWins, Atomicity: WriteAtomicity.Sequential };
        await adapter.Apply({ ...last, Operations: [{ Kind: WriteOperationKind.Upsert, Key: F.Key, Fields: { [F.Rev]: F.Current } }] });
        const result = await adapter.Apply({
            ...last, VersionField: F.Rev, Concurrency: WriteConcurrency.Optimistic,
            Operations: [{ Kind: WriteOperationKind.Upsert, Key: F.Key, Fields: { [F.Label]: F.Changed }, Version: F.Stale }],
        });
        assert.equal(result.Applied, 0);
        assert.deepEqual(result.Failures.map(f => [f.Key, f.Kind]), [[F.Key, WriteFailureKind.Conflict]]);
        const matching = await adapter.Apply({
            ...last, VersionField: F.Rev, Concurrency: WriteConcurrency.Optimistic,
            Operations: [{ Kind: WriteOperationKind.Upsert, Key: F.Key, Fields: { [F.Label]: F.Changed }, Version: F.Current }],
        });
        assert.equal(matching.Applied, 1);
        assert.deepEqual(await adapter.Query({ Source: F.Source, Fields: [F.IdKey, F.Label] }), [{ [F.IdKey]: F.Key, [F.Label]: F.Changed }]);
    }
    finally
    {
        await adapter.Dispose();
    }
});

// GATED LIVE: same contract against real Postgres. Registered only when CONNECTORS_LIVE_PG is set AND
// non-empty, so unset/empty => zero live tests. Pools connect lazily; connection errors surface on first use.
if ((process.env[LiveEnvVar] ?? "") !== "")
{
    describeDataSourceAdapter(PgConformanceNames.Live, () => PgLiveHarness.Make(process.env[LiveEnvVar]!), SqlDeleteOptions.Unguarded);
    after(async () =>
    {
        await PgLiveHarness.DisposeAll();
    });
}
