import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AdapterPackContract } from "@pragmatic-tech-ai/todl/adapter-pack";
import { AdapterPackError, AdapterPackErrorKind } from "../adapter-pack-error.js";
import { AdapterPackInstaller } from "../adapter-pack-installer.js";
import type { INpmCli } from "../npm-cli.js";

class FakeNpm implements INpmCli
{
    public Installs = 0;

    public constructor(
        private readonly name: string,
        private readonly version: string,
        private readonly block: unknown,
        private readonly delayMs = 0)
    {
    }

    public async Install(cwd: string): Promise<void>
    {
        this.Installs++;
        if (this.delayMs > 0)
        {
            await new Promise<void>(r => setTimeout(r, this.delayMs));
        }
        const pkgDir = join(cwd, "node_modules", this.name);
        mkdirSync(pkgDir, { recursive: true });
        const pkg: Record<string, unknown> = { name: this.name, version: this.version };
        if (this.block !== undefined)
        {
            pkg[AdapterPackContract.TodlBlockKey] = { [AdapterPackContract.ManifestKey]: this.block };
        }
        writeFileSync(join(pkgDir, "package.json"), JSON.stringify(pkg));
        const lock = { lockfileVersion: 3, packages: { ["node_modules/" + this.name]: { version: this.version } } };
        writeFileSync(join(cwd, "package-lock.json"), JSON.stringify(lock));
    }
}

class Env
{
    public static readonly PackName = "@scope/example-pack";
    public static readonly Entry = "./dist/pack.js";

    public static GoodBlock(): unknown
    {
        return { entry: Env.Entry, kinds: ["sql"], sdk: AdapterPackContract.AbiVersion };
    }

    public static async With(fn: (cacheDir: string) => Promise<void>): Promise<void>
    {
        const dir = mkdtempSync(join(tmpdir(), "pack-installer-"));
        try
        {
            await fn(dir);
        }
        finally
        {
            rmSync(dir, { recursive: true, force: true });
        }
    }
}

test("resolves the version from the lockfile and keys the cache on it", async () =>
{
    await Env.With(async cacheDir =>
    {
        const installer = new AdapterPackInstaller(cacheDir, new FakeNpm(Env.PackName, "1.2.3", Env.GoodBlock()));
        const pack = await installer.Install(Env.PackName, "^1.0.0");
        assert.equal(pack.Version, "1.2.3");
        assert.equal(pack.Root, join(cacheDir, Env.PackName, "1.2.3"));
    });
});

test("a second Install of the same spec reuses the cache without re-running npm", async () =>
{
    await Env.With(async cacheDir =>
    {
        const npm = new FakeNpm(Env.PackName, "1.2.3", Env.GoodBlock());
        const installer = new AdapterPackInstaller(cacheDir, npm);
        const first = await installer.Install(Env.PackName, "^1.0.0");
        const second = await installer.Install(Env.PackName, "^1.0.0");
        assert.equal(npm.Installs, 1);
        assert.equal(second.Root, first.Root);
        assert.equal(second.Entry, first.Entry);
    });
});

test("a fresh installer over a populated cache returns the existing root", async () =>
{
    await Env.With(async cacheDir =>
    {
        const first = await new AdapterPackInstaller(cacheDir, new FakeNpm(Env.PackName, "1.2.3", Env.GoodBlock())).Install(Env.PackName, "^1.0.0");
        const second = await new AdapterPackInstaller(cacheDir, new FakeNpm(Env.PackName, "1.2.3", Env.GoodBlock())).Install(Env.PackName, "^1.0.0");
        assert.equal(second.Root, first.Root);
        assert.equal(second.Entry, first.Entry);
    });
});

test("concurrent Installs of the same spec run npm once", async () =>
{
    await Env.With(async cacheDir =>
    {
        const npm = new FakeNpm(Env.PackName, "1.2.3", Env.GoodBlock(), 20);
        const installer = new AdapterPackInstaller(cacheDir, npm);
        const [a, b] = await Promise.all([installer.Install(Env.PackName, "^1.0.0"), installer.Install(Env.PackName, "^1.0.0")]);
        assert.equal(npm.Installs, 1);
        assert.equal(a.Root, b.Root);
    });
});

test("an ABI mismatch rejects with AbiMismatch", async () =>
{
    await Env.With(async cacheDir =>
    {
        const block = { entry: Env.Entry, kinds: ["sql"], sdk: "999" };
        const installer = new AdapterPackInstaller(cacheDir, new FakeNpm(Env.PackName, "1.0.0", block));
        await assert.rejects(installer.Install(Env.PackName, "1.0.0"),
            (e: unknown) => e instanceof AdapterPackError && e.Kind === AdapterPackErrorKind.AbiMismatch);
    });
});

test("a package without a todl.adapterPack block rejects with ManifestMissing", async () =>
{
    await Env.With(async cacheDir =>
    {
        const installer = new AdapterPackInstaller(cacheDir, new FakeNpm(Env.PackName, "1.0.0", undefined));
        await assert.rejects(installer.Install(Env.PackName, "1.0.0"),
            (e: unknown) => e instanceof AdapterPackError && e.Kind === AdapterPackErrorKind.ManifestMissing);
    });
});

test("Entry points under the final root and Kinds match the manifest", async () =>
{
    await Env.With(async cacheDir =>
    {
        const installer = new AdapterPackInstaller(cacheDir, new FakeNpm(Env.PackName, "2.0.0", Env.GoodBlock()));
        const pack = await installer.Install(Env.PackName, "2.0.0");
        assert.equal(pack.Entry, join(pack.Root, "node_modules", Env.PackName, Env.Entry));
        assert.deepEqual([...pack.Kinds], ["sql"]);
    });
});
