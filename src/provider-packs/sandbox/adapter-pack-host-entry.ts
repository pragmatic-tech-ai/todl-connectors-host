import { parentPort, workerData, type MessagePort } from "node:worker_threads";
import { pathToFileURL } from "node:url";
import { PackWorkerOp } from "./pack-worker-protocol.js";
import type { PackWorkerFailed, PackWorkerReady, PackWorkerRequest, PackWorkerResponse } from "./pack-worker-protocol.js";
import type { IAdapterPack } from "@pragmatic-tech-ai/todl/adapter-pack";
import type { IDataSourceAdapter, IDataSourceAdapterFactory } from "@pragmatic-tech-ai/todl";

/** The `workerData` the launcher passes: the absolute path to the pack entry to host. */
interface PackHostData
{
    readonly entry?: unknown;
}

/** Runs inside the worker thread: imports a runtime-self-contained pack, duck-types its default
 *  export as an {@link IAdapterPack}, hosts its real adapters, and round-trips host calls over the
 *  parent port. Imports engine TYPES only (erased), so the pack need not resolve the engine. */
export class AdapterPackHost
{
    private static readonly ReadyMessage: PackWorkerReady = { ready: true };
    private static readonly FactoriesMember = "Factories";
    private static readonly MissingEntryError = "worker started without a pack entry path";
    private static readonly NotAPackError = "pack entry default export is not an IAdapterPack";
    private static readonly UnknownKindError = "pack provides no factory for kind";
    private static readonly UnknownHandleError = "no open adapter for handle";
    private static readonly UnknownOpError = "unknown worker op";

    private readonly adapters = new Map<number, IDataSourceAdapter>();
    private readonly byKind = new Map<string, IDataSourceAdapterFactory>();
    private nextHandle = 1;

    private constructor(private readonly port: MessagePort, factories: readonly IDataSourceAdapterFactory[])
    {
        for (const factory of factories)
        {
            this.byKind.set(factory.Kind, factory);
        }
    }

    /** Imports and validates the pack; on success wires request handling and posts `{ready:true}`,
     *  otherwise posts `{ready:false,error}` and returns without handling requests. */
    public static async Boot(port: MessagePort | null, data: PackHostData): Promise<void>
    {
        if (port === null)
        {
            return;
        }
        const entry = data.entry;
        if (typeof entry !== "string" || entry.length === 0)
        {
            port.postMessage(AdapterPackHost.Failed(AdapterPackHost.MissingEntryError));
            return;
        }
        let pack: IAdapterPack;
        try
        {
            const mod = await import(pathToFileURL(entry).href);
            const candidate = mod.default as Partial<IAdapterPack> | undefined | null;
            if (candidate === undefined || candidate === null || typeof candidate[AdapterPackHost.FactoriesMember] !== "function")
            {
                port.postMessage(AdapterPackHost.Failed(AdapterPackHost.NotAPackError));
                return;
            }
            pack = candidate as IAdapterPack;
        }
        catch (err)
        {
            port.postMessage(AdapterPackHost.Failed(AdapterPackHost.Describe(err)));
            return;
        }
        const host = new AdapterPackHost(port, pack.Factories());
        port.on("message", (req: PackWorkerRequest) =>
        {
            void host.Handle(req);
        });
        port.postMessage(AdapterPackHost.ReadyMessage);
    }

    private async Handle(req: PackWorkerRequest): Promise<void>
    {
        try
        {
            this.port.postMessage(await this.Dispatch(req));
        }
        catch (err)
        {
            this.port.postMessage({ id: req.id, ok: false, error: AdapterPackHost.Describe(err) });
        }
    }

    private async Dispatch(req: PackWorkerRequest): Promise<PackWorkerResponse>
    {
        switch (req.op)
        {
            case PackWorkerOp.Open:
                return this.Open(req);
            case PackWorkerOp.Query:
                return { id: req.id, ok: true, records: await this.Adapter(req.handle).Query(req.request!) };
            case PackWorkerOp.Apply:
                return { id: req.id, ok: true, result: await this.Adapter(req.handle).Apply(req.batch!) };
            case PackWorkerOp.Dispose:
                return this.DisposeAdapter(req);
            default:
                throw new Error(AdapterPackHost.UnknownOpError);
        }
    }

    private async Open(req: PackWorkerRequest): Promise<PackWorkerResponse>
    {
        const factory = this.byKind.get(req.kind!);
        if (factory === undefined)
        {
            return { id: req.id, ok: false, error: `${AdapterPackHost.UnknownKindError}: ${req.kind}` };
        }
        const adapter = await factory.Open(req.connection!);
        const handle = this.nextHandle++;
        this.adapters.set(handle, adapter);
        return { id: req.id, ok: true, handle };
    }

    private async DisposeAdapter(req: PackWorkerRequest): Promise<PackWorkerResponse>
    {
        const adapter = req.handle === undefined ? undefined : this.adapters.get(req.handle);
        if (adapter !== undefined)
        {
            await adapter.Dispose();
            this.adapters.delete(req.handle!);
        }
        return { id: req.id, ok: true };
    }

    private Adapter(handle: number | undefined): IDataSourceAdapter
    {
        const adapter = handle === undefined ? undefined : this.adapters.get(handle);
        if (adapter === undefined)
        {
            throw new Error(`${AdapterPackHost.UnknownHandleError}: ${handle}`);
        }
        return adapter;
    }

    private static Failed(error: string): PackWorkerFailed
    {
        return { ready: false, error };
    }

    private static Describe(err: unknown): string
    {
        return err instanceof Error ? err.message : String(err);
    }
}

void AdapterPackHost.Boot(parentPort, (workerData ?? {}) as PackHostData);
