import { Worker } from "node:worker_threads";
import type { DataSourceKind, ExternalRecord, IDataSourceAdapter, IDataSourceAdapterFactory, QueryRequest, ResolvedConnection, WriteBatch, WriteResult } from "@pragmatic-tech-ai/todl";
import { AdapterPackError, AdapterPackErrorKind } from "../adapter-pack-error.js";
import type { InstalledPack } from "../adapter-pack-installer.js";
import type { IPackSandbox, IPackSandboxFactory, PackSandboxOptions } from "./pack-sandbox.js";
import { PackWorkerOp } from "./pack-worker-protocol.js";
import type { PackWorkerRequest, PackWorkerResponse } from "./pack-worker-protocol.js";

/** The request operands a proxy supplies for one {@link WorkerThreadSandbox.Call}. */
type PackCallFields = Omit<PackWorkerRequest, "id" | "op">;

/** A host-side pending call awaiting its correlated worker response. */
interface PendingCall
{
    readonly resolve: (response: PackWorkerResponse) => void;
    readonly reject: (error: AdapterPackError) => void;
    timer?: NodeJS.Timeout;
}

/** Launches packs into a `worker_threads` Worker: the entry resolves relative to this module, with
 *  `--import tsx` only when the resolved entry is a `.ts` file (a dist `.js` entry needs none). */
export class WorkerThreadSandboxFactory implements IPackSandboxFactory
{
    private static readonly TsEntry = "./adapter-pack-host-entry.ts";
    private static readonly JsEntry = "./adapter-pack-host-entry.js";
    private static readonly TsSuffix = ".ts";
    private static readonly TsxArgs: readonly string[] = ["--import", "tsx"];
    private static readonly DefaultStartupTimeoutMs = 30000;
    private static readonly LaunchTimeoutError = "pack worker did not report ready within the startup timeout";
    private static readonly EarlyExitError = "pack worker exited before reporting ready";
    private static readonly MissingErrorText = "pack worker reported a startup failure";

    public async Launch(installed: InstalledPack, options?: PackSandboxOptions): Promise<IPackSandbox>
    {
        const selfIsTs = import.meta.url.endsWith(WorkerThreadSandboxFactory.TsSuffix);
        const entryUrl = new URL(selfIsTs ? WorkerThreadSandboxFactory.TsEntry : WorkerThreadSandboxFactory.JsEntry, import.meta.url);
        const execArgv = entryUrl.pathname.endsWith(WorkerThreadSandboxFactory.TsSuffix) ? [...WorkerThreadSandboxFactory.TsxArgs] : [];
        const worker = new Worker(entryUrl,
        {
            workerData: { entry: installed.Entry },
            execArgv,
            resourceLimits: options?.resourceLimits
        });
        const startupTimeoutMs = options?.startupTimeoutMs ?? WorkerThreadSandboxFactory.DefaultStartupTimeoutMs;
        return WorkerThreadSandboxFactory.AwaitReady(worker, options ?? {}, startupTimeoutMs);
    }

    private static AwaitReady(worker: Worker, options: PackSandboxOptions, startupTimeoutMs: number): Promise<IPackSandbox>
    {
        return new Promise<IPackSandbox>((resolve, reject) =>
        {
            let settled = false;
            const onMessage = (msg: { ready?: boolean; error?: string }): void =>
            {
                if (settled)
                {
                    return;
                }
                if (msg.ready === true)
                {
                    settled = true;
                    detach();
                    resolve(new WorkerThreadSandbox(worker, options));
                }
                else
                {
                    fail(msg.error ?? WorkerThreadSandboxFactory.MissingErrorText);
                }
            };
            const onError = (err: Error): void =>
            {
                fail(err.message);
            };
            const onExit = (code: number): void =>
            {
                fail(`${WorkerThreadSandboxFactory.EarlyExitError} (code ${code})`);
            };
            const timer = setTimeout(() =>
            {
                fail(WorkerThreadSandboxFactory.LaunchTimeoutError);
            }, startupTimeoutMs);
            timer.unref();
            // Remove only our own launch listeners by reference; Worker.removeAllListeners() would
            // also strip Node's internal port-forwarding listeners and silence the live sandbox.
            const detach = (): void =>
            {
                clearTimeout(timer);
                worker.off("message", onMessage);
                worker.off("error", onError);
                worker.off("exit", onExit);
            };
            const fail = (reason: string): void =>
            {
                if (settled)
                {
                    return;
                }
                settled = true;
                detach();
                void worker.terminate().finally(() =>
                {
                    reject(new AdapterPackError(AdapterPackErrorKind.SandboxLaunchFailed, reason));
                });
            };
            worker.on("message", onMessage);
            worker.on("error", onError);
            worker.on("exit", onExit);
        });
    }
}

/** A launched pack hosted in a worker thread. Round-trips adapter calls over the worker port with
 *  monotonic request correlation and fail-closed crash/exit handling. */
export class WorkerThreadSandbox implements IPackSandbox
{
    private static readonly DeadError = "pack sandbox is no longer running";
    private static readonly CrashReason = "pack worker crashed";
    private static readonly DisposedReason = "pack sandbox was disposed";
    private static readonly CallTimeoutReason = "pack worker call timed out";
    private static readonly CleanExitCode = 0;

    private readonly pending = new Map<number, PendingCall>();
    private nextId = 1;
    private dead = false;
    private disposed = false;

    public constructor(private readonly worker: Worker, private readonly options: PackSandboxOptions)
    {
        this.worker.on("message", this.OnMessage);
        this.worker.on("error", this.OnError);
        this.worker.on("exit", this.OnExit);
    }

    public Factory(kind: DataSourceKind): IDataSourceAdapterFactory
    {
        return new WorkerProxyFactory(this, kind);
    }

    public async Dispose(): Promise<void>
    {
        if (this.disposed)
        {
            return;
        }
        this.disposed = true;
        this.MarkDead(WorkerThreadSandbox.DisposedReason);
        await this.worker.terminate();
    }

    /** Correlates one request/response pair over the port; rejects immediately if the sandbox is
     *  already dead so a caller never hangs on a terminated worker. */
    public Call(op: PackWorkerOp, fields: PackCallFields): Promise<PackWorkerResponse>
    {
        if (this.dead)
        {
            return Promise.reject(new AdapterPackError(AdapterPackErrorKind.SandboxCrashed, WorkerThreadSandbox.DeadError));
        }
        const id = this.nextId++;
        return new Promise<PackWorkerResponse>((resolve, reject) =>
        {
            const entry: PendingCall = { resolve, reject };
            const timeoutMs = this.options.callTimeoutMs;
            if (timeoutMs !== undefined && timeoutMs > 0)
            {
                entry.timer = setTimeout(() =>
                {
                    this.pending.delete(id);
                    reject(new AdapterPackError(AdapterPackErrorKind.SandboxCrashed, WorkerThreadSandbox.CallTimeoutReason));
                }, timeoutMs);
                entry.timer.unref();
            }
            this.pending.set(id, entry);
            this.worker.postMessage({ id, op, ...fields });
        });
    }

    /** Throws the proxy-side typed error carried by an `ok:false` response. */
    public static EnsureOk(response: PackWorkerResponse): void
    {
        if (!response.ok)
        {
            throw new AdapterPackError(AdapterPackErrorKind.SandboxCrashed, response.error ?? WorkerThreadSandbox.CrashReason);
        }
    }

    private readonly OnMessage = (response: PackWorkerResponse): void =>
    {
        const entry = this.pending.get(response.id);
        if (entry === undefined)
        {
            return;
        }
        this.pending.delete(response.id);
        if (entry.timer !== undefined)
        {
            clearTimeout(entry.timer);
        }
        entry.resolve(response);
    };

    private readonly OnError = (err: Error): void =>
    {
        this.MarkDead(err.message);
    };

    private readonly OnExit = (code: number): void =>
    {
        if (this.disposed)
        {
            return;
        }
        if (code !== WorkerThreadSandbox.CleanExitCode || this.pending.size > 0)
        {
            this.MarkDead(`${WorkerThreadSandbox.CrashReason} (exit code ${code})`);
        }
    };

    private MarkDead(reason: string): void
    {
        if (this.dead)
        {
            return;
        }
        this.dead = true;
        const error = new AdapterPackError(AdapterPackErrorKind.SandboxCrashed, reason);
        for (const entry of this.pending.values())
        {
            if (entry.timer !== undefined)
            {
                clearTimeout(entry.timer);
            }
            entry.reject(error);
        }
        this.pending.clear();
    }
}

/** Host-side proxy for a pack factory of one kind; `Open` confirms the kind with the worker. */
class WorkerProxyFactory implements IDataSourceAdapterFactory
{
    public readonly Kind: DataSourceKind;

    public constructor(private readonly sandbox: WorkerThreadSandbox, kind: DataSourceKind)
    {
        this.Kind = kind;
    }

    public async Open(connection: ResolvedConnection): Promise<IDataSourceAdapter>
    {
        const response = await this.sandbox.Call(PackWorkerOp.Open, { kind: this.Kind, connection });
        WorkerThreadSandbox.EnsureOk(response);
        return new WorkerProxyAdapter(this.sandbox, response.handle!);
    }
}

/** Host-side proxy for one open pack adapter, keyed by the worker-assigned handle. */
class WorkerProxyAdapter implements IDataSourceAdapter
{
    public constructor(private readonly sandbox: WorkerThreadSandbox, private readonly handle: number)
    {
    }

    public async Query(request: QueryRequest): Promise<readonly ExternalRecord[]>
    {
        const response = await this.sandbox.Call(PackWorkerOp.Query, { handle: this.handle, request });
        WorkerThreadSandbox.EnsureOk(response);
        return response.records ?? [];
    }

    public async Apply(batch: WriteBatch): Promise<WriteResult>
    {
        const response = await this.sandbox.Call(PackWorkerOp.Apply, { handle: this.handle, batch });
        WorkerThreadSandbox.EnsureOk(response);
        return response.result!;
    }

    public async Dispose(): Promise<void>
    {
        const response = await this.sandbox.Call(PackWorkerOp.Dispose, { handle: this.handle });
        WorkerThreadSandbox.EnsureOk(response);
    }
}
