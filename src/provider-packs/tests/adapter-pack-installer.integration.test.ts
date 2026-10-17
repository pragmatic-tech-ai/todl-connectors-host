import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { AdapterPackInstaller } from "../adapter-pack-installer.js";
import { NpmCli } from "../npm-cli.js";

class IntegrationEnv
{
    public static readonly GateVar = "PACK_INSTALLER_IT";
    public static readonly GateValue = "1";
    public static readonly PackName = "@pragmatic-tech-ai/adapter-pack-example";
    private static readonly Npm = "npm";
    private static readonly Utf8 = "utf8";
    private static readonly FixtureRelative = "../../../fixtures/adapter-pack-example";
    private static readonly PackedSuffix = ".tgz";

    public static get Enabled(): boolean
    {
        return process.env[IntegrationEnv.GateVar] === IntegrationEnv.GateValue;
    }

    public static get FixtureDir(): string
    {
        return resolve(fileURLToPath(new URL(".", import.meta.url)), IntegrationEnv.FixtureRelative);
    }

    /** Builds the reference pack and `npm pack`s it into destDir; returns the tarball path. */
    public static PackFixture(destDir: string): string
    {
        const cwd = IntegrationEnv.FixtureDir;
        const shell = process.platform === "win32";
        const run = (args: string[]): string => execFileSync(IntegrationEnv.Npm, args, { cwd, encoding: IntegrationEnv.Utf8, shell });
        run(["install", "--no-audit", "--no-fund"]);
        run(["run", "build"]);
        const out = run(["pack", "--pack-destination", destDir]).trim().split(/\r?\n/);
        const file = out[out.length - 1]!.trim();
        assert.ok(file.endsWith(IntegrationEnv.PackedSuffix), `unexpected npm pack output: ${file}`);
        return join(destDir, file);
    }
}

test("installs the reference pack with real npm and reuses the cache", { skip: !IntegrationEnv.Enabled, timeout: 300000 }, async () =>
{
    const work = mkdtempSync(join(tmpdir(), "pack-installer-it-"));
    try
    {
        const tarball = IntegrationEnv.PackFixture(work);
        const installer = new AdapterPackInstaller(join(work, "cache"), new NpmCli());
        const spec = `file:${tarball}`;

        const pack = await installer.Install(IntegrationEnv.PackName, spec);
        assert.ok(pack.Version.length > 0);
        assert.ok(existsSync(pack.Root));
        assert.ok(existsSync(pack.Entry));
        assert.deepEqual([...pack.Kinds], ["sql"]);

        const again = await installer.Install(IntegrationEnv.PackName, spec);
        assert.equal(again.Root, pack.Root);
    }
    finally
    {
        rmSync(work, { recursive: true, force: true });
    }
});
