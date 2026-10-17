import { mkdir, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/** The shared on-disk adapter-pack cache laid out as `<cacheDir>/<name>/<version>/`. */
export class PackCache
{
    private static readonly AccessMarker = ".todl-accessed";
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
}
