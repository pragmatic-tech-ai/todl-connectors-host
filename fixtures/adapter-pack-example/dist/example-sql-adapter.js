/** A trivial seeded in-memory SQL-kind adapter used as the reference adapter pack. Structural only:
 *  it implements the engine interfaces WITHOUT importing any engine value, so a worker can host it
 *  with the engine absent from the pack's resolution. */
export class ExampleSqlAdapter {
    static SqlKind = "sql";
    static WidgetsSource = "widgets";
    static CrashSource = "__crash__";
    static HangSource = "__hang__";
    static Exit0Source = "__exit0__";
    static EchoSource = "__echo__";
    static WedgeSource = "__wedge__";
    static SigTerm = "SIGTERM";
    static Seed = {
        [ExampleSqlAdapter.WidgetsSource]: [
            { id: 1, name: "alpha" },
            { id: 2, name: "beta" }
        ]
    };
    static get Kind() {
        return ExampleSqlAdapter.SqlKind;
    }
    async Query(request) {
        if (request.Source === ExampleSqlAdapter.CrashSource) {
            process.exit(1);
        }
        if (request.Source === ExampleSqlAdapter.HangSource) {
            // Never resolves: drives the host-side call-timeout path.
            return new Promise(() => {
            });
        }
        if (request.Source === ExampleSqlAdapter.Exit0Source) {
            // Respond normally, then let the worker self-exit cleanly on the next tick so the host
            // observes a code-0 exit while idle.
            setTimeout(() => process.exit(0), 0);
            return [];
        }
        if (request.Source === ExampleSqlAdapter.EchoSource) {
            // Returns the received request embedded in a record: lets a host prove how values cross the wire.
            return [{ echoed: request }];
        }
        if (request.Source === ExampleSqlAdapter.WedgeSource) {
            // Ignores graceful termination so a host's forced-kill fallback is exercised (POSIX).
            process.on(ExampleSqlAdapter.SigTerm, () => {
            });
            return [];
        }
        return ExampleSqlAdapter.Seed[request.Source] ?? [];
    }
    async Apply(batch) {
        return { Applied: batch.Operations.length, Failures: [] };
    }
    async Dispose() {
    }
}
/** Opens {@link ExampleSqlAdapter} instances for the SQL data-source kind, keyed by the plain
 *  `"sql"` string so the pack needs no runtime import of the engine's `DataSourceKind`. */
export class ExampleSqlAdapterFactory {
    Kind = ExampleSqlAdapter.Kind;
    async Open(_connection) {
        return new ExampleSqlAdapter();
    }
}
