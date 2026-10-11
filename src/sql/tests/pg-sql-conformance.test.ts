import { describeDataSourceAdapter } from "../../testing/adapter-conformance.js";
import { PgLiveHarness, PgMemAdapterHarness } from "../../testing/pg-mem-adapter.js";

const LiveEnvVar = "CONNECTORS_LIVE_PG";

// OFFLINE: real SQL execution via pg-mem. Always runs.
describeDataSourceAdapter("PgSql (pg-mem)", () => PgMemAdapterHarness.Make());

// GATED LIVE: same contract against real Postgres. Registered only when CONNECTORS_LIVE_PG holds a
// connection string, so unset => zero live tests. Pools connect lazily; connection errors surface on first use.
const liveConn = process.env[LiveEnvVar];
if (liveConn !== undefined)
{
    describeDataSourceAdapter("PgSql (live)", () => PgLiveHarness.Make(liveConn));
}
