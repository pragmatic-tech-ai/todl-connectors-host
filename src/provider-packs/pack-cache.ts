import { mkdir, readFile, readdir, rename, rm, rmdir, stat, writeFile } from "node:fs/promises";
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
            // Stamp the access marker inside tmp so it promotes atomically with the tree: a concurrent
            // Evict can never see the fresh root without a marker (which would rank it oldest).
            await this.Touch(tmp);
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
        if (!promoted)
        {
            await this.Touch(root);
        }
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
            // In-use roots are never removable and do not occupy a keep-slot, so they are ranked out.
            let slot = 0;
            for (const entry of entries)
            {
                if (inUse.has(entry.root))
                {
                    continue;
                }
                const overCount = policy.MaxVersionsPerPack !== undefined && slot >= policy.MaxVersionsPerPack;
                slot++;
                const tooOld = policy.MaxAgeMs !== undefined && now - entry.accessed > policy.MaxAgeMs;
                if ((overCount || tooOld) && await this.TryRemove(entry.root))
                {
                    removed.push(entry.root);
                }
            }
            await this.PruneEmptyParents(name);
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

    /** Removes the emptied `<name>/` dir and, for scoped packs, its emptied `@scope/` dir; non-empty dirs are left alone. */
    private async PruneEmptyParents(name: string): Promise<void>
    {
        const nameDir = join(this.cacheDir, name);
        const scopeDir = dirname(nameDir);
        const scoped = name.startsWith(PackCache.ScopePrefix);
        try
        {
            await rmdir(nameDir);
        }
        catch
        {
            return;
        }
        if (scoped)
        {
            try
            {
                await rmdir(scopeDir);
            }
            catch
            {
                // other packs still live under this scope
            }
        }
    }

    /** Deletes a root tree; overridable so tests can simulate an un-removable (locked) root. */
    protected async RemoveTree(root: string): Promise<void>
    {
        await rm(root, { recursive: true, force: true });
    }

    private async TryRemove(root: string): Promise<boolean>
    {
        try
        {
            await this.RemoveTree(root);
            return true;
        }
        catch
        {
            return false;
        }
    }
}
