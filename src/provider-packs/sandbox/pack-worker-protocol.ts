import type { ExternalRecord, QueryRequest, ResolvedConnection, WriteBatch, WriteResult } from "@pragmatic-tech-ai/todl";

/** The operation a {@link PackWorkerRequest} asks the worker-hosted pack to perform. */
export enum PackWorkerOp
{
    Open = "open",
    Query = "query",
    Apply = "apply",
    Dispose = "dispose"
}

/** A host → worker call: a correlation `id`, the `op`, and only the plain-data operands that op
 *  needs. Every field is a structured-clone-safe engine data type — never a function or a class
 *  instance with behavior. */
export interface PackWorkerRequest
{
    readonly id: number;
    readonly op: PackWorkerOp;
    readonly kind?: string;
    readonly handle?: number;
    readonly connection?: ResolvedConnection;
    readonly request?: QueryRequest;
    readonly batch?: WriteBatch;
}

/** A worker → host reply correlated to a {@link PackWorkerRequest} by `id`. `ok:false` carries a
 *  typed `error` string the proxy rethrows; the result field matches the request's op. */
export interface PackWorkerResponse
{
    readonly id: number;
    readonly ok: boolean;
    readonly handle?: number;
    readonly records?: readonly ExternalRecord[];
    readonly result?: WriteResult;
    readonly error?: string;
}

/** The single startup message the worker posts once the pack imported and its factories bound. */
export interface PackWorkerReady
{
    readonly ready: true;
}

/** The single startup message the worker posts when the pack entry is missing, is not an
 *  `IAdapterPack`, or threw on import. */
export interface PackWorkerFailed
{
    readonly ready: false;
    readonly error: string;
}

/** Name of the environment variable that carries the absolute pack entry path to a forked child
 *  (a child process has no `workerData`). Single home shared by the launcher and the child entry. */
export const PackEntryEnvVar = "TODL_PACK_ENTRY";

/** The subset of `MessagePort` / `process` IPC the pack host entry uses; `parentPort` and the
 *  child-process shim both satisfy it. */
export interface IPackHostPort
{
    postMessage(message: unknown): void;
    on(event: string, handler: (message: any) => void): void;
}
