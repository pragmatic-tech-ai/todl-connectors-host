import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { AdapterPackContract } from "@pragmatic-tech-ai/todl/adapter-pack";
import type { AdapterPackManifest } from "@pragmatic-tech-ai/todl/adapter-pack";
import { AdapterPackError, AdapterPackErrorKind } from "./adapter-pack-error.js";

/** A pack's parsed manifest plus its raw package.json. */
export interface ReadAdapterPackManifest
{
    manifest: AdapterPackManifest;
    packageJson: Record<string, unknown>;
}

/** Reads and validates the `todl.adapterPack` block of an installed pack's package.json. */
export class AdapterPackManifestReader
{
    private static readonly PackageJsonFile = "package.json";
    private static readonly Utf8 = "utf8";

    public static async Read(packageRoot: string): Promise<ReadAdapterPackManifest>
    {
        const file = join(packageRoot, AdapterPackManifestReader.PackageJsonFile);
        let pkg: any;
        try
        {
            pkg = JSON.parse(await readFile(file, AdapterPackManifestReader.Utf8));
        }
        catch (err)
        {
            throw new AdapterPackError(AdapterPackErrorKind.ManifestMissing, `Cannot read ${file}: ${(err as Error).message}`);
        }
        const blockPath = `${AdapterPackContract.TodlBlockKey}.${AdapterPackContract.ManifestKey}`;
        const block = pkg?.[AdapterPackContract.TodlBlockKey]?.[AdapterPackContract.ManifestKey];
        if (block === undefined || block === null)
        {
            throw new AdapterPackError(AdapterPackErrorKind.ManifestMissing, `${file} has no ${blockPath} block`);
        }
        const kinds = block.kinds;
        const valid = typeof block.entry === "string"
            && Array.isArray(kinds) && kinds.length > 0 && kinds.every((k: unknown) => typeof k === "string")
            && typeof block.sdk === "string";
        if (!valid)
        {
            throw new AdapterPackError(AdapterPackErrorKind.ManifestInvalid, `${file} has a malformed ${blockPath} block`);
        }
        if (block.sdk !== AdapterPackContract.AbiVersion)
        {
            throw new AdapterPackError(AdapterPackErrorKind.AbiMismatch, `${file} declares sdk ${block.sdk}; host supports ${AdapterPackContract.AbiVersion}`);
        }
        return { manifest: { entry: block.entry, kinds, sdk: block.sdk }, packageJson: pkg };
    }
}
