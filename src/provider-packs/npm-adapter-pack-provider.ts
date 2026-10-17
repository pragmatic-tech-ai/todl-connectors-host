import type { AdapterResolutionRequest, IDataSourceAdapterFactory, IDataSourceAdapterProvider } from "@pragmatic-tech-ai/todl";
import { AdapterPackError, AdapterPackErrorKind } from "./adapter-pack-error.js";
import { AdapterPackInstaller } from "./adapter-pack-installer.js";
import type { InstalledPack } from "./adapter-pack-installer.js";
import { NpmCli } from "./npm-cli.js";
import type { INpmCli } from "./npm-cli.js";
import { PackCache } from "./pack-cache.js";
import type { CacheEvictionPolicy } from "./pack-cache.js";
import type { IPackSandbox, IPackSandboxFactory, PackSandboxOptions } from "./sandbox/pack-sandbox.js";

export interface NpmAdapterPackProviderOptions
{
    readonly cacheDir: string;
    readonly sandboxFactory: IPackSandboxFactory;
    readonly allowProviderOverride: boolean;
    /** Bare names or full "name@range" specs. An empty allowlist denies every provider (fail-closed). */
    readonly providerAllowlist: readonly string[];
    readonly sandboxOptions?: PackSandboxOptions;
    readonly requireSignatures?: boolean;
    readonly eviction?: CacheEvictionPolicy;
    readonly npm?: INpmCli;
}

interface ProviderSpec
{
    readonly Name: string;
    readonly Range: string;
}

/**
 * Resolves a connector's named `provider = "name@range"` to a sandboxed pack adapter factory.
 * The policy gate runs before any install or launch; installs and launches are memoized so connectors
 * and kinds sharing one pack version share one sandbox.
 */
export class NpmAdapterPackProvider implements IDataSourceAdapterProvider
{
    private static readonly SpecSeparator = "@";
    private static readonly OverrideDisabledMessage = "connector provider override is disabled by policy";
    private static readonly NotAllowlistedMessage = "connector provider is not allowlisted";
    private static readonly MissingProviderMessage = "npm adapter pack provider requires a named provider";
    private static readonly BadSpecMessage = "invalid adapter pack provider spec";
    private static readonly DisposedMessage = "npm adapter pack provider is disposed";
    private static readonly LatestRange = "latest";
    /** Registry semver version/range or dist-tag characters only: no ":" or "/" so no url/file/git/alias specifiers. */
    private static readonly RangePattern = /^[A-Za-z0-9*^~<>=][A-Za-z0-9.+^~<>=*| -]*$/;
    private static readonly ParentSegment = "..";

    private readonly installer: AdapterPackInstaller;
    private readonly cache: PackCache;
    private readonly launches = new Map<string, Promise<IPackSandbox>>();
    private readonly rootsByName = new Map<string, Set<string>>();
    private disposed = false;

    public constructor(private readonly options: NpmAdapterPackProviderOptions)
    {
        const npm = options.npm ?? new NpmCli();
        this.installer = new AdapterPackInstaller(options.cacheDir, npm, options.requireSignatures ?? false);
        this.cache = new PackCache(options.cacheDir);
    }

    public async Resolve(request: AdapterResolutionRequest): Promise<IDataSourceAdapterFactory>
    {
        this.EnsureLive();
        const spec = NpmAdapterPackProvider.ParseSpec(request.Provider);
        this.Admit(spec);
        const installed = await this.installer.Install(spec.Name, spec.Range);
        this.EnsureLive();
        const sandbox = await this.LaunchFor(installed);
        return sandbox.Factory(request.Kind);
    }

    private EnsureLive(): void
    {
        if (this.disposed)
        {
            throw new AdapterPackError(AdapterPackErrorKind.SandboxCrashed, NpmAdapterPackProvider.DisposedMessage);
        }
    }

    public async Dispose(): Promise<void>
    {
        this.disposed = true;
        const launches = [...this.launches.values()];
        this.launches.clear();
        this.rootsByName.clear();
        await Promise.allSettled(launches.map(l => l.then(s => s.Dispose(), () => undefined)));
    }

    private static ParseSpec(provider: string | undefined): ProviderSpec
    {
        if (provider === undefined || provider.length === 0)
        {
            throw new AdapterPackError(AdapterPackErrorKind.ProviderSpecInvalid, NpmAdapterPackProvider.MissingProviderMessage);
        }
        const at = provider.lastIndexOf(NpmAdapterPackProvider.SpecSeparator);
        const hasRange = at > 0;
        const name = hasRange ? provider.slice(0, at) : provider;
        const range = hasRange ? provider.slice(at + 1) : NpmAdapterPackProvider.LatestRange;
        const badRange = !NpmAdapterPackProvider.RangePattern.test(range) || range.includes(NpmAdapterPackProvider.ParentSegment);
        if (!AdapterPackInstaller.NamePattern.test(name) || badRange)
        {
            throw new AdapterPackError(AdapterPackErrorKind.ProviderSpecInvalid, NpmAdapterPackProvider.BadSpecMessage);
        }
        return { Name: name, Range: range };
    }

    private Admit(spec: ProviderSpec): void
    {
        if (!this.options.allowProviderOverride)
        {
            throw new AdapterPackError(AdapterPackErrorKind.ProviderNotAllowed, NpmAdapterPackProvider.OverrideDisabledMessage);
        }
        if (!this.IsAllowlisted(spec))
        {
            throw new AdapterPackError(AdapterPackErrorKind.ProviderNotAllowed, NpmAdapterPackProvider.NotAllowlistedMessage);
        }
    }

    private IsAllowlisted(spec: ProviderSpec): boolean
    {
        const full = `${spec.Name}${NpmAdapterPackProvider.SpecSeparator}${spec.Range}`;
        return this.options.providerAllowlist.includes(spec.Name) || this.options.providerAllowlist.includes(full);
    }

    private LaunchFor(installed: InstalledPack): Promise<IPackSandbox>
    {
        const existing = this.launches.get(installed.Root);
        if (existing !== undefined)
        {
            return existing;
        }
        const launch: Promise<IPackSandbox> = this.options.sandboxFactory.Launch(installed, this.options.sandboxOptions).then(async sandbox =>
        {
            if (this.disposed)
            {
                await sandbox.Dispose().catch(() => undefined);
                throw new AdapterPackError(AdapterPackErrorKind.SandboxCrashed, NpmAdapterPackProvider.DisposedMessage);
            }
            return sandbox;
        }).catch((err: unknown) =>
        {
            if (this.launches.get(installed.Root) === launch)
            {
                this.launches.delete(installed.Root);
            }
            throw err;
        });
        this.launches.set(installed.Root, launch);
        this.Track(installed.Name, installed.Root);
        return launch;
    }

    private Track(name: string, root: string): void
    {
        const roots = this.rootsByName.get(name) ?? new Set<string>();
        roots.add(root);
        this.rootsByName.set(name, roots);
    }
}
