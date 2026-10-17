import { DataSourceAdapterCatalog, ConnectionResolverKey, ResolutionAuditSinkKey } from "@pragmatic-tech-ai/todl";
import type { IConnectionResolver, IDataSourceAdapterProvider, IResolutionAuditSink } from "@pragmatic-tech-ai/todl";
import type { ServiceProvider } from "@pragmatic-tech-ai/todl-runtime";
import { SqlAdapterFactory } from "./sql/sql-adapter-factory.js";
import type { PgPoolBuilder } from "./sql/sql-adapter-factory.js";
import { RestAdapterFactory } from "./rest/rest-adapter-factory.js";
import type { IRestHttpClient } from "./rest/rest-http-client.js";
import { CypherAdapterFactory } from "./cypher/cypher-adapter-factory.js";
import { DocumentAdapterFactory } from "./document/document-adapter-factory.js";

/** Optional injectable seams (tests inject fakes; production may inject a secret-resolving ConnectionResolver). */
export interface ConnectorsHostOptions
{
    restClient?: IRestHttpClient;
    buildPool?: PgPoolBuilder;
    connectionResolver?: IConnectionResolver;
    auditSink?: IResolutionAuditSink;
    /** Resolves provider-pack adapter factories for connectors that name a provider. */
    readonly provider?: IDataSourceAdapterProvider;
}

/** Composition root: registers all adapter factories and owns the catalog's lifecycle. */
export class ConnectorsHost
{
    private static readonly ProviderDisposeFailed = "ConnectorsHost: provider dispose failed";

    public readonly Catalog: DataSourceAdapterCatalog;

    private readonly connectionResolver?: IConnectionResolver;
    private readonly auditSink?: IResolutionAuditSink;
    private readonly provider?: IDataSourceAdapterProvider;

    public constructor(options?: ConnectorsHostOptions)
    {
        this.connectionResolver = options?.connectionResolver;
        this.auditSink = options?.auditSink;
        this.provider = options?.provider;
        this.Catalog = new DataSourceAdapterCatalog(options?.provider)
            .Register(new SqlAdapterFactory(options?.buildPool))
            .Register(new RestAdapterFactory(options?.restClient))
            .Register(new CypherAdapterFactory())
            .Register(new DocumentAdapterFactory());
    }

    public Register(services: ServiceProvider): this
    {
        services.registerInstance(DataSourceAdapterCatalog.ServiceKey, this.Catalog);
        if (this.connectionResolver !== undefined)
        {
            services.registerInstance(ConnectionResolverKey, this.connectionResolver);
        }
        if (this.auditSink !== undefined)
        {
            services.registerInstance(ResolutionAuditSinkKey, this.auditSink);
        }
        return this;
    }

    /** Hot-upgrade: asks the provider to drop its cached pack for `name`. No-op when there is no provider or it lacks Invalidate. */
    public async InvalidateProvider(name: string): Promise<void>
    {
        // The engine's provider type has no Invalidate; concrete providers (NpmAdapterPackProvider) do.
        const target = this.provider as { Invalidate?: (n: string) => Promise<void> } | undefined;
        await target?.Invalidate?.(name);
    }

    /** Allows install scripts for a pack. No-op when there is no provider or it lacks AllowScripts. */
    public async AllowPackScripts(name: string): Promise<void>
    {
        const target = this.provider as { AllowScripts?: (n: string) => Promise<void> } | undefined;
        await target?.AllowScripts?.(name);
    }

    public async DenyPackScripts(name: string): Promise<void>
    {
        const target = this.provider as { DenyScripts?: (n: string) => Promise<void> } | undefined;
        await target?.DenyScripts?.(name);
    }

    public async ListPackScriptAllowlist(): Promise<readonly string[]>
    {
        const target = this.provider as { ListScriptAllowlist?: () => Promise<readonly string[]> } | undefined;
        return (await target?.ListScriptAllowlist?.()) ?? [];
    }

    public async Dispose(): Promise<void>
    {
        // Both teardowns always run: a catalog failure must not skip the provider (sandbox/child leak).
        let catalogError: unknown;
        let catalogFailed = false;
        try
        {
            await this.Catalog.Dispose();
        }
        catch (err)
        {
            catalogFailed = true;
            catalogError = err;
        }
        // The engine's provider type has no Dispose; concrete providers (NpmAdapterPackProvider) do.
        const disposable = this.provider as { Dispose?: () => Promise<void> } | undefined;
        try
        {
            await disposable?.Dispose?.();
        }
        catch (err)
        {
            // Provider teardown failure must not break host shutdown, but it is surfaced, not dropped.
            console.warn(ConnectorsHost.ProviderDisposeFailed, err);
        }
        if (catalogFailed)
        {
            throw catalogError;
        }
    }
}
