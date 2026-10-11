import { DataSourceKind } from "@pragmatic-tech-ai/todl";
import type { IDataSourceAdapter, IDataSourceAdapterFactory, ResolvedConnection } from "@pragmatic-tech-ai/todl";
import { FetchRestHttpClient } from "./rest-http-client.js";
import type { IRestHttpClient } from "./rest-http-client.js";
import { RestAdapter } from "./rest-adapter.js";
import { RestConnectionConfig } from "./rest-connection-config.js";
import { GraphQlAdapter, GraphQlConnectionConfig } from "./graphql-adapter.js";

/** Opens REST-family adapters; Config.style="graphql" selects the GraphQL transport. */
export class RestAdapterFactory implements IDataSourceAdapterFactory
{
    public readonly Kind = DataSourceKind.Rest;

    private static readonly StyleKey = "style";
    private static readonly GraphQlStyle = "graphql";

    private readonly client: IRestHttpClient;

    public constructor(client?: IRestHttpClient)
    {
        this.client = client ?? new FetchRestHttpClient();
    }

    public async Open(connection: ResolvedConnection): Promise<IDataSourceAdapter>
    {
        if (connection.Config[RestAdapterFactory.StyleKey] === RestAdapterFactory.GraphQlStyle)
        {
            return new GraphQlAdapter(this.client, GraphQlConnectionConfig.From(connection.Config, connection.Secret));
        }
        return new RestAdapter(this.client, RestConnectionConfig.From(connection.Config, connection.Secret));
    }
}
