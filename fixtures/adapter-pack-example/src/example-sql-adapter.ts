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
    private static readonly HangSource = "__hang__";
    private static readonly Exit0Source = "__exit0__";
    private static readonly EchoSource = "__echo__";
    private static readonly WedgeSource = "__wedge__";
    private static readonly SigTerm = "SIGTERM";
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
        if (request.Source === ExampleSqlAdapter.HangSource)
        {
            // Never resolves: drives the host-side call-timeout path.
            return new Promise<readonly ExternalRecord[]>(() =>
            {
            });
        }
        if (request.Source === ExampleSqlAdapter.Exit0Source)
        {
            // Respond normally, then let the worker self-exit cleanly on the next tick so the host
            // observes a code-0 exit while idle.
            setTimeout(() => process.exit(0), 0);
            return [];
        }
        if (request.Source === ExampleSqlAdapter.EchoSource)
        {
            // Returns the received request embedded in a record: lets a host prove how values cross the wire.
            return [{ echoed: request } as unknown as ExternalRecord];
        }
        if (request.Source === ExampleSqlAdapter.WedgeSource)
        {
            // Ignores graceful termination so a host's forced-kill fallback is exercised (POSIX).
            process.on(ExampleSqlAdapter.SigTerm, () =>
            {
            });
            return [];
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
