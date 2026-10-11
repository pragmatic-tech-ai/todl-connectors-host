import { after } from "node:test";
import { describeDataSourceAdapter } from "../../testing/adapter-conformance.js";
import { PgLiveHarness, PgMemAdapterHarness } from "../../testing/pg-mem-adapter.js";

const LiveEnvVar = "CONNECTORS_LIVE_PG";

// OFFLINE: real SQL execution via pg-mem. Always runs.
describeDataSourceAdapter("PgSql (pg-mem)", () => PgMemAdapterHarness.Make());

// GATED LIVE: same contract against real Postgres. Registered only when CONNECTORS_LIVE_PG is set AND
// non-empty, so unset/empty => zero live tests. Pools connect lazily; connection errors surface on first use.
if ((process.env[LiveEnvVar] ?? "") !== "")
{
    describeDataSourceAdapter("PgSql (live)", () => PgLiveHarness.Make(process.env[LiveEnvVar]!));
    after(async () =>
    {
        await PgLiveHarness.DisposeAll();
    });
}
