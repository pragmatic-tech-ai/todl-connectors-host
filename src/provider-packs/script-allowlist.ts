import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { AdapterPackError, AdapterPackErrorKind } from "./adapter-pack-error.js";
import { AdapterPackInstaller } from "./adapter-pack-installer.js";

interface AllowlistFile
{
    names?: unknown;
}

/**
 * Deployment-global allowlist of pack names permitted to run npm install scripts, persisted as one JSON file.
 * A missing file reads as the construction-time seed; every mutation is written atomically (tmp + rename).
 * Reads go to disk each call so sibling per-tenant providers sharing one cacheDir observe each other's edits.
 * Writes are serialized in-process per path by a mutex (cross-process races on a shared cacheDir are unsupported;
 * the atomic rename keeps the file valid). A non-ENOENT read error and a corrupt/garbage file both THROW, and
 * callers must treat a throw as "not allowed" (fail closed).
 */
export class ScriptAllowlist
{
    private static readonly Utf8 = "utf8";
    private static readonly TempPrefix = ".allowlist-tmp";
    private static readonly MissingFileCode = "ENOENT";
    private static readonly Locks = new Map<string, Promise<void>>();
    private static readonly NamesKey = "names";
    private static readonly MaxNameLength = 214;

    public constructor(private readonly filePath: string, private readonly seed: readonly string[])
    {
    }

    public async Has(name: string): Promise<boolean>
    {
        return (await this.Read()).has(name);
    }

    public async List(): Promise<readonly string[]>
    {
        return [...await this.Read()].sort();
    }

    public async Allow(name: string): Promise<void>
    {
        ScriptAllowlist.Validate(name);
        await this.Mutate(names =>
        {
            if (names.has(name))
            {
                return false;
            }
            names.add(name);
            return true;
        });
    }

    public async Deny(name: string): Promise<void>
    {
        ScriptAllowlist.Validate(name);
        await this.Mutate(names => names.delete(name));
    }

    private async Mutate(change: (names: Set<string>) => boolean): Promise<void>
    {
        const key = resolve(this.filePath);
        const prior = ScriptAllowlist.Locks.get(key) ?? Promise.resolve();
        const run: Promise<void> = prior.catch(() => undefined).then(async () =>
        {
            const names = await this.Read();
            if (!change(names))
            {
                return;
            }
            await this.Write(names);
        });
        ScriptAllowlist.Locks.set(key, run);
        try
        {
            await run;
        }
        finally
        {
            if (ScriptAllowlist.Locks.get(key) === run)
            {
                ScriptAllowlist.Locks.delete(key);
            }
        }
    }

    private async Read(): Promise<Set<string>>
    {
        let text: string;
        try
        {
            text = await readFile(this.filePath, ScriptAllowlist.Utf8);
        }
        catch (err)
        {
            if ((err as NodeJS.ErrnoException).code === ScriptAllowlist.MissingFileCode)
            {
                // No file yet: the seed is the current list. A seed entry that is not a valid name is dropped.
                return new Set(this.seed.filter(n => ScriptAllowlist.IsValid(n)));
            }
            throw err;
        }
        const parsed = JSON.parse(text) as AllowlistFile;
        const raw = Array.isArray(parsed?.names) ? parsed.names : [];
        return new Set(raw.filter((n): n is string => typeof n === "string" && ScriptAllowlist.IsValid(n)));
    }

    private async Write(names: ReadonlySet<string>): Promise<void>
    {
        await mkdir(dirname(this.filePath), { recursive: true });
        const payload = JSON.stringify({ [ScriptAllowlist.NamesKey]: [...names].sort() }, null, 2);
        const tmp = join(dirname(this.filePath), `${ScriptAllowlist.TempPrefix}-${process.pid}-${randomUUID()}`);
        try
        {
            await writeFile(tmp, payload);
            await rename(tmp, this.filePath);
        }
        catch (err)
        {
            await rm(tmp, { force: true });
            throw err;
        }
    }

    private static Validate(name: string): void
    {
        if (!ScriptAllowlist.IsValid(name))
        {
            throw new AdapterPackError(AdapterPackErrorKind.InvalidName, `Invalid adapter pack name: ${JSON.stringify(name)}`);
        }
    }

    private static IsValid(name: unknown): name is string
    {
        return typeof name === "string" && name.length <= ScriptAllowlist.MaxNameLength && AdapterPackInstaller.NamePattern.test(name);
    }
}
