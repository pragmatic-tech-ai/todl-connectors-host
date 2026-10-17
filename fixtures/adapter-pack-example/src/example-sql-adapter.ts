import type {
    DataSourceKind,
    ExternalRecord,
    IDataSourceAdapter,
    IDataSourceAdapterFactory,
    QueryRequest,
    ResolvedConnection,
    WriteBatch,
    WriteResult
} from "@pragmatic-tech-ai/todl";

/** A trivial seeded in-memory SQL-kind adapter used as the reference adapter pack. Structural only:
 *  it implements the engine interfaces WITHOUT importing any engine value, so a worker can host it
 *  with the engine absent from the pack's resolution. */
export class ExampleSqlAdapter implements IDataSourceAdapter
{
    private static readonly SqlKind = "sql";
    private static readonly WidgetsSource = "widgets";
    private static readonly CrashSource = "__crash__";
    private static readonly Seed: Record<string, readonly ExternalRecord[]> =
    {
        [ExampleSqlAdapter.WidgetsSource]:
        [
            { id: 1, name: "alpha" },
            { id: 2, name: "beta" }
        ]
    };

    public static get Kind(): DataSourceKind
    {
        return ExampleSqlAdapter.SqlKind as unknown as DataSourceKind;
    }

    public async Query(request: QueryRequest): Promise<readonly ExternalRecord[]>
    {
        if (request.Source === ExampleSqlAdapter.CrashSource)
        {
            process.exit(1);
        }
        return ExampleSqlAdapter.Seed[request.Source] ?? [];
    }

    public async Apply(batch: WriteBatch): Promise<WriteResult>
    {
        return { Applied: batch.Operations.length, Conflicts: [] };
    }

    public async Dispose(): Promise<void>
    {
    }
}

/** Opens {@link ExampleSqlAdapter} instances for the SQL data-source kind, keyed by the plain
 *  `"sql"` string so the pack needs no runtime import of the engine's `DataSourceKind`. */
export class ExampleSqlAdapterFactory implements IDataSourceAdapterFactory
{
    public readonly Kind = ExampleSqlAdapter.Kind;

    public async Open(_connection: ResolvedConnection): Promise<IDataSourceAdapter>
    {
        return new ExampleSqlAdapter();
    }
}
