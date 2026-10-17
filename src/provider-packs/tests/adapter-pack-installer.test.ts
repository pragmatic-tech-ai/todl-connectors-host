import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AdapterPackContract } from "@pragmatic-tech-ai/todl/adapter-pack";
import { AdapterPackError, AdapterPackErrorKind } from "../adapter-pack-error.js";
import { AdapterPackInstaller } from "../adapter-pack-installer.js";
import type { INpmCli } from "../npm-cli.js";
import { ScriptAllowlist } from "../script-allowlist.js";

class FakeNpm implements INpmCli
{
    public Installs = 0;
    public Audits = 0;
    public SignaturesValid = true;
    public readonly Sequence: string[] = [];

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
        this.Sequence.push("install");
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

    public async RunInstallScripts(cwd: string): Promise<void>
    {
        this.Sequence.push("scripts");
        // Simulates a postinstall artifact written into the installed pack dir.
        writeFileSync(join(cwd, "node_modules", this.name, ".scripts-ran"), "1");
    }

    public async AuditSignatures(_cwd: string): Promise<void>
    {
        this.Audits++;
        this.Sequence.push("audit");
        if (!this.SignaturesValid)
        {
            throw new AdapterPackError(AdapterPackErrorKind.SignatureInvalid, "invalid signature");
        }
    }
}

class FlakyNpm implements INpmCli
{
    public Calls = 0;

    public constructor(private readonly inner: INpmCli)
    {
    }

    public async Install(cwd: string): Promise<void>
    {
        this.Calls++;
        if (this.Calls === 1)
        {
            throw new Error("npm exploded");
        }
        await this.inner.Install(cwd);
    }

    public RunInstallScripts(cwd: string): Promise<void>
    {
        return this.inner.RunInstallScripts(cwd);
    }

    public AuditSignatures(cwd: string): Promise<void>
    {
        return this.inner.AuditSignatures(cwd);
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

    public static TempDirs(cacheDir: string): string[]
    {
        return readdirSync(cacheDir).filter(n => n.startsWith(".tmp-"));
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

test("a memo hit whose root was removed is re-resolved (npm runs again)", async () =>
{
    await Env.With(async cacheDir =>
    {
        const npm = new FakeNpm(Env.PackName, "1.2.3", Env.GoodBlock());
        const installer = new AdapterPackInstaller(cacheDir, npm);
        const first = await installer.Install(Env.PackName, "^1.0.0");
        rmSync(first.Root, { recursive: true, force: true });
        const second = await installer.Install(Env.PackName, "^1.0.0");
        assert.equal(npm.Installs, 2);
        assert.equal(second.Root, first.Root);
        assert.ok(existsSync(second.Root));
        assert.deepEqual([...second.Kinds], ["sql"]);
    });
});

class RoutingNpm implements INpmCli
{
    public constructor(private readonly byName: Map<string, FakeNpm>)
    {
    }

    public async Install(cwd: string): Promise<void>
    {
        const json = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8"));
        const name = Object.keys(json.dependencies)[0];
        await this.byName.get(name)!.Install(cwd);
    }

    public async RunInstallScripts(_cwd: string): Promise<void>
    {
    }

    public async AuditSignatures(_cwd: string): Promise<void>
    {
    }
}

test("Invalidate(name) drops the memo so the same spec re-runs npm", async () =>
{
    await Env.With(async cacheDir =>
    {
        const npm = new FakeNpm(Env.PackName, "1.2.3", Env.GoodBlock());
        const installer = new AdapterPackInstaller(cacheDir, npm);
        await installer.Install(Env.PackName, "^1.0.0");
        assert.equal(npm.Installs, 1);
        installer.Invalidate(Env.PackName);
        await installer.Install(Env.PackName, "^1.0.0");
        assert.equal(npm.Installs, 2);
    });
});

test("Invalidate(name) leaves another name's memo untouched", async () =>
{
    await Env.With(async cacheDir =>
    {
        const other = "@scope/other-pack";
        const npmA = new FakeNpm(Env.PackName, "1.2.3", Env.GoodBlock());
        const npmB = new FakeNpm(other, "2.0.0", Env.GoodBlock());
        const installer = new AdapterPackInstaller(cacheDir, new RoutingNpm(new Map([[Env.PackName, npmA], [other, npmB]])));
        await installer.Install(Env.PackName, "^1.0.0");
        await installer.Install(other, "^2.0.0");
        installer.Invalidate(Env.PackName);
        await installer.Install(Env.PackName, "^1.0.0");
        await installer.Install(other, "^2.0.0");
        assert.equal(npmA.Installs, 2);
        assert.equal(npmB.Installs, 1);
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

test("a rejected Install can be retried; the in-flight key is cleared", async () =>
{
    await Env.With(async cacheDir =>
    {
        const npm = new FlakyNpm(new FakeNpm(Env.PackName, "1.2.3", Env.GoodBlock()));
        const installer = new AdapterPackInstaller(cacheDir, npm);
        await assert.rejects(installer.Install(Env.PackName, "^1.0.0"));
        const pack = await installer.Install(Env.PackName, "^1.0.0");
        assert.equal(npm.Calls, 2);
        assert.equal(pack.Version, "1.2.3");
    });
});

test("a pre-existing cache root is returned and leaves no temp dir behind", async () =>
{
    await Env.With(async cacheDir =>
    {
        const pkgDir = join(cacheDir, Env.PackName, "1.2.3", "node_modules", Env.PackName);
        mkdirSync(pkgDir, { recursive: true });
        const pkg = { name: Env.PackName, version: "1.2.3", [AdapterPackContract.TodlBlockKey]: { [AdapterPackContract.ManifestKey]: Env.GoodBlock() } };
        writeFileSync(join(pkgDir, "package.json"), JSON.stringify(pkg));
        const sentinel = join(cacheDir, Env.PackName, "1.2.3", "sentinel.txt");
        writeFileSync(sentinel, "pre-existing");
        const npm = new FakeNpm(Env.PackName, "1.2.3", Env.GoodBlock());
        const installer = new AdapterPackInstaller(cacheDir, npm);
        const pack = await installer.Install(Env.PackName, "^1.0.0");
        assert.equal(pack.Root, join(cacheDir, Env.PackName, "1.2.3"));
        assert.deepEqual(Env.TempDirs(cacheDir), []);
        // npm still runs once into a temp dir (the lockfile is the only source of the resolved version), but the
        // pre-existing root must win the promote: its sentinel survives and the fresh tree never replaces it.
        assert.equal(npm.Installs, 1);
        assert.equal(readFileSync(sentinel, "utf8"), "pre-existing");
    });
});

test("no temp dir remains after an npm failure or a manifest failure", async () =>
{
    await Env.With(async cacheDir =>
    {
        const npmFail = new AdapterPackInstaller(cacheDir, new FlakyNpm(new FakeNpm(Env.PackName, "1.0.0", Env.GoodBlock())));
        await assert.rejects(npmFail.Install(Env.PackName, "1.0.0"));
        assert.deepEqual(Env.TempDirs(cacheDir), []);
        const manifestFail = new AdapterPackInstaller(cacheDir, new FakeNpm(Env.PackName, "1.0.0", undefined));
        await assert.rejects(manifestFail.Install(Env.PackName, "1.0.0"));
        assert.deepEqual(Env.TempDirs(cacheDir), []);
    });
});

test("a traversal-style name rejects with InvalidName", async () =>
{
    await Env.With(async cacheDir =>
    {
        const installer = new AdapterPackInstaller(cacheDir, new FakeNpm(Env.PackName, "1.0.0", Env.GoodBlock()));
        await assert.rejects(installer.Install("../evil", "1.0.0"),
            (e: unknown) => e instanceof AdapterPackError && e.Kind === AdapterPackErrorKind.InvalidName);
    });
});

test("a manifest entry escaping the pack dir rejects with ManifestInvalid", async () =>
{
    await Env.With(async cacheDir =>
    {
        const block = { entry: "../../../escape.js", kinds: ["sql"], sdk: AdapterPackContract.AbiVersion };
        const installer = new AdapterPackInstaller(cacheDir, new FakeNpm(Env.PackName, "1.0.0", block));
        await assert.rejects(installer.Install(Env.PackName, "1.0.0"),
            (e: unknown) => e instanceof AdapterPackError && e.Kind === AdapterPackErrorKind.ManifestInvalid);
    });
});

test("requireSignatures off: the audit is never called and an invalid pack still installs", async () =>
{
    await Env.With(async cacheDir =>
    {
        const npm = new FakeNpm(Env.PackName, "1.2.3", Env.GoodBlock());
        npm.SignaturesValid = false;
        const pack = await new AdapterPackInstaller(cacheDir, npm).Install(Env.PackName, "^1.0.0");
        assert.equal(npm.Audits, 0);
        assert.equal(pack.Version, "1.2.3");
    });
});

test("requireSignatures on with a valid audit installs, audits once, and promotes the root", async () =>
{
    await Env.With(async cacheDir =>
    {
        const npm = new FakeNpm(Env.PackName, "1.2.3", Env.GoodBlock());
        const pack = await new AdapterPackInstaller(cacheDir, npm, true).Install(Env.PackName, "^1.0.0");
        assert.equal(npm.Audits, 1);
        assert.equal(pack.Root, join(cacheDir, Env.PackName, "1.2.3"));
        assert.ok(existsSync(pack.Root));
    });
});

test("requireSignatures on with an invalid audit rejects SignatureInvalid and promotes nothing", async () =>
{
    await Env.With(async cacheDir =>
    {
        const npm = new FakeNpm(Env.PackName, "1.2.3", Env.GoodBlock());
        npm.SignaturesValid = false;
        await assert.rejects(new AdapterPackInstaller(cacheDir, npm, true).Install(Env.PackName, "^1.0.0"),
            (e: unknown) => e instanceof AdapterPackError && e.Kind === AdapterPackErrorKind.SignatureInvalid);
        assert.equal(npm.Audits, 1);
        assert.deepEqual(Env.TempDirs(cacheDir), []);
        assert.equal(existsSync(join(cacheDir, Env.PackName, "1.2.3")), false);
    });
});

test("a pack not on the allowlist installs without audit or scripts when signatures are not required", async () =>
{
    await Env.With(async cacheDir =>
    {
        const npm = new FakeNpm(Env.PackName, "1.2.3", Env.GoodBlock());
        const scripts = new ScriptAllowlist(join(cacheDir, "allow.json"), []);
        await new AdapterPackInstaller(cacheDir, npm, false, scripts).Install(Env.PackName, "^1.0.0");
        assert.deepEqual(npm.Sequence, ["install"]);
    });
});

test("a pack not on the allowlist is audited but never runs scripts when signatures are required", async () =>
{
    await Env.With(async cacheDir =>
    {
        const npm = new FakeNpm(Env.PackName, "1.2.3", Env.GoodBlock());
        const scripts = new ScriptAllowlist(join(cacheDir, "allow.json"), []);
        await new AdapterPackInstaller(cacheDir, npm, true, scripts).Install(Env.PackName, "^1.0.0");
        assert.deepEqual(npm.Sequence, ["install", "audit"]);
    });
});

test("an allowlisted pack is audited before its scripts run", async () =>
{
    await Env.With(async cacheDir =>
    {
        const npm = new FakeNpm(Env.PackName, "1.2.3", Env.GoodBlock());
        const scripts = new ScriptAllowlist(join(cacheDir, "allow.json"), [Env.PackName]);
        await new AdapterPackInstaller(cacheDir, npm, false, scripts).Install(Env.PackName, "^1.0.0");
        assert.deepEqual(npm.Sequence, ["install", "audit", "scripts"]);
    });
});

test("an allowlisted pack whose audit rejects never runs scripts", async () =>
{
    await Env.With(async cacheDir =>
    {
        const npm = new FakeNpm(Env.PackName, "1.2.3", Env.GoodBlock());
        npm.SignaturesValid = false;
        const scripts = new ScriptAllowlist(join(cacheDir, "allow.json"), [Env.PackName]);
        await assert.rejects(new AdapterPackInstaller(cacheDir, npm, false, scripts).Install(Env.PackName, "^1.0.0"),
            (e: unknown) => e instanceof AdapterPackError && e.Kind === AdapterPackErrorKind.SignatureInvalid);
        assert.deepEqual(npm.Sequence, ["install", "audit"]);
        assert.deepEqual(Env.TempDirs(cacheDir), []);
    });
});

test("a corrupt allowlist file fails the install closed and never runs scripts", async () =>
{
    await Env.With(async cacheDir =>
    {
        const file = join(cacheDir, "allow.json");
        writeFileSync(file, "{ not json");
        const npm = new FakeNpm(Env.PackName, "1.2.3", Env.GoodBlock());
        const scripts = new ScriptAllowlist(file, [Env.PackName]);
        await assert.rejects(new AdapterPackInstaller(cacheDir, npm, false, scripts).Install(Env.PackName, "^1.0.0"));
        assert.equal(npm.Sequence.includes("scripts"), false);
        assert.deepEqual(Env.TempDirs(cacheDir), []);
        assert.equal(existsSync(join(cacheDir, Env.PackName, "1.2.3")), false);
    });
});

test("Invalidate mid-flight clears the in-flight key so the install does not populate the memo", async () =>
{
    await Env.With(async cacheDir =>
    {
        const npm = new FakeNpm(Env.PackName, "1.2.3", Env.GoodBlock(), 30);
        const installer = new AdapterPackInstaller(cacheDir, npm);
        const inFlight = installer.Install(Env.PackName, "^1.0.0");
        installer.Invalidate(Env.PackName);
        await inFlight;
        assert.deepEqual(installer.ResolvedRoots(), []);
        await installer.Install(Env.PackName, "^1.0.0");
        assert.equal(npm.Installs, 2);
        assert.equal(installer.ResolvedRoots().length, 1);
    });
});

test("toggling the allowlist changes the served pack tree (scripts artifact appears under a distinct ~scripts root)", async () =>
{
    await Env.With(async cacheDir =>
    {
        const npm = new FakeNpm(Env.PackName, "1.2.3", Env.GoodBlock());
        const scripts = new ScriptAllowlist(join(cacheDir, "allow.json"), []);
        const installer = new AdapterPackInstaller(cacheDir, npm, false, scripts);
        const marker = join("node_modules", Env.PackName, ".scripts-ran");

        const plain = await installer.Install(Env.PackName, "^1.0.0");
        assert.equal(plain.Root.endsWith("~scripts"), false);
        assert.equal(existsSync(join(plain.Root, marker)), false);

        await installer.AllowScripts(Env.PackName);
        installer.Invalidate(Env.PackName);
        const allowed = await installer.Install(Env.PackName, "^1.0.0");
        assert.equal(allowed.Root.endsWith("~scripts"), true);
        assert.notEqual(allowed.Root, plain.Root);
        assert.equal(existsSync(join(allowed.Root, marker)), true);
        assert.equal(existsSync(join(plain.Root, marker)), false);
    });
});
