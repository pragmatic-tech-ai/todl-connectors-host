import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/** Bounds applied by {@link PackCache.Evict}; an omitted bound is not enforced. */
export interface CacheEvictionPolicy
{
    readonly MaxVersionsPerPack?: number;
    readonly MaxAgeMs?: number;
}

/** The shared on-disk adapter-pack cache laid out as `<cacheDir>/<name>/<version>/`. */
export class PackCache
{
    private static readonly AccessMarker = ".todl-accessed";
    private static readonly ScopePrefix = "@";
    private static readonly HiddenPrefix = ".";
    private static readonly Utf8 = "utf8";
    private static readonly RaceCodes: readonly string[] = ["EEXIST", "ENOTEMPTY", "EPERM"];

    public constructor(private readonly cacheDir: string)
    {
    }

    public PathFor(name: string, version: string): string
    {
        return join(this.cacheDir, name, version);
    }

    public async Has(root: string): Promise<boolean>
    {
        try
        {
            await stat(root);
            return true;
        }
        catch
        {
            return false;
        }
    }

    /** Records an access time on the root; a vanished root is ignored. */
    public async Touch(root: string): Promise<void>
    {
        try
        {
            await writeFile(join(root, PackCache.AccessMarker), String(Date.now()));
        }
        catch
        {
            // root is gone or unwritable; the marker is advisory only
        }
    }

    /**
     * Atomically moves a fully-built tmp dir into place as root. Returns true when this call
     * renamed tmp; false when an existing root won the race (the caller still owns tmp cleanup).
     */
    public async Promote(tmp: string, root: string): Promise<boolean>
    {
        let promoted = false;
        if (!(await this.Has(root)))
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
                if (!PackCache.RaceCodes.includes(code) || !(await this.Has(root)))
                {
                    throw err;
                }
            }
        }
        await this.Touch(root);
        return promoted;
    }

    /**
     * Best-effort LRU/age GC. Versions of each pack are ranked by access marker (missing = oldest);
     * those beyond MaxVersionsPerPack or older than MaxAgeMs are removed, except roots in inUse
     * (absolute root paths). Returns the roots actually removed.
     */
    public async Evict(policy: CacheEvictionPolicy, inUse: ReadonlySet<string>): Promise<readonly string[]>
    {
        const removed: string[] = [];
        const now = Date.now();
        for (const name of await this.ListPackNames())
        {
            const entries: { root: string; accessed: number }[] = [];
            for (const version of await this.ListDirs(join(this.cacheDir, name)))
            {
                const root = this.PathFor(name, version);
                entries.push({ root, accessed: await this.ReadAccessed(root) });
            }
            entries.sort((a, b) => b.accessed - a.accessed);
            for (let i = 0; i < entries.length; i++)
            {
                const entry = entries[i];
                const overCount = policy.MaxVersionsPerPack !== undefined && i >= policy.MaxVersionsPerPack;
                const tooOld = policy.MaxAgeMs !== undefined && now - entry.accessed > policy.MaxAgeMs;
                if ((overCount || tooOld) && !inUse.has(entry.root) && await this.TryRemove(entry.root))
                {
                    removed.push(entry.root);
                }
            }
        }
        return removed;
    }

    private async ListPackNames(): Promise<string[]>
    {
        const names: string[] = [];
        for (const top of await this.ListDirs(this.cacheDir))
        {
            if (top.startsWith(PackCache.ScopePrefix))
            {
                for (const child of await this.ListDirs(join(this.cacheDir, top)))
                {
                    names.push(`${top}/${child}`);
                }
            }
            else
            {
                names.push(top);
            }
        }
        return names;
    }

    private async ListDirs(dir: string): Promise<string[]>
    {
        try
        {
            const entries = await readdir(dir, { withFileTypes: true });
            return entries.filter(e => e.isDirectory() && !e.name.startsWith(PackCache.HiddenPrefix)).map(e => e.name);
        }
        catch
        {
            return [];
        }
    }

    private async ReadAccessed(root: string): Promise<number>
    {
        try
        {
            const value = Number(await readFile(join(root, PackCache.AccessMarker), PackCache.Utf8));
            return Number.isFinite(value) ? value : 0;
        }
        catch
        {
            return 0;
        }
    }

    private async TryRemove(root: string): Promise<boolean>
    {
        try
        {
            await rm(root, { recursive: true, force: true });
            return true;
        }
        catch
        {
            return false;
        }
    }
}
