import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { DataSourceKind, WriteOperationKind } from "@pragmatic-tech-ai/todl";
import type { ExternalRecord } from "@pragmatic-tech-ai/todl";
import { AdapterPackError, AdapterPackErrorKind } from "../../adapter-pack-error.js";
import type { InstalledPack } from "../../adapter-pack-installer.js";
import type { PackSandboxOptions } from "../pack-sandbox.js";
import { WorkerThreadSandbox, WorkerThreadSandboxFactory } from "../worker-thread-sandbox.js";

/** Builds `InstalledPack`s over the built reference pack (and over deliberately broken entries) and
 *  pins the pack's seeded data the integration tests assert on. */
class SandboxFixture
{
    private static readonly PackRelative = "../../../../fixtures/adapter-pack-example/dist/pack.js";
    private static readonly PackName = "@pragmatic-tech-ai/adapter-pack-example";
    private static readonly PackVersion = "0.1.0";
    private static readonly SqlKind = "sql";
    private static readonly TempPrefix = "bad-pack-";
    private static readonly TempEntryFile = "entry.mjs";
    private static readonly ThrowOnImport = "throw new Error(\"pack import boom\");\n";
    private static readonly NoDefaultExport = "export const notAPack = 1;\n";
    private static readonly NeverReady = "await new Promise(() => {});\n";

    public static readonly IdField = "id";
    public static readonly NameField = "name";
    public static readonly WidgetsSource = "widgets";
    public static readonly CrashSource = "__crash__";
    public static readonly HangSource = "__hang__";
    public static readonly Exit0Source = "__exit0__";
    public static readonly ExpectedWidgets: readonly ExternalRecord[] =
    [
        { id: 1, name: "alpha" },
        { id: 2, name: "beta" }
    ];

    public static readonly Options: PackSandboxOptions =
    {
        startupTimeoutMs: 30000,
        callTimeoutMs: 20000
    };

    public static ExampleEntry(): string
    {
        return resolve(fileURLToPath(new URL(".", import.meta.url)), SandboxFixture.PackRelative);
    }

    public static Installed(entry: string = SandboxFixture.ExampleEntry()): InstalledPack
    {
        return {
            Name: SandboxFixture.PackName,
            Version: SandboxFixture.PackVersion,
            Root: dirname(entry),
            Entry: entry,
            Kinds: [SandboxFixture.SqlKind]
        };
    }

    public static ThrowingEntry(): string
    {
        return SandboxFixture.TempEntry(SandboxFixture.ThrowOnImport);
    }

    public static NoDefaultEntry(): string
    {
        return SandboxFixture.TempEntry(SandboxFixture.NoDefaultExport);
    }

    public static NeverReadyEntry(): string
    {
        return SandboxFixture.TempEntry(SandboxFixture.NeverReady);
    }

    public static Remove(entry: string): void
    {
        rmSync(dirname(entry), { recursive: true, force: true });
    }

    public static HasKind(kind: AdapterPackErrorKind): (err: unknown) => boolean
    {
        return (err: unknown): boolean => err instanceof AdapterPackError && err.Kind === kind;
    }

    /** Polls until the worker's exit event has propagated, or the deadline elapses. */
    public static async WaitUntilExited(sandbox: WorkerThreadSandbox, maxMs: number): Promise<void>
    {
        const deadline = Date.now() + maxMs;
        while (!sandbox.HasExited && Date.now() < deadline)
        {
            await new Promise<void>(settle => setTimeout(settle, 10));
        }
    }

    private static TempEntry(contents: string): string
    {
        const dir = mkdtempSync(join(tmpdir(), SandboxFixture.TempPrefix));
        const entry = join(dir, SandboxFixture.TempEntryFile);
        writeFileSync(entry, contents);
        return entry;
    }
}

test("Open + Query returns the pack's seeded records and Apply round-trips its WriteResult", { timeout: 60000 }, async () =>
{
    const sandbox = await new WorkerThreadSandboxFactory().Launch(SandboxFixture.Installed(), SandboxFixture.Options);
    try
    {
        const factory = sandbox.Factory(DataSourceKind.Sql);
        const adapter = await factory.Open({ Kind: DataSourceKind.Sql, Config: {} });

        const records = await adapter.Query({ Source: SandboxFixture.WidgetsSource, Fields: [SandboxFixture.IdField, SandboxFixture.NameField] });
        assert.deepEqual(records, SandboxFixture.ExpectedWidgets);

        const result = await adapter.Apply(
        {
            Source: SandboxFixture.WidgetsSource,
            IdKey: SandboxFixture.IdField,
            Operations: [{ Kind: WriteOperationKind.Upsert, Key: 1, Fields: { [SandboxFixture.NameField]: "gamma" } }]
        });
        assert.deepEqual(result, { Applied: 1, Conflicts: [] });

        await adapter.Dispose();
    }
    finally
    {
        await sandbox.Dispose();
    }
});

test("Launch rejects SandboxLaunchFailed when the pack entry throws on import", { timeout: 60000 }, async () =>
{
    const entry = SandboxFixture.ThrowingEntry();
    try
    {
        await assert.rejects(
            new WorkerThreadSandboxFactory().Launch(SandboxFixture.Installed(entry), SandboxFixture.Options),
            SandboxFixture.HasKind(AdapterPackErrorKind.SandboxLaunchFailed));
    }
    finally
    {
        SandboxFixture.Remove(entry);
    }
});

test("Launch rejects SandboxLaunchFailed when the pack entry has no default export", { timeout: 60000 }, async () =>
{
    const entry = SandboxFixture.NoDefaultEntry();
    try
    {
        await assert.rejects(
            new WorkerThreadSandboxFactory().Launch(SandboxFixture.Installed(entry), SandboxFixture.Options),
            SandboxFixture.HasKind(AdapterPackErrorKind.SandboxLaunchFailed));
    }
    finally
    {
        SandboxFixture.Remove(entry);
    }
});

test("Launch rejects SandboxLaunchFailed when the worker never reports ready within startupTimeoutMs", { timeout: 60000 }, async () =>
{
    const entry = SandboxFixture.NeverReadyEntry();
    try
    {
        await assert.rejects(
            new WorkerThreadSandboxFactory().Launch(SandboxFixture.Installed(entry), { startupTimeoutMs: 500 }),
            SandboxFixture.HasKind(AdapterPackErrorKind.SandboxLaunchFailed));
    }
    finally
    {
        SandboxFixture.Remove(entry);
    }
});

test("Open on a data-source kind the pack does not provide rejects PackCallFailed", { timeout: 60000 }, async () =>
{
    const sandbox = await new WorkerThreadSandboxFactory().Launch(SandboxFixture.Installed(), SandboxFixture.Options);
    try
    {
        await assert.rejects(
            sandbox.Factory(DataSourceKind.Rest).Open({ Kind: DataSourceKind.Rest, Config: {} }),
            SandboxFixture.HasKind(AdapterPackErrorKind.PackCallFailed));
    }
    finally
    {
        await sandbox.Dispose();
    }
});

test("a never-responding call rejects SandboxTimeout once callTimeoutMs elapses", { timeout: 60000 }, async () =>
{
    const sandbox = await new WorkerThreadSandboxFactory().Launch(SandboxFixture.Installed(), { callTimeoutMs: 500 });
    try
    {
        const adapter = await sandbox.Factory(DataSourceKind.Sql).Open({ Kind: DataSourceKind.Sql, Config: {} });
        await assert.rejects(
            adapter.Query({ Source: SandboxFixture.HangSource, Fields: [] }),
            SandboxFixture.HasKind(AdapterPackErrorKind.SandboxTimeout));
    }
    finally
    {
        await sandbox.Dispose();
    }
});

test("a worker crash mid-call rejects the in-flight call and every later call, without hanging", { timeout: 60000 }, async () =>
{
    const sandbox = await new WorkerThreadSandboxFactory().Launch(SandboxFixture.Installed(), SandboxFixture.Options);
    try
    {
        const adapter = await sandbox.Factory(DataSourceKind.Sql).Open({ Kind: DataSourceKind.Sql, Config: {} });

        await assert.rejects(
            adapter.Query({ Source: SandboxFixture.CrashSource, Fields: [] }),
            SandboxFixture.HasKind(AdapterPackErrorKind.SandboxCrashed));

        await assert.rejects(
            adapter.Query({ Source: SandboxFixture.WidgetsSource, Fields: [SandboxFixture.IdField] }),
            SandboxFixture.HasKind(AdapterPackErrorKind.SandboxCrashed));
    }
    finally
    {
        await sandbox.Dispose();
    }
});

test("every concurrent in-flight call rejects SandboxCrashed when the worker crashes", { timeout: 60000 }, async () =>
{
    const sandbox = await new WorkerThreadSandboxFactory().Launch(SandboxFixture.Installed(), SandboxFixture.Options);
    try
    {
        const adapter = await sandbox.Factory(DataSourceKind.Sql).Open({ Kind: DataSourceKind.Sql, Config: {} });

        const crashed = adapter.Query({ Source: SandboxFixture.CrashSource, Fields: [] });
        const second = adapter.Query({ Source: SandboxFixture.WidgetsSource, Fields: [SandboxFixture.IdField] });
        const third = adapter.Query({ Source: SandboxFixture.WidgetsSource, Fields: [SandboxFixture.NameField] });

        const outcomes = await Promise.allSettled([crashed, second, third]);
        for (const outcome of outcomes)
        {
            assert.equal(outcome.status, "rejected");
            assert.ok(outcome.status === "rejected" && SandboxFixture.HasKind(AdapterPackErrorKind.SandboxCrashed)(outcome.reason));
        }
    }
    finally
    {
        await sandbox.Dispose();
    }
});

test("a clean worker exit while idle marks the sandbox dead so later calls reject, not hang", { timeout: 60000 }, async () =>
{
    const sandbox = await new WorkerThreadSandboxFactory().Launch(SandboxFixture.Installed(), { callTimeoutMs: 5000 });
    try
    {
        const adapter = await sandbox.Factory(DataSourceKind.Sql).Open({ Kind: DataSourceKind.Sql, Config: {} });

        const records = await adapter.Query({ Source: SandboxFixture.Exit0Source, Fields: [] });
        assert.deepEqual(records, []);

        await SandboxFixture.WaitUntilExited(sandbox as WorkerThreadSandbox, 5000);
        assert.ok((sandbox as WorkerThreadSandbox).HasExited, "worker should have exited cleanly");

        // Require SandboxCrashed (the dead flag), never SandboxTimeout: an idle code-0 exit must
        // mark the sandbox dead (finding 1) so the next Call rejects IMMEDIATELY. Accepting a
        // timeout here would let a reverted finding 1 pass by falling through to callTimeoutMs.
        const startedAt = Date.now();
        await assert.rejects(
            adapter.Query({ Source: SandboxFixture.WidgetsSource, Fields: [SandboxFixture.IdField] }),
            SandboxFixture.HasKind(AdapterPackErrorKind.SandboxCrashed));
        assert.ok(Date.now() - startedAt < 1000, "later call must reject via the dead flag, not fall through to the 5000ms callTimeoutMs");
    }
    finally
    {
        await sandbox.Dispose();
    }
});

test("Dispose terminates the worker (exit fires), is idempotent, and later calls reject", { timeout: 60000 }, async () =>
{
    const sandbox = await new WorkerThreadSandboxFactory().Launch(SandboxFixture.Installed(), SandboxFixture.Options);
    const adapter = await sandbox.Factory(DataSourceKind.Sql).Open({ Kind: DataSourceKind.Sql, Config: {} });

    await sandbox.Dispose();
    await sandbox.Dispose();

    assert.ok((sandbox as WorkerThreadSandbox).HasExited, "Dispose must actually terminate the worker");

    await assert.rejects(
        adapter.Query({ Source: SandboxFixture.WidgetsSource, Fields: [SandboxFixture.IdField] }),
        SandboxFixture.HasKind(AdapterPackErrorKind.SandboxCrashed));
});
