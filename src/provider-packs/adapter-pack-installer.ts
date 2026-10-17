import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { AdapterPackError, AdapterPackErrorKind } from "./adapter-pack-error.js";
import { AdapterPackManifestReader } from "./adapter-pack-manifest-reader.js";
import type { INpmCli } from "./npm-cli.js";
import { PackCache } from "./pack-cache.js";
import type { ScriptAllowlist } from "./script-allowlist.js";

/** An adapter pack resolved and installed on disk. */
export interface InstalledPack
{
    readonly Name: string;
    readonly Version: string;
    readonly Root: string;
    readonly Entry: string;
    readonly Kinds: readonly string[];
}

/** Resolves a `name@range` provider spec to an installed-on-disk pack, cached per resolved version. */
export class AdapterPackInstaller
{
    private static readonly LockfileName = "package-lock.json";
    private static readonly NodeModules = "node_modules";
    private static readonly PackageJsonName = "package.json";
    private static readonly TempPrefix = ".tmp-";
    private static readonly InstallPackageName = "adapter-pack-install";
    private static readonly LockPackagesPrefix = "node_modules/";
    private static readonly Utf8 = "utf8";
    public static readonly NamePattern = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;
    private static readonly MaxNameLength = 214;
    private static readonly ParentSegment = "..";
    private static readonly SpecSeparator = "@";

    private readonly inFlight = new Map<string, Promise<InstalledPack>>();
    private readonly resolved = new Map<string, InstalledPack>();

    private readonly cache: PackCache;

    public constructor(private readonly cacheDir: string, private readonly npm: INpmCli, private readonly requireSignatures: boolean = false, private readonly scripts?: ScriptAllowlist)
    {
        this.cache = new PackCache(cacheDir);
    }

    public async AllowScripts(name: string): Promise<void>
    {
        await this.scripts?.Allow(name);
    }

    public async DenyScripts(name: string): Promise<void>
    {
        await this.scripts?.Deny(name);
    }

    public async ListScriptAllowlist(): Promise<readonly string[]>
    {
        return (await this.scripts?.List()) ?? [];
    }

    public async Install(name: string, range: string): Promise<InstalledPack>
    {
        const key = `${name}${AdapterPackInstaller.SpecSeparator}${range}`;
        const cached = this.resolved.get(key);
        if (cached !== undefined)
        {
            if (await this.cache.Has(cached.Root))
            {
                await this.cache.Touch(cached.Root);
                return cached;
            }
            this.resolved.delete(key);
        }
        // Two ranges of one name that resolve to the same version run npm twice into separate tmp dirs; both
        // Promote, one wins the rename and the loser reuses the winner. The result is correct and only the
        // duplicate install is wasted, so in-flight work is deliberately keyed by spec and not coalesced by
        // resolved version (that is only known after npm has run).
        const existing = this.inFlight.get(key);
        if (existing !== undefined)
        {
            return existing;
        }
        const promise: Promise<InstalledPack> = this.Resolve(name, range).then(pack =>
        {
            if (this.inFlight.get(key) === promise)
            {
                this.resolved.set(key, pack);
            }
            return pack;
        }).finally(() =>
        {
            if (this.inFlight.get(key) === promise)
            {
                this.inFlight.delete(key);
            }
        });
        this.inFlight.set(key, promise);
        return promise;
    }

    /** Roots of every currently-memoized resolved pack (absolute paths), for in-use accounting by cache GC. */
    public ResolvedRoots(): readonly string[]
    {
        return [...this.resolved.values()].map(p => p.Root);
    }

    /** Drops the memo (resolved and in-flight) for every range of `name`, so the next Install re-runs npm. The on-disk cache is untouched. */
    public Invalidate(name: string): void
    {
        const prefix = `${name}${AdapterPackInstaller.SpecSeparator}`;
        for (const key of [...this.resolved.keys()])
        {
            if (key.startsWith(prefix))
            {
                this.resolved.delete(key);
            }
        }
        for (const key of [...this.inFlight.keys()])
        {
            if (key.startsWith(prefix))
            {
                this.inFlight.delete(key);
            }
        }
    }

    private async Resolve(name: string, range: string): Promise<InstalledPack>
    {
        AdapterPackInstaller.ValidateName(name);
        await mkdir(this.cacheDir, { recursive: true });
        const tmp = await mkdtemp(join(this.cacheDir, AdapterPackInstaller.TempPrefix));
        let promoted = false;
        try
        {
            const installJson = { name: AdapterPackInstaller.InstallPackageName, private: true, dependencies: { [name]: range } };
            await writeFile(join(tmp, AdapterPackInstaller.PackageJsonName), JSON.stringify(installJson, null, 2));
            await this.npm.Install(tmp); // always --ignore-scripts (see NpmCli.InstallArgs)
            // A throwing Has (unreadable or corrupt allowlist) propagates, so the install fails closed.
            const allowScripts = (await this.scripts?.Has(name)) ?? false;
            if (allowScripts)
            {
                // Signature-first: an allowlisted pack is about to run arbitrary code on the host, so its registry
                // signature is verified NOW (mandatory, fail-closed) and the lifecycle scripts run only if it passes.
                await this.npm.AuditSignatures(tmp);
                await this.npm.RunInstallScripts(tmp);
            }
            else if (this.requireSignatures)
            {
                await this.npm.AuditSignatures(tmp);
            }
            const version = await this.ReadLockedVersion(tmp, name);
            const tmpPackDir = join(tmp, AdapterPackInstaller.NodeModules, name);
            const tmpRead = await AdapterPackManifestReader.Read(tmpPackDir);
            AdapterPackInstaller.EnsureEntryInside(tmpPackDir, tmpRead.manifest.entry, name);

            const root = this.cache.PathFor(name, version);
            promoted = await this.cache.Promote(tmp, root);
            const packDir = join(root, AdapterPackInstaller.NodeModules, name);
            const { manifest } = await AdapterPackManifestReader.Read(packDir);
            AdapterPackInstaller.EnsureEntryInside(packDir, manifest.entry, name);
            return {
                Name: name,
                Version: version,
                Root: root,
                Entry: join(packDir, manifest.entry),
                Kinds: manifest.kinds
            };
        }
        finally
        {
            if (!promoted)
            {
                await rm(tmp, { recursive: true, force: true });
            }
        }
    }

    private static ValidateName(name: string): void
    {
        if (typeof name !== "string" || name.length > AdapterPackInstaller.MaxNameLength || !AdapterPackInstaller.NamePattern.test(name))
        {
            throw new AdapterPackError(AdapterPackErrorKind.InvalidName, `Invalid adapter pack name: ${JSON.stringify(name)}`);
        }
    }

    private static EnsureEntryInside(packDir: string, entry: string, name: string): void
    {
        const rel = relative(packDir, resolve(packDir, entry));
        if (rel === "" || isAbsolute(rel) || rel === AdapterPackInstaller.ParentSegment || rel.startsWith(AdapterPackInstaller.ParentSegment + sep))
        {
            throw new AdapterPackError(AdapterPackErrorKind.ManifestInvalid, `${name} manifest entry "${entry}" escapes the pack directory`);
        }
    }

    private async ReadLockedVersion(tmp: string, name: string): Promise<string>
    {
        const file = join(tmp, AdapterPackInstaller.LockfileName);
        let version: unknown;
        try
        {
            const lock = JSON.parse(await readFile(file, AdapterPackInstaller.Utf8));
            version = lock?.packages?.[AdapterPackInstaller.LockPackagesPrefix + name]?.version ?? lock?.dependencies?.[name]?.version;
        }
        catch (err)
        {
            throw new AdapterPackError(AdapterPackErrorKind.LockfileUnreadable, `Cannot read ${file}: ${(err as Error).message}`);
        }
        if (typeof version !== "string")
        {
            throw new AdapterPackError(AdapterPackErrorKind.LockfileUnreadable, `${file} does not pin ${name}`);
        }
        return version;
    }
}
