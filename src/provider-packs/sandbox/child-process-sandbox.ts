import { fork } from "node:child_process";
import type { ChildProcess, ForkOptions } from "node:child_process";
import { fileURLToPath } from "node:url";
import { AdapterPackError, AdapterPackErrorKind } from "../adapter-pack-error.js";
import type { InstalledPack } from "../adapter-pack-installer.js";
import { PackSandboxBase, SandboxEvents } from "./pack-sandbox-base.js";
import type { IPackSandbox, IPackSandboxFactory, PackSandboxOptions } from "./pack-sandbox.js";
import { PackEntryEnvVar } from "./pack-worker-protocol.js";
import type { PackWorkerRequest } from "./pack-worker-protocol.js";

/** The pure, assertable result of planning a fork: where the child entry lives and how to fork it. */
export interface ForkPlan
{
    readonly entryPath: string;
    readonly forkOptions: ForkOptions;
}

/** Launches packs into a forked Node child over advanced-serialization (structured clone) IPC. */
export class ChildProcessSandboxFactory implements IPackSandboxFactory
{
    private static readonly TsEntry = "./adapter-pack-child-entry.ts";
    private static readonly JsEntry = "./adapter-pack-child-entry.js";
    private static readonly TsSuffix = ".ts";
    private static readonly TsxArgs: readonly string[] = ["--import", "tsx"];
    private static readonly Advanced = "advanced";
    private static readonly Win32 = "win32";
    private static readonly SigKill = "SIGKILL";
    private static readonly OldSpaceFlag = "--max-old-space-size=";
    private static readonly SemiSpaceFlag = "--max-semi-space-size=";
    private static readonly StackSizeFlag = "--stack-size=";
    private static readonly KbPerMb = 1024;
    private static readonly DefaultStartupTimeoutMs = 30000;
    private static readonly LaunchTimeoutError = "pack child did not report ready within the startup timeout";
    private static readonly EarlyExitError = "pack child exited before reporting ready";
    private static readonly ForkFailedPrefix = "pack child could not be forked: ";
    private static readonly MissingErrorText = "pack child reported a startup failure";

    public async Launch(installed: InstalledPack, options?: PackSandboxOptions): Promise<IPackSandbox>
    {
        const plan = ChildProcessSandboxFactory.BuildForkPlan(installed, options ?? {});
        let child: ChildProcess;
        try
        {
            child = fork(plan.entryPath, [], plan.forkOptions);
        }
        catch (err)
        {
            throw new AdapterPackError(AdapterPackErrorKind.SandboxLaunchFailed, `${ChildProcessSandboxFactory.ForkFailedPrefix}${(err as Error).message}`);
        }
        const startupTimeoutMs = options?.startupTimeoutMs ?? ChildProcessSandboxFactory.DefaultStartupTimeoutMs;
        return ChildProcessSandboxFactory.AwaitReady(child, options ?? {}, startupTimeoutMs);
    }

    /** Pure: composes the child entry path and fork options without spawning anything. */
    public static BuildForkPlan(installed: InstalledPack, options: PackSandboxOptions): ForkPlan
    {
        const selfIsTs = import.meta.url.endsWith(ChildProcessSandboxFactory.TsSuffix);
        const entryPath = fileURLToPath(new URL(selfIsTs ? ChildProcessSandboxFactory.TsEntry : ChildProcessSandboxFactory.JsEntry, import.meta.url));
        const execArgv =
        [
            ...(selfIsTs ? ChildProcessSandboxFactory.TsxArgs : []),
            ...ChildProcessSandboxFactory.ResourceArgv(options.resourceLimits)
        ];
        const forkOptions: ForkOptions =
        {
            execArgv,
            serialization: ChildProcessSandboxFactory.Advanced,
            stdio: ["ignore", "inherit", "inherit", "ipc"],
            env: { ...process.env, [PackEntryEnvVar]: installed.Entry },
            ...ChildProcessSandboxFactory.PrivilegeOptions(options.privilege)
        };
        return { entryPath, forkOptions };
    }

    private static ResourceArgv(limits: PackSandboxOptions["resourceLimits"]): string[]
    {
        const argv: string[] = [];
        if (limits?.maxOldGenerationSizeMb !== undefined)
        {
            argv.push(`${ChildProcessSandboxFactory.OldSpaceFlag}${limits.maxOldGenerationSizeMb}`);
        }
        if (limits?.maxYoungGenerationSizeMb !== undefined)
        {
            argv.push(`${ChildProcessSandboxFactory.SemiSpaceFlag}${limits.maxYoungGenerationSizeMb}`);
        }
        if (limits?.stackSizeMb !== undefined)
        {
            argv.push(`${ChildProcessSandboxFactory.StackSizeFlag}${limits.stackSizeMb * ChildProcessSandboxFactory.KbPerMb}`);
        }
        return argv;
    }

    private static PrivilegeOptions(privilege: PackSandboxOptions["privilege"]): { uid?: number; gid?: number }
    {
        const result: { uid?: number; gid?: number } = {};
        if (process.platform === ChildProcessSandboxFactory.Win32 || privilege === undefined)
        {
            return result;
        }
        if (privilege.uid !== undefined)
        {
            result.uid = privilege.uid;
        }
        if (privilege.gid !== undefined)
        {
            result.gid = privilege.gid;
        }
        return result;
    }

    private static AwaitReady(child: ChildProcess, options: PackSandboxOptions, startupTimeoutMs: number): Promise<IPackSandbox>
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
                    resolve(new ChildProcessSandbox(child, options));
                }
                else
                {
                    fail(msg?.error ?? ChildProcessSandboxFactory.MissingErrorText);
                }
            };
            const onError = (err: Error): void =>
            {
                fail(err.message);
            };
            const onExit = (code: number | null, signal: NodeJS.Signals | null): void =>
            {
                fail(`${ChildProcessSandboxFactory.EarlyExitError} (code ${code ?? "null"}, signal ${signal ?? "none"})`);
            };
            const timer = setTimeout(() =>
            {
                fail(ChildProcessSandboxFactory.LaunchTimeoutError);
            }, startupTimeoutMs);
            timer.unref();
            // Remove only our own launch listeners by reference, never removeAllListeners().
            const detach = (): void =>
            {
                clearTimeout(timer);
                child.off(SandboxEvents.Message, onMessage);
                child.off(SandboxEvents.Error, onError);
                child.off(SandboxEvents.Exit, onExit);
            };
            const fail = (reason: string): void =>
            {
                if (settled)
                {
                    return;
                }
                settled = true;
                detach();
                // Keep a no-op "error" listener until the child exits: a late spawn/kill "error"
                // would otherwise be unhandled and crash the host.
                const swallow = (): void =>
                {
                };
                child.on(SandboxEvents.Error, swallow);
                child.once(SandboxEvents.Exit, () =>
                {
                    child.off(SandboxEvents.Error, swallow);
                });
                child.kill(ChildProcessSandboxFactory.SigKill);
                reject(new AdapterPackError(AdapterPackErrorKind.SandboxLaunchFailed, reason));
            };
            child.on(SandboxEvents.Message, onMessage);
            child.on(SandboxEvents.Error, onError);
            child.on(SandboxEvents.Exit, onExit);
        });
    }
}

/** A launched pack hosted in a forked child process. Only the transport lives here; correlation,
 *  proxying and fail-closed crash/exit handling are shared via {@link PackSandboxBase}. */
export class ChildProcessSandbox extends PackSandboxBase
{
    private static readonly CrashReason = "pack child process crashed";
    private static readonly ExitReason = "pack child process exited";
    private static readonly ChannelClosedError = "pack child IPC channel is closed";
    private static readonly DisconnectGraceMs = 100;
    private static readonly DisconnectReason = "pack child IPC disconnected";
    private static readonly SendFailedPrefix = "pack child IPC send failed: ";
    private static readonly ForceKillMs = 2000;
    private static readonly SigTerm = "SIGTERM";
    private static readonly SigKill = "SIGKILL";

    public constructor(private readonly child: ChildProcess, options: PackSandboxOptions)
    {
        super(options);
        this.child.on(SandboxEvents.Message, this.OnChannelMessage);
        this.child.on(SandboxEvents.Error, (err: Error): void =>
        {
            this.OnChannelError(`${ChildProcessSandbox.CrashReason}: ${err.message}`);
        });
        this.child.on(SandboxEvents.Disconnect, (): void =>
        {
            // Not OnChannelExit: the process may linger, so HasExited must stay false until a real exit.
            // A dying child emits "disconnect" just before "exit"; a short grace lets the exit (with its
            // code/signal) name the failure first, since the first MarkDead wins.
            const grace = setTimeout((): void =>
            {
                this.OnChannelError(ChildProcessSandbox.DisconnectReason);
            }, ChildProcessSandbox.DisconnectGraceMs);
            grace.unref();
        });
        this.child.on(SandboxEvents.Exit, (code: number | null, signal: NodeJS.Signals | null): void =>
        {
            this.OnChannelExit(`${ChildProcessSandbox.ExitReason} (code ${code ?? "null"}, signal ${signal ?? "none"})`);
        });
    }

    protected Post(message: PackWorkerRequest): void
    {
        if (!this.child.connected)
        {
            throw new Error(ChildProcessSandbox.ChannelClosedError);
        }
        // A bare `false` return only signals backpressure (the message is still queued), so it is benign;
        // a real send failure arrives asynchronously via the callback and marks the channel dead.
        this.child.send(message, (err: Error | null): void =>
        {
            if (err !== null)
            {
                this.OnChannelError(`${ChildProcessSandbox.SendFailedPrefix}${err.message}`);
            }
        });
    }

    protected async Terminate(): Promise<void>
    {
        if (this.child.exitCode !== null || this.child.signalCode !== null)
        {
            return;
        }
        await new Promise<void>((resolve) =>
        {
            const force = setTimeout(() =>
            {
                this.child.kill(ChildProcessSandbox.SigKill);
            }, ChildProcessSandbox.ForceKillMs);
            force.unref();
            this.child.once(SandboxEvents.Exit, () =>
            {
                clearTimeout(force);
                resolve();
            });
            this.child.kill(ChildProcessSandbox.SigTerm);
        });
    }
}
