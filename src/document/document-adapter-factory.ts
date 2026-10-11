import { DataSourceKind } from "@pragmatic-tech-ai/todl";
import type { IDataSourceAdapter, IDataSourceAdapterFactory, ResolvedConnection } from "@pragmatic-tech-ai/todl";
import { DocumentAdapter } from "./document-adapter.js";
import { DocumentConnectionConfig, MongoDocumentSession } from "./mongo-document-session.js";

/** Opens document adapters backed by a mongodb client. */
export class DocumentAdapterFactory implements IDataSourceAdapterFactory
{
    public readonly Kind = DataSourceKind.Document;

    public async Open(connection: ResolvedConnection): Promise<IDataSourceAdapter>
    {
        return new DocumentAdapter(MongoDocumentSession.Connect(DocumentConnectionConfig.From(connection.Config, connection.Secret), connection.Secret));
    }
}
