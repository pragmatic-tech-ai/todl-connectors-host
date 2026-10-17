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
import { WorkerThreadSandboxFactory } from "../worker-thread-sandbox.js";

/** Builds `InstalledPack`s over the built reference pack (and over deliberately broken entries) and
 *  pins the pack's seeded data the integration tests assert on. */
class SandboxFixture
{
    private static readonly PackRelative = "../../../../fixtures/adapter-pack-example/dist/pack.js";
    private static readonly PackName = "@pragmatic-tech-ai/adapter-pack-example";
    private static readonly PackVersion = "0.1.0";
    private static readonly SqlKind = "sql";
    private static readonly BadEntryPrefix = "bad-pack-";
    private static readonly BadEntryFile = "bad-entry.mjs";
    private static readonly BadEntrySource = "throw new Error(\"pack import boom\");\n";

    public static readonly WidgetsSource = "widgets";
    public static readonly CrashSource = "__crash__";
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

    /** Writes a throw-on-import entry into a fresh temp dir; returns its path. */
    public static ThrowingEntry(): string
    {
        const dir = mkdtempSync(join(tmpdir(), SandboxFixture.BadEntryPrefix));
        const entry = join(dir, SandboxFixture.BadEntryFile);
        writeFileSync(entry, SandboxFixture.BadEntrySource);
        return entry;
    }

    public static Remove(entry: string): void
    {
        rmSync(dirname(entry), { recursive: true, force: true });
    }

    public static HasKind(kind: AdapterPackErrorKind): (err: unknown) => boolean
    {
        return (err: unknown): boolean => err instanceof AdapterPackError && err.Kind === kind;
    }

    public static IsPackError(err: unknown): boolean
    {
        return err instanceof AdapterPackError;
    }
}

test("Open + Query returns the pack's seeded records and Apply round-trips its WriteResult", { timeout: 60000 }, async () =>
{
    const sandbox = await new WorkerThreadSandboxFactory().Launch(SandboxFixture.Installed(), SandboxFixture.Options);
    try
    {
        const factory = sandbox.Factory(DataSourceKind.Sql);
        const adapter = await factory.Open({ Kind: DataSourceKind.Sql, Config: {} });

        const records = await adapter.Query({ Source: SandboxFixture.WidgetsSource, Fields: ["id", "name"] });
        assert.deepEqual(records, SandboxFixture.ExpectedWidgets);

        const result = await adapter.Apply(
        {
            Source: SandboxFixture.WidgetsSource,
            IdKey: "id",
            Operations: [{ Kind: WriteOperationKind.Upsert, Key: 1, Fields: { name: "gamma" } }]
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

test("Open on a data-source kind the pack does not provide rejects", { timeout: 60000 }, async () =>
{
    const sandbox = await new WorkerThreadSandboxFactory().Launch(SandboxFixture.Installed(), SandboxFixture.Options);
    try
    {
        await assert.rejects(
            sandbox.Factory(DataSourceKind.Rest).Open({ Kind: DataSourceKind.Rest, Config: {} }),
            SandboxFixture.IsPackError);
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
            adapter.Query({ Source: SandboxFixture.WidgetsSource, Fields: ["id"] }),
            SandboxFixture.HasKind(AdapterPackErrorKind.SandboxCrashed));
    }
    finally
    {
        await sandbox.Dispose();
    }
});

test("Dispose terminates the worker, is idempotent, and later calls reject", { timeout: 60000 }, async () =>
{
    const sandbox = await new WorkerThreadSandboxFactory().Launch(SandboxFixture.Installed(), SandboxFixture.Options);
    const adapter = await sandbox.Factory(DataSourceKind.Sql).Open({ Kind: DataSourceKind.Sql, Config: {} });

    await sandbox.Dispose();
    await sandbox.Dispose();

    await assert.rejects(
        adapter.Query({ Source: SandboxFixture.WidgetsSource, Fields: ["id"] }),
        SandboxFixture.HasKind(AdapterPackErrorKind.SandboxCrashed));
});
