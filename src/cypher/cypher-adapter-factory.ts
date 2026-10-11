import { DataSourceKind } from "@pragmatic-tech-ai/todl";
import type { IDataSourceAdapter, IDataSourceAdapterFactory, ResolvedConnection } from "@pragmatic-tech-ai/todl";
import { CypherAdapter } from "./cypher-adapter.js";
import { CypherConnectionConfig, Neo4jCypherSession } from "./neo4j-cypher-session.js";

/** Opens Cypher adapters backed by a neo4j driver. */
export class CypherAdapterFactory implements IDataSourceAdapterFactory
{
    public readonly Kind = DataSourceKind.Cypher;

    public async Open(connection: ResolvedConnection): Promise<IDataSourceAdapter>
    {
        return new CypherAdapter(Neo4jCypherSession.Connect(CypherConnectionConfig.From(connection.Config, connection.Secret)));
    }
}
