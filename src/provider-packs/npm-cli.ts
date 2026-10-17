import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { AdapterPackError, AdapterPackErrorKind } from "./adapter-pack-error.js";

/** Runs npm against the package.json already written in a directory. */
export interface INpmCli
{
    /** Installs the tree with --ignore-scripts: no lifecycle script runs here. */
    Install(cwd: string): Promise<void>;

    /** Runs the install lifecycle scripts of the already-installed tree (npm rebuild); used only after signatures verify. */
    RunInstallScripts(cwd: string): Promise<void>;

    /** Resolves when registry signatures/provenance verify; rejects AdapterPackError(SignatureInvalid) otherwise. */
    AuditSignatures(cwd: string): Promise<void>;
}

/** Production {@link INpmCli}: spawns the real `npm`. */
export class NpmCli implements INpmCli
{
    private static readonly WindowsCommand = "npm.cmd";
    private static readonly PosixCommand = "npm";
    private static readonly WindowsPlatform = "win32";
    private static readonly NpmCliScriptSegments: readonly string[] = ["node_modules", "npm", "bin", "npm-cli.js"];
    private static readonly NpmExecPathVar = "npm_execpath";
    private static readonly NpmCliScriptName = "npm-cli.js";
    private static readonly DefaultTimeoutMs = 120000;
    private static readonly Stdio: ["ignore", "pipe", "pipe"] = ["ignore", "pipe", "pipe"];
    private static readonly KillSignal = "SIGKILL";
    public static readonly InstallArgs: readonly string[] = ["install", "--ignore-scripts", "--no-audit", "--no-fund"];
    public static readonly RebuildArgs: readonly string[] = ["rebuild"];
    private static readonly AuditArgs: readonly string[] = ["audit", "signatures"];
    private static readonly InstallLabel = "npm install";
    private static readonly RebuildLabel = "npm rebuild";
    private static readonly AuditLabel = "npm audit signatures";
    private static readonly OutputTailChars = 2000;
    private static readonly ErrorEvent = "error";
    private static readonly CloseEvent = "close";
    private static readonly DataEvent = "data";
    private static readonly LaunchSeparator = " ";
    private static readonly OutputJoin = "\n";
    /** Registry/network/tooling failures from `npm audit signatures` that say nothing about the pack's integrity. */
    private static readonly InfraPattern = /ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENETUNREACH|EPROTO|socket hang up|network|\bE5\d\d\b|unknown command|not supported/i;
    /** Output that affirmatively reports a bad/missing signature or attestation. */
    private static readonly TamperPattern = /invalid (registry )?signature|missing (registry )?signature|invalid attestation|have invalid|have missing/i;

    /**
     * Resolves how to start npm without a shell. Node refuses to spawn a .cmd directly on Windows (EINVAL),
     * so there we run npm's own npm-cli.js under the current node: first the script named by `npm_execpath`
     * (set when we run under npm/Volta shims, whose node is not beside npm), then the one beside the current
     * node; npm.cmd is the last fallback.
     */
    public static ResolveLaunch(): { Command: string; Prefix: readonly string[] }
    {
        if (process.platform !== NpmCli.WindowsPlatform)
        {
            return { Command: NpmCli.PosixCommand, Prefix: [] };
        }
        const execPath = process.env[NpmCli.NpmExecPathVar];
        if (execPath !== undefined && execPath.endsWith(NpmCli.NpmCliScriptName) && existsSync(execPath))
        {
            return { Command: process.execPath, Prefix: [execPath] };
        }
        const script = join(dirname(process.execPath), ...NpmCli.NpmCliScriptSegments);
        if (existsSync(script))
        {
            return { Command: process.execPath, Prefix: [script] };
        }
        return { Command: NpmCli.WindowsCommand, Prefix: [] };
    }

    private readonly timeoutMs: number;

    public constructor(options: { timeoutMs?: number } = {})
    {
        this.timeoutMs = options.timeoutMs ?? NpmCli.DefaultTimeoutMs;
    }

    public Install(cwd: string): Promise<void>
    {
        return this.RunNpm(cwd, NpmCli.InstallArgs, NpmCli.InstallLabel, AdapterPackErrorKind.InstallFailed, () => AdapterPackErrorKind.InstallFailed);
    }

    public RunInstallScripts(cwd: string): Promise<void>
    {
        return this.RunNpm(cwd, NpmCli.RebuildArgs, NpmCli.RebuildLabel, AdapterPackErrorKind.InstallFailed, () => AdapterPackErrorKind.InstallFailed);
    }

    public AuditSignatures(cwd: string): Promise<void>
    {
        return this.RunNpm(cwd, NpmCli.AuditArgs, NpmCli.AuditLabel, AdapterPackErrorKind.SignatureCheckUnavailable, NpmCli.ClassifyAuditFailure);
    }

    /** Pure: a non-zero audit exit is tampering only when the output says so; registry/tooling trouble is "unavailable" (still fail-closed). */
    public static ClassifyAuditFailure(output: string): AdapterPackErrorKind
    {
        if (NpmCli.TamperPattern.test(output))
        {
            return AdapterPackErrorKind.SignatureInvalid;
        }
        if (NpmCli.InfraPattern.test(output))
        {
            return AdapterPackErrorKind.SignatureCheckUnavailable;
        }
        return AdapterPackErrorKind.SignatureInvalid;
    }

    private static Tail(text: string): string
    {
        return text.slice(-NpmCli.OutputTailChars);
    }

    private RunNpm(
        cwd: string,
        args: readonly string[],
        label: string,
        infraFailure: AdapterPackErrorKind,
        classifyExit: (output: string) => AdapterPackErrorKind): Promise<void>
    {
        return new Promise<void>((resolve, reject) =>
        {
            let stdout = "";
            let stderr = "";
            const launch = NpmCli.ResolveLaunch();
            const launched = [launch.Command, ...launch.Prefix].join(NpmCli.LaunchSeparator);
            // Install runs with --ignore-scripts (see InstallArgs); lifecycle scripts run only via RunInstallScripts,
            // and only for packs the operator put on the script allowlist, after their signature verifies. env is the
            // host env: trusted (allowlisted) packs' scripts run with it by the operator's explicit choice.
            const child = spawn(launch.Command, [...launch.Prefix, ...args], { cwd, env: process.env, stdio: NpmCli.Stdio });
            const timer = setTimeout(() =>
            {
                child.kill(NpmCli.KillSignal);
                reject(new AdapterPackError(infraFailure, `${label} (${launched}) timed out after ${this.timeoutMs}ms in ${cwd}: ${NpmCli.Tail(stderr)}`));
            }, this.timeoutMs);
            child.stdout?.on(NpmCli.DataEvent, (chunk: Buffer) =>
            {
                stdout += chunk.toString();
            });
            child.stderr?.on(NpmCli.DataEvent, (chunk: Buffer) =>
            {
                stderr += chunk.toString();
            });
            child.on(NpmCli.ErrorEvent, (err: Error) =>
            {
                clearTimeout(timer);
                reject(new AdapterPackError(infraFailure, `${label} failed to start (${launched}) in ${cwd}: ${err.message}`));
            });
            child.on(NpmCli.CloseEvent, (code: number | null) =>
            {
                clearTimeout(timer);
                if (code === 0)
                {
                    resolve();
                    return;
                }
                const output = `${stdout}${NpmCli.OutputJoin}${stderr}`;
                reject(new AdapterPackError(classifyExit(output), `${label} exited ${code} in ${cwd}: stdout: ${NpmCli.Tail(stdout)} stderr: ${NpmCli.Tail(stderr)}`));
            });
        });
    }
}
