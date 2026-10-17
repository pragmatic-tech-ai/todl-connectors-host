import { DataSourceKind } from "@pragmatic-tech-ai/todl";
import type {
    ExternalRecord,
    IDataSourceAdapter,
    IDataSourceAdapterFactory,
    QueryRequest,
    ResolvedConnection,
    WriteBatch,
    WriteResult
} from "@pragmatic-tech-ai/todl";

/** A trivial in-memory SQL-kind adapter used as the reference adapter pack. */
export class ExampleSqlAdapter implements IDataSourceAdapter
{
    public async Query(_request: QueryRequest): Promise<readonly ExternalRecord[]>
    {
        return [];
    }

    public async Apply(batch: WriteBatch): Promise<WriteResult>
    {
        return { Applied: batch.Operations.length, Conflicts: [] };
    }

    public async Dispose(): Promise<void>
    {
    }
}

/** Opens {@link ExampleSqlAdapter} instances for the SQL data-source kind. */
export class ExampleSqlAdapterFactory implements IDataSourceAdapterFactory
{
    public readonly Kind = DataSourceKind.Sql;

    public async Open(_connection: ResolvedConnection): Promise<IDataSourceAdapter>
    {
        return new ExampleSqlAdapter();
    }
}
