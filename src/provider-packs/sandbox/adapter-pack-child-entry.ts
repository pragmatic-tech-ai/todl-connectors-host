import { AdapterPackHost } from "./adapter-pack-host-entry.js";
import { PackEntryEnvVar } from "./pack-worker-protocol.js";
import type { IPackHostPort } from "./pack-worker-protocol.js";

/** Presents the forked child's `process` IPC channel as the host port the shared AdapterPackHost
 *  consumes, so the worker-thread and child-process entries boot the identical pack host. */
class ChildHostPort implements IPackHostPort
{
    public postMessage(message: unknown): void
    {
        process.send!(message);
    }

    public on(event: string, handler: (message: any) => void): void
    {
        process.on(event, handler);
    }
}

class ChildEntry
{
    public static Boot(): void
    {
        const port = typeof process.send === "function" ? new ChildHostPort() : null;
        void AdapterPackHost.Boot(port, { entry: process.env[PackEntryEnvVar] });
    }
}

ChildEntry.Boot();
