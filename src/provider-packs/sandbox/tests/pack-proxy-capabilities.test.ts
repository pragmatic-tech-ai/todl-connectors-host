import { test } from "node:test";
import assert from "node:assert/strict";
import { DataSourceKind } from "@pragmatic-tech-ai/todl";
import type { IDataSourceAdapter } from "@pragmatic-tech-ai/todl";
import { PackSandboxBase } from "../pack-sandbox-base.js";
import type { PackWorkerRequest, PackWorkerResponse } from "../pack-worker-protocol.js";
import type { PackSandboxOptions } from "../pack-sandbox.js";

/** A transport-free sandbox that answers every Open call with a canned open-response, so the proxy's
 *  capability forwarding can be asserted without launching a worker or child. */
class CannedSandbox extends PackSandboxBase
{
    public constructor(private readonly reply: Partial<PackWorkerResponse>)
    {
        super({} as PackSandboxOptions);
    }

    public OpenProxy(): Promise<IDataSourceAdapter>
    {
        return this.Factory(DataSourceKind.Sql).Open({ Kind: DataSourceKind.Sql, Config: {} });
    }

    protected Post(message: PackWorkerRequest): void
    {
        // Resolve the correlated pending call synchronously with the canned open-response.
        this.OnChannelMessage({ id: message.id, ok: true, handle: 1, ...this.reply });
    }

    protected async Terminate(): Promise<void>
    {
    }
}

test("PackProxyFactory forwards the pack adapter's advertised capabilities to the proxy", async () =>
{
    const adapter = await new CannedSandbox({ canTransact: true, canVersion: false }).OpenProxy();
    assert.equal(adapter.CanTransact, true);
    assert.equal(adapter.CanVersion, false);
});

test("a both-true open response is forwarded verbatim", async () =>
{
    const adapter = await new CannedSandbox({ canTransact: true, canVersion: true }).OpenProxy();
    assert.equal(adapter.CanTransact, true);
    assert.equal(adapter.CanVersion, true);
});

test("an open response omitting the capability fields defaults the proxy to the weakest guarantee", async () =>
{
    const adapter = await new CannedSandbox({}).OpenProxy();
    assert.equal(adapter.CanTransact, false);
    assert.equal(adapter.CanVersion, false);
});
