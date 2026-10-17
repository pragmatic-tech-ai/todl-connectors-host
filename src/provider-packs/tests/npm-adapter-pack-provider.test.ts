import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DataSourceKind } from "@pragmatic-tech-ai/todl";
import type { IDataSourceAdapterFactory } from "@pragmatic-tech-ai/todl";
import { AdapterPackContract } from "@pragmatic-tech-ai/todl/adapter-pack";
import { AdapterPackError, AdapterPackErrorKind } from "../adapter-pack-error.js";
import type { InstalledPack } from "../adapter-pack-installer.js";
import { NpmAdapterPackProvider } from "../npm-adapter-pack-provider.js";
import type { NpmAdapterPackProviderOptions } from "../npm-adapter-pack-provider.js";
import type { INpmCli } from "../npm-cli.js";
import type { IPackSandbox, IPackSandboxFactory } from "../sandbox/pack-sandbox.js";

class FakeNpm implements INpmCli
{
    public Installs = 0;
    public Audits = 0;

    public async Install(cwd: string): Promise<void>
    {
        this.Installs++;
        const json = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8")) as { dependencies: Record<string, string> };
        const name = Object.keys(json.dependencies)[0];
        const pkgDir = join(cwd, "node_modules", name);
        mkdirSync(pkgDir, { recursive: true });
        const block = { entry: "./dist/pack.js", kinds: ["sql", "rest"], sdk: AdapterPackContract.AbiVersion };
        const pkg = { name, version: "1.0.0", [AdapterPackContract.TodlBlockKey]: { [AdapterPackContract.ManifestKey]: block } };
        writeFileSync(join(pkgDir, "package.json"), JSON.stringify(pkg));
        const lock = { lockfileVersion: 3, packages: { ["node_modules/" + name]: { version: "1.0.0" } } };
        writeFileSync(join(cwd, "package-lock.json"), JSON.stringify(lock));
    }

    public async AuditSignatures(_cwd: string): Promise<void>
    {
        this.Audits++;
    }
}

class FakeSandbox implements IPackSandbox
{
    public Disposed = false;

    public Factory(kind: DataSourceKind): IDataSourceAdapterFactory
    {
        return { Kind: kind, Open: async () => { throw new Error("not used"); } } as unknown as IDataSourceAdapterFactory;
    }

    public async Dispose(): Promise<void>
    {
        this.Disposed = true;
    }
}

class FakeSandboxFactory implements IPackSandboxFactory
{
    public Launches = 0;
    public FailNext = false;
    public readonly Sandboxes: FakeSandbox[] = [];

    public async Launch(_installed: InstalledPack): Promise<IPackSandbox>
    {
        this.Launches++;
        if (this.FailNext)
        {
            this.FailNext = false;
            throw new AdapterPackError(AdapterPackErrorKind.SandboxLaunchFailed, "launch failed");
        }
        const sandbox = new FakeSandbox();
        this.Sandboxes.push(sandbox);
        return sandbox;
    }
}

class Env
{
    public static readonly Pack = "acme-pack";
    public static readonly Other = "other-pack";

    public static async With(
        fn: (provider: NpmAdapterPackProvider, npm: FakeNpm, sandboxes: FakeSandboxFactory) => Promise<void>,
        overrides: Partial<NpmAdapterPackProviderOptions> = {}): Promise<void>
    {
        const dir = mkdtempSync(join(tmpdir(), "pack-provider-"));
        const npm = new FakeNpm();
        const sandboxes = new FakeSandboxFactory();
        const provider = new NpmAdapterPackProvider({
            cacheDir: dir,
            sandboxFactory: sandboxes,
            allowProviderOverride: true,
            providerAllowlist: [Env.Pack, Env.Other],
            npm,
            ...overrides,
        });
        try
        {
            await fn(provider, npm, sandboxes);
        }
        finally
        {
            await provider.Dispose();
            rmSync(dir, { recursive: true, force: true });
        }
    }

    public static async Rejects(promise: Promise<unknown>, kind: AdapterPackErrorKind): Promise<void>
    {
        await assert.rejects(promise, (e: unknown) => e instanceof AdapterPackError && e.Kind === kind);
    }
}

test("a named provider installs, launches, and returns a factory for the kind", async () =>
{
    await Env.With(async (provider, npm, sandboxes) =>
    {
        const factory = await provider.Resolve({ Kind: DataSourceKind.Sql, Provider: "acme-pack@^1" });
        assert.equal(factory.Kind, DataSourceKind.Sql);
        assert.equal(npm.Installs, 1);
        assert.equal(sandboxes.Launches, 1);
    });
});

test("the same provider and two kinds of one pack share one sandbox", async () =>
{
    await Env.With(async (provider, _npm, sandboxes) =>
    {
        await provider.Resolve({ Kind: DataSourceKind.Sql, Provider: "acme-pack@^1" });
        await provider.Resolve({ Kind: DataSourceKind.Sql, Provider: "acme-pack@^1" });
        const rest = await provider.Resolve({ Kind: DataSourceKind.Rest, Provider: "acme-pack@^1" });
        assert.equal(rest.Kind, DataSourceKind.Rest);
        assert.equal(sandboxes.Launches, 1);
    });
});

test("concurrent resolves of one provider launch once", async () =>
{
    await Env.With(async (provider, _npm, sandboxes) =>
    {
        await Promise.all([
            provider.Resolve({ Kind: DataSourceKind.Sql, Provider: "acme-pack@^1" }),
            provider.Resolve({ Kind: DataSourceKind.Rest, Provider: "acme-pack@^1" }),
        ]);
        assert.equal(sandboxes.Launches, 1);
    });
});

test("override disabled denies before any install or launch", async () =>
{
    await Env.With(async (provider, npm, sandboxes) =>
    {
        await Env.Rejects(provider.Resolve({ Kind: DataSourceKind.Sql, Provider: "acme-pack@^1" }), AdapterPackErrorKind.ProviderNotAllowed);
        assert.equal(npm.Installs, 0);
        assert.equal(sandboxes.Launches, 0);
    }, { allowProviderOverride: false });
});

test("a provider that is not allowlisted is denied before any side effect", async () =>
{
    await Env.With(async (provider, npm, sandboxes) =>
    {
        await Env.Rejects(provider.Resolve({ Kind: DataSourceKind.Sql, Provider: "acme-pack@^1" }), AdapterPackErrorKind.ProviderNotAllowed);
        assert.equal(npm.Installs, 0);
        assert.equal(sandboxes.Launches, 0);
    }, { providerAllowlist: ["other-pack"] });
});

test("an empty allowlist denies everything", async () =>
{
    await Env.With(async (provider, npm) =>
    {
        await Env.Rejects(provider.Resolve({ Kind: DataSourceKind.Sql, Provider: "acme-pack@^1" }), AdapterPackErrorKind.ProviderNotAllowed);
        assert.equal(npm.Installs, 0);
    }, { providerAllowlist: [] });
});

test("the allowlist matches by bare name", async () =>
{
    await Env.With(async (provider) =>
    {
        const factory = await provider.Resolve({ Kind: DataSourceKind.Sql, Provider: "acme-pack@^1" });
        assert.equal(factory.Kind, DataSourceKind.Sql);
    }, { providerAllowlist: ["acme-pack"] });
});

test("the allowlist matches by exact name@range and rejects other ranges", async () =>
{
    await Env.With(async (provider) =>
    {
        const factory = await provider.Resolve({ Kind: DataSourceKind.Sql, Provider: "acme-pack@^1" });
        assert.equal(factory.Kind, DataSourceKind.Sql);
        await Env.Rejects(provider.Resolve({ Kind: DataSourceKind.Sql, Provider: "acme-pack@^2" }), AdapterPackErrorKind.ProviderNotAllowed);
    }, { providerAllowlist: ["acme-pack@^1"] });
});

test("a kind-only request without a provider is rejected as an invalid spec", async () =>
{
    await Env.With(async (provider, npm) =>
    {
        await Env.Rejects(provider.Resolve({ Kind: DataSourceKind.Sql }), AdapterPackErrorKind.ProviderSpecInvalid);
        assert.equal(npm.Installs, 0);
    });
});

test("malformed specs are rejected as invalid", async () =>
{
    await Env.With(async (provider, npm) =>
    {
        await Env.Rejects(provider.Resolve({ Kind: DataSourceKind.Sql, Provider: "@@bad" }), AdapterPackErrorKind.ProviderSpecInvalid);
        await Env.Rejects(provider.Resolve({ Kind: DataSourceKind.Sql, Provider: "@x" }), AdapterPackErrorKind.ProviderSpecInvalid);
        await Env.Rejects(provider.Resolve({ Kind: DataSourceKind.Sql, Provider: "@1.0.0" }), AdapterPackErrorKind.ProviderSpecInvalid);
        assert.equal(npm.Installs, 0);
    });
});

test("scoped and unversioned specs parse (scoped name with range, bare name defaults to latest)", async () =>
{
    await Env.With(async (provider, npm) =>
    {
        await provider.Resolve({ Kind: DataSourceKind.Sql, Provider: "@scope/x@^1" });
        await provider.Resolve({ Kind: DataSourceKind.Sql, Provider: "acme-pack" });
        assert.equal(npm.Installs, 2);
    }, { providerAllowlist: ["@scope/x", "acme-pack"] });
});

test("a failed launch is not memoized and the next resolve retries", async () =>
{
    await Env.With(async (provider, _npm, sandboxes) =>
    {
        sandboxes.FailNext = true;
        await Env.Rejects(provider.Resolve({ Kind: DataSourceKind.Sql, Provider: "acme-pack@^1" }), AdapterPackErrorKind.SandboxLaunchFailed);
        const factory = await provider.Resolve({ Kind: DataSourceKind.Sql, Provider: "acme-pack@^1" });
        assert.equal(factory.Kind, DataSourceKind.Sql);
        assert.equal(sandboxes.Launches, 2);
    });
});

test("requireSignatures makes the installer audit signatures", async () =>
{
    await Env.With(async (provider, npm) =>
    {
        await provider.Resolve({ Kind: DataSourceKind.Sql, Provider: "acme-pack@^1" });
        assert.equal(npm.Audits, 1);
    }, { requireSignatures: true });
});

test("Dispose disposes every launched sandbox and later resolves reject", async () =>
{
    await Env.With(async (provider, _npm, sandboxes) =>
    {
        await provider.Resolve({ Kind: DataSourceKind.Sql, Provider: "acme-pack@^1" });
        await provider.Resolve({ Kind: DataSourceKind.Sql, Provider: "other-pack@^1" });
        assert.equal(sandboxes.Sandboxes.length, 2);
        await provider.Dispose();
        assert.ok(sandboxes.Sandboxes.every(s => s.Disposed));
        await assert.rejects(provider.Resolve({ Kind: DataSourceKind.Sql, Provider: "acme-pack@^1" }), AdapterPackError);
    });
});
