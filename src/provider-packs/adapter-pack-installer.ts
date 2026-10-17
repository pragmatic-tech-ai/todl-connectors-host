import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { AdapterPackError, AdapterPackErrorKind } from "./adapter-pack-error.js";
import { AdapterPackManifestReader } from "./adapter-pack-manifest-reader.js";
import type { INpmCli } from "./npm-cli.js";

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
    private static readonly RaceCodes: readonly string[] = ["EEXIST", "ENOTEMPTY", "EPERM"];

    private readonly inFlight = new Map<string, Promise<InstalledPack>>();
    private readonly resolved = new Map<string, InstalledPack>();

    public constructor(private readonly cacheDir: string, private readonly npm: INpmCli)
    {
    }

    public Install(name: string, range: string): Promise<InstalledPack>
    {
        const key = `${name}@${range}`;
        const cached = this.resolved.get(key);
        if (cached !== undefined)
        {
            return Promise.resolve(cached);
        }
        const existing = this.inFlight.get(key);
        if (existing !== undefined)
        {
            return existing;
        }
        const promise = this.Resolve(name, range).then(pack =>
        {
            this.resolved.set(key, pack);
            return pack;
        }).finally(() =>
        {
            this.inFlight.delete(key);
        });
        this.inFlight.set(key, promise);
        return promise;
    }

    private async Resolve(name: string, range: string): Promise<InstalledPack>
    {
        await mkdir(this.cacheDir, { recursive: true });
        const tmp = await mkdtemp(join(this.cacheDir, AdapterPackInstaller.TempPrefix));
        let promoted = false;
        try
        {
            const installJson = { name: AdapterPackInstaller.InstallPackageName, private: true, dependencies: { [name]: range } };
            await writeFile(join(tmp, AdapterPackInstaller.PackageJsonName), JSON.stringify(installJson, null, 2));
            await this.npm.Install(tmp);
            const version = await this.ReadLockedVersion(tmp, name);
            await AdapterPackManifestReader.Read(join(tmp, AdapterPackInstaller.NodeModules, name));

            const root = join(this.cacheDir, name, version);
            if (!(await this.Exists(root)))
            {
                await mkdir(dirname(root), { recursive: true });
                try
                {
                    await rename(tmp, root);
                    promoted = true;
                }
                catch (err)
                {
                    const code = (err as NodeJS.ErrnoException).code ?? "";
                    if (!AdapterPackInstaller.RaceCodes.includes(code) || !(await this.Exists(root)))
                    {
                        throw err;
                    }
                }
            }
            const { manifest } = await AdapterPackManifestReader.Read(join(root, AdapterPackInstaller.NodeModules, name));
            return {
                Name: name,
                Version: version,
                Root: root,
                Entry: join(root, AdapterPackInstaller.NodeModules, name, manifest.entry),
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

    private async Exists(path: string): Promise<boolean>
    {
        try
        {
            await stat(path);
            return true;
        }
        catch
        {
            return false;
        }
    }
}
