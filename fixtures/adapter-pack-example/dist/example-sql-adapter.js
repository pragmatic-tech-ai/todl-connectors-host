/** A trivial seeded in-memory SQL-kind adapter used as the reference adapter pack. Structural only:
 *  it implements the engine interfaces WITHOUT importing any engine value, so a worker can host it
 *  with the engine absent from the pack's resolution. */
export class ExampleSqlAdapter {
    static SqlKind = "sql";
    static WidgetsSource = "widgets";
    static CrashSource = "__crash__";
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
        return ExampleSqlAdapter.Seed[request.Source] ?? [];
    }
    async Apply(batch) {
        return { Applied: batch.Operations.length, Conflicts: [] };
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
