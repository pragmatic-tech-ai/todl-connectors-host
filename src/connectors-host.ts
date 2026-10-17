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

    public async Dispose(): Promise<void>
    {
        await this.Catalog.Dispose();
        // The engine's provider type has no Dispose; concrete providers (NpmAdapterPackProvider) do.
        const disposable = this.provider as { Dispose?: () => Promise<void> } | undefined;
        try
        {
            await disposable?.Dispose?.();
        }
        catch
        {
            // Provider teardown failure must not break host shutdown.
        }
    }
}
