import type { DataSourceKind, IDataSourceAdapterFactory } from "@pragmatic-tech-ai/todl";
import type { InstalledPack } from "../adapter-pack-installer.js";

/** V8 heap/stack caps and call/startup deadlines applied to a sandboxed pack. */
export interface PackSandboxOptions
{
    readonly resourceLimits?:
    {
        readonly maxOldGenerationSizeMb?: number;
        readonly maxYoungGenerationSizeMb?: number;
        readonly stackSizeMb?: number;
    };
    readonly startupTimeoutMs?: number;
    readonly callTimeoutMs?: number;
}

/** A launched pack running in isolation. `Factory` hands back a proxy for a kind; whether the pack
 *  actually provides that kind is confirmed by the sandbox when the host calls `Open`. */
export interface IPackSandbox
{
    Factory(kind: DataSourceKind): IDataSourceAdapterFactory;
    Dispose(): Promise<void>;
}

/** Launches an installed pack into an {@link IPackSandbox} (worker-thread strategy here;
 *  child-process is a later strategy behind the same seam). */
export interface IPackSandboxFactory
{
    Launch(installed: InstalledPack, options?: PackSandboxOptions): Promise<IPackSandbox>;
}
