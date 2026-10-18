import { after } from "node:test";
import { describeDataSourceAdapter } from "../../testing/adapter-conformance.js";
import { PgLiveHarness, PgMemAdapterHarness } from "../../testing/pg-mem-adapter.js";

const LiveEnvVar = "CONNECTORS_LIVE_PG";

// OFFLINE: real SQL execution via pg-mem. Always runs. pg-mem cannot honor the optimistic version guard
// (its ON CONFLICT DO UPDATE ... WHERE command tag mis-reports the affected-row count), so the version-
// guard cases are opted out here; the gated live conformance below exercises them against real Postgres.
describeDataSourceAdapter("PgSql (pg-mem)", () => PgMemAdapterHarness.Make(), { HonorsVersionGuard: false });

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
