import { Worker } from "node:worker_threads";
import { AdapterPackError, AdapterPackErrorKind } from "../adapter-pack-error.js";
import type { InstalledPack } from "../adapter-pack-installer.js";
import { PackSandboxBase, SandboxEvents } from "./pack-sandbox-base.js";
import type { IPackSandbox, IPackSandboxFactory, PackSandboxOptions } from "./pack-sandbox.js";
import type { PackWorkerRequest } from "./pack-worker-protocol.js";

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
    private static readonly SpawnFailedPrefix = "pack worker could not be started: ";
    private static readonly MissingErrorText = "pack worker reported a startup failure";

    public async Launch(installed: InstalledPack, options?: PackSandboxOptions): Promise<IPackSandbox>
    {
        const selfIsTs = import.meta.url.endsWith(WorkerThreadSandboxFactory.TsSuffix);
        const entryUrl = new URL(selfIsTs ? WorkerThreadSandboxFactory.TsEntry : WorkerThreadSandboxFactory.JsEntry, import.meta.url);
        const execArgv = entryUrl.pathname.endsWith(WorkerThreadSandboxFactory.TsSuffix) ? [...WorkerThreadSandboxFactory.TsxArgs] : [];
        let worker: Worker;
        try
        {
            worker = new Worker(entryUrl,
            {
                workerData: { entry: installed.Entry },
                execArgv,
                resourceLimits: options?.resourceLimits
            });
        }
        catch (err)
        {
            throw new AdapterPackError(AdapterPackErrorKind.SandboxLaunchFailed, `${WorkerThreadSandboxFactory.SpawnFailedPrefix}${(err as Error).message}`);
        }
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
                if (msg !== null && typeof msg === "object" && msg.ready === true)
                {
                    settled = true;
                    detach();
                    resolve(new WorkerThreadSandbox(worker, options));
                }
                else
                {
                    fail(msg?.error ?? WorkerThreadSandboxFactory.MissingErrorText);
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
                worker.off(SandboxEvents.Message, onMessage);
                worker.off(SandboxEvents.Error, onError);
                worker.off(SandboxEvents.Exit, onExit);
            };
            const fail = (reason: string): void =>
            {
                if (settled)
                {
                    return;
                }
                settled = true;
                detach();
                // Keep a no-op "error" listener until the worker exits: a late "error" emitted while
                // terminate() is in flight would otherwise be unhandled and crash the host.
                const swallow = (): void =>
                {
                };
                worker.on(SandboxEvents.Error, swallow);
                worker.once(SandboxEvents.Exit, () =>
                {
                    worker.off(SandboxEvents.Error, swallow);
                });
                const error = new AdapterPackError(AdapterPackErrorKind.SandboxLaunchFailed, reason);
                worker.terminate().then(() => reject(error), () => reject(error));
            };
            worker.on(SandboxEvents.Message, onMessage);
            worker.on(SandboxEvents.Error, onError);
            worker.on(SandboxEvents.Exit, onExit);
        });
    }
}

/** A launched pack hosted in a worker thread. Only the transport lives here; correlation, proxying
 *  and fail-closed crash/exit handling are shared via {@link PackSandboxBase}. */
export class WorkerThreadSandbox extends PackSandboxBase
{
    private static readonly CrashReason = "pack worker crashed";
    private static readonly CleanExitReason = "pack worker exited";

    public constructor(private readonly worker: Worker, options: PackSandboxOptions)
    {
        super(options);
        this.worker.on(SandboxEvents.Message, this.OnChannelMessage);
        this.worker.on(SandboxEvents.Error, (err: Error): void =>
        {
            this.OnChannelError(`${WorkerThreadSandbox.CrashReason}: ${err.message}`);
        });
        this.worker.on(SandboxEvents.Exit, (code: number): void =>
        {
            this.OnChannelExit(`${WorkerThreadSandbox.CleanExitReason} (exit code ${code})`);
        });
    }

    protected Post(message: PackWorkerRequest): void
    {
        this.worker.postMessage(message);
    }

    protected async Terminate(): Promise<void>
    {
        await this.worker.terminate();
    }
}
