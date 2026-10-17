import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { DataSourceKind, WriteOperationKind } from "@pragmatic-tech-ai/todl";
import type { ExternalRecord } from "@pragmatic-tech-ai/todl";
import { AdapterPackError, AdapterPackErrorKind } from "../../adapter-pack-error.js";
import type { InstalledPack } from "../../adapter-pack-installer.js";
import { ChildProcessSandbox, ChildProcessSandboxFactory } from "../child-process-sandbox.js";
import type { PackSandboxOptions } from "../pack-sandbox.js";
import { PackEntryEnvVar } from "../pack-worker-protocol.js";

/** Builds `InstalledPack`s over the built reference pack (and over deliberately broken entries) and
 *  pins the pack's seeded data the child-process integration tests assert on. */
class ChildSandboxFixture
{
    private static readonly PackRelative = "../../../../fixtures/adapter-pack-example/dist/pack.js";
    private static readonly PackName = "@pragmatic-tech-ai/adapter-pack-example";
    private static readonly PackVersion = "0.1.0";
    private static readonly SqlKind = "sql";
    private static readonly TempPrefix = "bad-pack-";
    private static readonly TempEntryFile = "entry.mjs";
    private static readonly MissingEntryName = "no-such-pack.mjs";
    private static readonly ThrowOnImport = "throw new Error(\"pack import boom\");\n";
    private static readonly NoDefaultExport = "export const notAPack = 1;\n";
    private static readonly NeverReady = "await new Promise(() => {});\n";

    public static readonly IdField = "id";
    public static readonly NameField = "name";
    public static readonly ProbeField = "Probe";
    public static readonly WhenField = "when";
    public static readonly GoneField = "gone";
    public static readonly EchoedField = "echoed";
    public static readonly WidgetsSource = "widgets";
    public static readonly CrashSource = "__crash__";
    public static readonly HangSource = "__hang__";
    public static readonly Exit0Source = "__exit0__";
    public static readonly EchoSource = "__echo__";
    public static readonly WedgeSource = "__wedge__";
    public static readonly SigKill: NodeJS.Signals = "SIGKILL";
    public static readonly GammaName = "gamma";
    public static readonly OldSpaceFlag = "--max-old-space-size=64";
    public static readonly StackFlag = "--stack-size=1024";
    public static readonly OldSpaceMb = 64;
    public static readonly StackMb = 1;
    public static readonly Uid = 1234;
    public static readonly Gid = 5678;
    public static readonly SmallCallTimeoutMs = 200;
    public static readonly SmallStartupTimeoutMs = 200;
    public static readonly IdleCallTimeoutMs = 5000;
    public static readonly BoundMs = 5000;
    public static readonly ImmediateMs = 1000;
    public static readonly ExitWaitMs = 5000;
    public static readonly PollMs = 10;
    /** Mirrors ChildProcessSandbox's private graceful-termination window before the SIGKILL fallback. */
    public static readonly ForceKillMs = 2000;
    public static readonly StartupTimeoutText = "did not report ready within the startup timeout";
    public static readonly Advanced = "advanced";
    public static readonly Win32 = "win32";
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
        return resolve(fileURLToPath(new URL(".", import.meta.url)), ChildSandboxFixture.PackRelative);
    }

    public static Installed(entry: string = ChildSandboxFixture.ExampleEntry()): InstalledPack
    {
        return {
            Name: ChildSandboxFixture.PackName,
            Version: ChildSandboxFixture.PackVersion,
            Root: dirname(entry),
            Entry: entry,
            Kinds: [ChildSandboxFixture.SqlKind]
        };
    }

    public static MissingEntry(): string
    {
        return join(tmpdir(), ChildSandboxFixture.MissingEntryName);
    }

    public static ThrowingEntry(): string
    {
        return ChildSandboxFixture.TempEntry(ChildSandboxFixture.ThrowOnImport);
    }

    public static NoDefaultEntry(): string
    {
        return ChildSandboxFixture.TempEntry(ChildSandboxFixture.NoDefaultExport);
    }

    public static NeverReadyEntry(): string
    {
        return ChildSandboxFixture.TempEntry(ChildSandboxFixture.NeverReady);
    }

    public static Remove(entry: string): void
    {
        rmSync(dirname(entry), { recursive: true, force: true });
    }

    public static HasKind(kind: AdapterPackErrorKind): (err: unknown) => boolean
    {
        return (err: unknown): boolean => err instanceof AdapterPackError && err.Kind === kind;
    }

    public static async Launch(options: PackSandboxOptions = ChildSandboxFixture.Options): Promise<ChildProcessSandbox>
    {
        return await new ChildProcessSandboxFactory().Launch(ChildSandboxFixture.Installed(), options) as ChildProcessSandbox;
    }

    /** Test-only reach into the strategy's live child so a test can deliver an OS signal to it. */
    public static KillChild(sandbox: ChildProcessSandbox, signal: NodeJS.Signals): void
    {
        (sandbox as unknown as { child: ChildProcess }).child.kill(signal);
    }

    /** Polls until the child's exit event has propagated, or the deadline elapses. */
    public static async WaitUntilExited(sandbox: ChildProcessSandbox, maxMs: number): Promise<void>
    {
        const deadline = Date.now() + maxMs;
        while (!sandbox.HasExited && Date.now() < deadline)
        {
            await new Promise<void>(settle => setTimeout(settle, ChildSandboxFixture.PollMs));
        }
    }

    private static TempEntry(contents: string): string
    {
        const dir = mkdtempSync(join(tmpdir(), ChildSandboxFixture.TempPrefix));
        const entry = join(dir, ChildSandboxFixture.TempEntryFile);
        writeFileSync(entry, contents);
        return entry;
    }
}

test("child: Open + Query returns the seeded records and Apply round-trips its WriteResult over IPC", { timeout: 60000 }, async () =>
{
    const sandbox = await ChildSandboxFixture.Launch();
    try
    {
        const adapter = await sandbox.Factory(DataSourceKind.Sql).Open({ Kind: DataSourceKind.Sql, Config: {} });

        const records = await adapter.Query({ Source: ChildSandboxFixture.WidgetsSource, Fields: [ChildSandboxFixture.IdField, ChildSandboxFixture.NameField] });
        assert.deepEqual(records, ChildSandboxFixture.ExpectedWidgets);

        const result = await adapter.Apply(
        {
            Source: ChildSandboxFixture.WidgetsSource,
            IdKey: ChildSandboxFixture.IdField,
            Operations: [{ Kind: WriteOperationKind.Upsert, Key: 1, Fields: { [ChildSandboxFixture.NameField]: ChildSandboxFixture.GammaName } }]
        });
        assert.deepEqual(result, { Applied: 1, Conflicts: [] });

        await adapter.Dispose();
    }
    finally
    {
        await sandbox.Dispose();
    }
});

test("child: a Date and an explicit undefined field survive the IPC round trip (advanced serialization, not JSON)", { timeout: 60000 }, async () =>
{
    const sandbox = await ChildSandboxFixture.Launch();
    try
    {
        const adapter = await sandbox.Factory(DataSourceKind.Sql).Open({ Kind: DataSourceKind.Sql, Config: {} });
        const when = new Date(Date.UTC(2026, 9, 17, 12, 30, 45, 678));
        const request =
        {
            Source: ChildSandboxFixture.EchoSource,
            Fields: [],
            [ChildSandboxFixture.ProbeField]: { [ChildSandboxFixture.WhenField]: when, [ChildSandboxFixture.GoneField]: undefined }
        };

        const records = await adapter.Query(request);
        const echoed = (records[0] as Record<string, unknown>)[ChildSandboxFixture.EchoedField] as Record<string, unknown>;
        const probe = echoed[ChildSandboxFixture.ProbeField] as Record<string, unknown>;

        // JSON serialization would turn the Date into a string and drop the undefined-valued key.
        assert.ok(probe[ChildSandboxFixture.WhenField] instanceof Date, "Date must arrive as a Date, not an ISO string");
        assert.equal((probe[ChildSandboxFixture.WhenField] as Date).getTime(), when.getTime());
        assert.ok(Object.prototype.hasOwnProperty.call(probe, ChildSandboxFixture.GoneField), "explicit undefined field must survive");
        assert.equal(probe[ChildSandboxFixture.GoneField], undefined);
    }
    finally
    {
        await sandbox.Dispose();
    }
});

test("child: Launch rejects SandboxLaunchFailed when the pack entry does not exist", { timeout: 60000 }, async () =>
{
    await assert.rejects(
        new ChildProcessSandboxFactory().Launch(ChildSandboxFixture.Installed(ChildSandboxFixture.MissingEntry()), ChildSandboxFixture.Options),
        ChildSandboxFixture.HasKind(AdapterPackErrorKind.SandboxLaunchFailed));
});

test("child: Launch rejects SandboxLaunchFailed when the pack entry throws on import", { timeout: 60000 }, async () =>
{
    const entry = ChildSandboxFixture.ThrowingEntry();
    try
    {
        await assert.rejects(
            new ChildProcessSandboxFactory().Launch(ChildSandboxFixture.Installed(entry), ChildSandboxFixture.Options),
            ChildSandboxFixture.HasKind(AdapterPackErrorKind.SandboxLaunchFailed));
    }
    finally
    {
        ChildSandboxFixture.Remove(entry);
    }
});

test("child: Launch rejects SandboxLaunchFailed when the pack entry has no default export", { timeout: 60000 }, async () =>
{
    const entry = ChildSandboxFixture.NoDefaultEntry();
    try
    {
        await assert.rejects(
            new ChildProcessSandboxFactory().Launch(ChildSandboxFixture.Installed(entry), ChildSandboxFixture.Options),
            ChildSandboxFixture.HasKind(AdapterPackErrorKind.SandboxLaunchFailed));
    }
    finally
    {
        ChildSandboxFixture.Remove(entry);
    }
});

test("child: Launch rejects SandboxLaunchFailed when the child never reports ready within startupTimeoutMs", { timeout: 60000 }, async () =>
{
    const entry = ChildSandboxFixture.NeverReadyEntry();
    const startedAt = Date.now();
    try
    {
        await assert.rejects(
            new ChildProcessSandboxFactory().Launch(ChildSandboxFixture.Installed(entry), { startupTimeoutMs: ChildSandboxFixture.SmallStartupTimeoutMs }),
            (err: unknown): boolean => ChildSandboxFixture.HasKind(AdapterPackErrorKind.SandboxLaunchFailed)(err)
                && (err as Error).message.includes(ChildSandboxFixture.StartupTimeoutText));
        // An ignored option would wait the 30s default.
        assert.ok(Date.now() - startedAt < ChildSandboxFixture.BoundMs, "the small startupTimeoutMs must be honored, not the 30s default");
    }
    finally
    {
        ChildSandboxFixture.Remove(entry);
    }
});

test("child: Open on a data-source kind the pack does not provide rejects PackCallFailed", { timeout: 60000 }, async () =>
{
    const sandbox = await ChildSandboxFixture.Launch();
    try
    {
        await assert.rejects(
            sandbox.Factory(DataSourceKind.Rest).Open({ Kind: DataSourceKind.Rest, Config: {} }),
            ChildSandboxFixture.HasKind(AdapterPackErrorKind.PackCallFailed));
    }
    finally
    {
        await sandbox.Dispose();
    }
});

test("child: a never-responding call rejects SandboxTimeout once callTimeoutMs elapses", { timeout: 60000 }, async () =>
{
    const sandbox = await ChildSandboxFixture.Launch({ callTimeoutMs: ChildSandboxFixture.SmallCallTimeoutMs });
    try
    {
        const adapter = await sandbox.Factory(DataSourceKind.Sql).Open({ Kind: DataSourceKind.Sql, Config: {} });
        const startedAt = Date.now();
        await assert.rejects(
            adapter.Query({ Source: ChildSandboxFixture.HangSource, Fields: [] }),
            ChildSandboxFixture.HasKind(AdapterPackErrorKind.SandboxTimeout));
        // An ignored option would fall back to the 30s default and blow this bound.
        assert.ok(Date.now() - startedAt < ChildSandboxFixture.BoundMs, "the small callTimeoutMs must be honored, not the 30s default");
    }
    finally
    {
        await sandbox.Dispose();
    }
});

test("child: crash by exit rejects the in-flight call and every later call SandboxCrashed without hanging", { timeout: 60000 }, async () =>
{
    const sandbox = await ChildSandboxFixture.Launch();
    try
    {
        const adapter = await sandbox.Factory(DataSourceKind.Sql).Open({ Kind: DataSourceKind.Sql, Config: {} });

        await assert.rejects(
            adapter.Query({ Source: ChildSandboxFixture.CrashSource, Fields: [] }),
            ChildSandboxFixture.HasKind(AdapterPackErrorKind.SandboxCrashed));

        const startedAt = Date.now();
        await assert.rejects(
            adapter.Query({ Source: ChildSandboxFixture.WidgetsSource, Fields: [ChildSandboxFixture.IdField] }),
            ChildSandboxFixture.HasKind(AdapterPackErrorKind.SandboxCrashed));
        assert.ok(Date.now() - startedAt < ChildSandboxFixture.ImmediateMs, "later call must reject immediately via the dead flag");
    }
    finally
    {
        await sandbox.Dispose();
    }
});

test("child: crash by SIGKILL mid-flight rejects SandboxCrashed naming the signal; later calls reject immediately", { timeout: 60000 }, async () =>
{
    const sandbox = await ChildSandboxFixture.Launch();
    try
    {
        const adapter = await sandbox.Factory(DataSourceKind.Sql).Open({ Kind: DataSourceKind.Sql, Config: {} });

        const inFlight = adapter.Query({ Source: ChildSandboxFixture.HangSource, Fields: [] });
        // IPC is ordered and the pack never answers __hang__, so a completed round trip after it proves
        // the hang request reached the child and is genuinely outstanding when the signal lands.
        await adapter.Query({ Source: ChildSandboxFixture.WidgetsSource, Fields: [ChildSandboxFixture.IdField] });
        const outcome = assert.rejects(inFlight, (err: unknown): boolean =>
            ChildSandboxFixture.HasKind(AdapterPackErrorKind.SandboxCrashed)(err) && (err as Error).message.includes(ChildSandboxFixture.SigKill));
        ChildSandboxFixture.KillChild(sandbox, ChildSandboxFixture.SigKill);
        await outcome;

        const startedAt = Date.now();
        await assert.rejects(
            adapter.Query({ Source: ChildSandboxFixture.WidgetsSource, Fields: [ChildSandboxFixture.IdField] }),
            ChildSandboxFixture.HasKind(AdapterPackErrorKind.SandboxCrashed));
        assert.ok(Date.now() - startedAt < ChildSandboxFixture.ImmediateMs, "later call must reject immediately via the dead flag");
    }
    finally
    {
        await sandbox.Dispose();
    }
});

test("child: a clean exit while idle rejects later calls SandboxCrashed immediately, never SandboxTimeout", { timeout: 60000 }, async () =>
{
    const sandbox = await ChildSandboxFixture.Launch({ callTimeoutMs: ChildSandboxFixture.IdleCallTimeoutMs });
    try
    {
        const adapter = await sandbox.Factory(DataSourceKind.Sql).Open({ Kind: DataSourceKind.Sql, Config: {} });

        const records = await adapter.Query({ Source: ChildSandboxFixture.Exit0Source, Fields: [] });
        assert.deepEqual(records, []);

        await ChildSandboxFixture.WaitUntilExited(sandbox, ChildSandboxFixture.ExitWaitMs);
        assert.ok(sandbox.HasExited, "child should have exited cleanly");

        const startedAt = Date.now();
        await assert.rejects(
            adapter.Query({ Source: ChildSandboxFixture.WidgetsSource, Fields: [ChildSandboxFixture.IdField] }),
            ChildSandboxFixture.HasKind(AdapterPackErrorKind.SandboxCrashed));
        assert.ok(Date.now() - startedAt < ChildSandboxFixture.ImmediateMs, "later call must reject via the dead flag, not fall through to the idle callTimeoutMs");
    }
    finally
    {
        await sandbox.Dispose();
    }
});

test("child: Dispose of a wedged child resolves with the child exited (forced-kill fallback), without hanging", { timeout: 60000 }, async () =>
{
    const sandbox = await ChildSandboxFixture.Launch();
    const adapter = await sandbox.Factory(DataSourceKind.Sql).Open({ Kind: DataSourceKind.Sql, Config: {} });

    // The pack installs a no-op SIGTERM handler: on POSIX a graceful SIGTERM is then ignored, so only
    // the SIGKILL fallback can end it. (On Windows Node's kill() is always forceful; Dispose still must resolve.)
    await adapter.Query({ Source: ChildSandboxFixture.WedgeSource, Fields: [] });

    const startedAt = Date.now();
    await sandbox.Dispose();
    assert.ok(sandbox.HasExited, "Dispose must not resolve until the child has actually exited");
    if (process.platform !== ChildSandboxFixture.Win32)
    {
        assert.ok(Date.now() - startedAt >= ChildSandboxFixture.ForceKillMs - ChildSandboxFixture.PollMs, "an ignored SIGTERM must only end via the SIGKILL fallback after the graceful window");
    }
});

test("child: Dispose is idempotent and later calls reject SandboxCrashed", { timeout: 60000 }, async () =>
{
    const sandbox = await ChildSandboxFixture.Launch();
    const adapter = await sandbox.Factory(DataSourceKind.Sql).Open({ Kind: DataSourceKind.Sql, Config: {} });

    await sandbox.Dispose();
    await sandbox.Dispose();
    assert.ok(sandbox.HasExited, "Dispose must actually terminate the child");

    await assert.rejects(
        adapter.Query({ Source: ChildSandboxFixture.WidgetsSource, Fields: [ChildSandboxFixture.IdField] }),
        ChildSandboxFixture.HasKind(AdapterPackErrorKind.SandboxCrashed));
});

test("child: BuildForkPlan composes advanced serialization, V8 limit flags, the pack entry env, and POSIX-only uid/gid", () =>
{
    const installed = ChildSandboxFixture.Installed();
    const plan = ChildProcessSandboxFactory.BuildForkPlan(installed,
    {
        resourceLimits: { maxOldGenerationSizeMb: ChildSandboxFixture.OldSpaceMb, stackSizeMb: ChildSandboxFixture.StackMb },
        privilege: { uid: ChildSandboxFixture.Uid, gid: ChildSandboxFixture.Gid }
    });
    const forkOptions = plan.forkOptions;

    assert.equal(forkOptions.serialization, ChildSandboxFixture.Advanced);
    assert.ok(forkOptions.execArgv?.includes(ChildSandboxFixture.OldSpaceFlag));
    assert.ok(forkOptions.execArgv?.includes(ChildSandboxFixture.StackFlag));
    assert.equal(forkOptions.env?.[PackEntryEnvVar], installed.Entry);

    if (process.platform === ChildSandboxFixture.Win32)
    {
        assert.equal("uid" in forkOptions, false);
        assert.equal("gid" in forkOptions, false);
    }
    else
    {
        assert.equal(forkOptions.uid, ChildSandboxFixture.Uid);
        assert.equal(forkOptions.gid, ChildSandboxFixture.Gid);
    }
});
