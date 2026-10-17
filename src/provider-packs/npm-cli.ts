import { spawn } from "node:child_process";
import { AdapterPackError, AdapterPackErrorKind } from "./adapter-pack-error.js";

/** Runs `npm install` against the package.json already written in a directory. */
export interface INpmCli
{
    Install(cwd: string): Promise<void>;
}

/** Production {@link INpmCli}: spawns the real `npm`. */
export class NpmCli implements INpmCli
{
    private static readonly IsWindows = process.platform === "win32";
    private static readonly Command = "npm";
    private static readonly Args: readonly string[] = ["install", "--no-audit", "--no-fund"];
    private static readonly StderrTailChars = 2000;
    private static readonly ErrorEvent = "error";
    private static readonly CloseEvent = "close";
    private static readonly DataEvent = "data";

    public Install(cwd: string): Promise<void>
    {
        return new Promise<void>((resolve, reject) =>
        {
            let stderr = "";
            // On Windows npm is a .cmd shim, which Node can only launch through a shell.
            const child = spawn(NpmCli.Command, [...NpmCli.Args], { cwd, env: process.env, shell: NpmCli.IsWindows });
            child.stderr?.on(NpmCli.DataEvent, (chunk: Buffer) =>
            {
                stderr += chunk.toString();
            });
            child.on(NpmCli.ErrorEvent, (err: Error) =>
            {
                reject(new AdapterPackError(AdapterPackErrorKind.InstallFailed, `npm install failed to start in ${cwd}: ${err.message}`));
            });
            child.on(NpmCli.CloseEvent, (code: number | null) =>
            {
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
