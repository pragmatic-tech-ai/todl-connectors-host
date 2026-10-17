import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { AdapterPackError, AdapterPackErrorKind } from "./adapter-pack-error.js";

/** Runs `npm install` against the package.json already written in a directory. */
export interface INpmCli
{
    Install(cwd: string): Promise<void>;
}

/** Production {@link INpmCli}: spawns the real `npm`. */
export class NpmCli implements INpmCli
{
    private static readonly WindowsCommand = "npm.cmd";
    private static readonly PosixCommand = "npm";
    private static readonly WindowsPlatform = "win32";
    private static readonly NpmCliScriptSegments: readonly string[] = ["node_modules", "npm", "bin", "npm-cli.js"];
    private static readonly DefaultTimeoutMs = 120000;
    private static readonly Stdio: ["ignore", "ignore", "pipe"] = ["ignore", "ignore", "pipe"];
    private static readonly KillSignal = "SIGKILL";
    private static readonly Args: readonly string[] = ["install", "--no-audit", "--no-fund"];
    private static readonly StderrTailChars = 2000;
    private static readonly ErrorEvent = "error";
    private static readonly CloseEvent = "close";
    private static readonly DataEvent = "data";

    /**
     * Resolves how to start npm without a shell. Node refuses to spawn a .cmd directly on Windows (EINVAL),
     * so there we run npm's own npm-cli.js under the current node when it sits beside it; npm.cmd is the fallback.
     */
    private static ResolveLaunch(): { Command: string; Prefix: readonly string[] }
    {
        if (process.platform !== NpmCli.WindowsPlatform)
        {
            return { Command: NpmCli.PosixCommand, Prefix: [] };
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
        return new Promise<void>((resolve, reject) =>
        {
            let stderr = "";
            const launch = NpmCli.ResolveLaunch();
            // Install/postinstall scripts run on the host at install time by design (mitigated upstream
            // by the provider allowlist + integrity verification), so --ignore-scripts is deliberately not set.
            const child = spawn(launch.Command, [...launch.Prefix, ...NpmCli.Args], { cwd, env: process.env, stdio: NpmCli.Stdio });
            const timer = setTimeout(() =>
            {
                child.kill(NpmCli.KillSignal);
                reject(new AdapterPackError(AdapterPackErrorKind.InstallFailed, `npm install timed out after ${this.timeoutMs}ms in ${cwd}`));
            }, this.timeoutMs);
            child.stderr?.on(NpmCli.DataEvent, (chunk: Buffer) =>
            {
                stderr += chunk.toString();
            });
            child.on(NpmCli.ErrorEvent, (err: Error) =>
            {
                clearTimeout(timer);
                reject(new AdapterPackError(AdapterPackErrorKind.InstallFailed, `npm install failed to start in ${cwd}: ${err.message}`));
            });
            child.on(NpmCli.CloseEvent, (code: number | null) =>
            {
                clearTimeout(timer);
                if (code === 0)
                {
                    resolve();
                    return;
                }
                const tail = stderr.slice(-NpmCli.StderrTailChars);
                reject(new AdapterPackError(AdapterPackErrorKind.InstallFailed, `npm install exited ${code} in ${cwd}: ${tail}`));
            });
        });
    }
}
