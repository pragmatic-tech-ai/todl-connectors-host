import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
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
 */
export class ScriptAllowlist
{
    private static readonly Utf8 = "utf8";
    private static readonly TempSuffix = ".tmp";
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
        const names = await this.Read();
        if (names.has(name))
        {
            return;
        }
        names.add(name);
        await this.Write(names);
    }

    public async Deny(name: string): Promise<void>
    {
        ScriptAllowlist.Validate(name);
        const names = await this.Read();
        if (!names.delete(name))
        {
            return;
        }
        await this.Write(names);
    }

    private async Read(): Promise<Set<string>>
    {
        let text: string;
        try
        {
            text = await readFile(this.filePath, ScriptAllowlist.Utf8);
        }
        catch
        {
            // No file yet: the seed is the current list. A seed entry that is not a valid name is dropped.
            return new Set(this.seed.filter(n => ScriptAllowlist.IsValid(n)));
        }
        const parsed = JSON.parse(text) as AllowlistFile;
        const raw = Array.isArray(parsed?.names) ? parsed.names : [];
        return new Set(raw.filter((n): n is string => typeof n === "string" && ScriptAllowlist.IsValid(n)));
    }

    private async Write(names: ReadonlySet<string>): Promise<void>
    {
        await mkdir(dirname(this.filePath), { recursive: true });
        const payload = JSON.stringify({ [ScriptAllowlist.NamesKey]: [...names].sort() }, null, 2);
        const tmp = join(dirname(this.filePath), `${ScriptAllowlist.TempSuffix}-${process.pid}-${Date.now()}`);
        await writeFile(tmp, payload);
        await rename(tmp, this.filePath);
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
