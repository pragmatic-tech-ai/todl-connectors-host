import type { DataSourceKind, ExternalRecord, IDataSourceAdapter, IDataSourceAdapterFactory, QueryRequest, ResolvedConnection, WriteBatch, WriteResult } from "@pragmatic-tech-ai/todl";
/** A trivial seeded in-memory SQL-kind adapter used as the reference adapter pack. Structural only:
 *  it implements the engine interfaces WITHOUT importing any engine value, so a worker can host it
 *  with the engine absent from the pack's resolution. */
export declare class ExampleSqlAdapter implements IDataSourceAdapter {
    private static readonly SqlKind;
    private static readonly WidgetsSource;
    private static readonly CrashSource;
    private static readonly HangSource;
    private static readonly Exit0Source;
    private static readonly EchoSource;
    private static readonly WedgeSource;
    private static readonly SigTerm;
    private static readonly Seed;
    static get Kind(): DataSourceKind;
    Query(request: QueryRequest): Promise<readonly ExternalRecord[]>;
    Apply(batch: WriteBatch): Promise<WriteResult>;
    Dispose(): Promise<void>;
}
/** Opens {@link ExampleSqlAdapter} instances for the SQL data-source kind, keyed by the plain
 *  `"sql"` string so the pack needs no runtime import of the engine's `DataSourceKind`. */
export declare class ExampleSqlAdapterFactory implements IDataSourceAdapterFactory {
    readonly Kind: DataSourceKind;
    Open(_connection: ResolvedConnection): Promise<IDataSourceAdapter>;
}
