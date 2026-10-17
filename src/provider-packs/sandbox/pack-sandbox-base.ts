import type { DataSourceKind, ExternalRecord, IDataSourceAdapter, IDataSourceAdapterFactory, QueryRequest, ResolvedConnection, WriteBatch, WriteResult } from "@pragmatic-tech-ai/todl";
import { AdapterPackError, AdapterPackErrorKind } from "../adapter-pack-error.js";
import type { IPackSandbox, PackSandboxOptions } from "./pack-sandbox.js";
import { PackWorkerOp } from "./pack-worker-protocol.js";
import type { PackWorkerRequest, PackWorkerResponse } from "./pack-worker-protocol.js";

/** The request operands a proxy supplies for one {@link PackSandboxBase.Call}. */
export type PackCallFields = Omit<PackWorkerRequest, "id" | "op">;

/** A host-side pending call awaiting its correlated pack response. */
export interface PendingCall
{
    readonly resolve: (response: PackWorkerResponse) => void;
    readonly reject: (error: AdapterPackError) => void;
    timer?: NodeJS.Timeout;
}

/** The EventEmitter event names both transports (worker port, child IPC) and their launchers subscribe to. */
export class SandboxEvents
{
    public static readonly Message = "message";
    public static readonly Error = "error";
    public static readonly Exit = "exit";
    public static readonly Disconnect = "disconnect";
}

/** Transport-agnostic core of a launched pack sandbox: monotonic request correlation, call timeout,
 *  and fail-closed crash/exit handling. Subclasses supply only the transport (`Post`/`Terminate`)
 *  and wire their channel events to the `OnChannel*` hooks. */
export abstract class PackSandboxBase implements IPackSandbox
{
    private static readonly DeadError = "pack sandbox is no longer running";
    private static readonly CallTimeoutReason = "pack sandbox call timed out";
    private static readonly CallFailedReason = "pack sandbox call failed";
    private static readonly DisposedReason = "pack sandbox was disposed";
    private static readonly DefaultCallTimeoutMs = 30000;

    private readonly pending = new Map<number, PendingCall>();
    private nextId = 1;
    private dead = false;
    protected disposed = false;
    private exited = false;

    protected constructor(private readonly options: PackSandboxOptions)
    {
    }

    public Factory(kind: DataSourceKind): IDataSourceAdapterFactory
    {
        return new PackProxyFactory(this, kind);
    }

    /** Whether the underlying transport's `exit` event has fired (terminated or self-exited). Lets a
     *  caller confirm the pack is truly gone rather than merely flagged dead. */
    public get HasExited(): boolean
    {
        return this.exited;
    }

    public async Dispose(): Promise<void>
    {
        if (this.disposed)
        {
            return;
        }
        this.disposed = true;
        this.MarkDead(PackSandboxBase.DisposedReason);
        await this.Terminate();
    }

    /** Correlates one request/response pair over the transport; rejects immediately if the sandbox is
     *  already dead so a caller never hangs on a terminated pack. */
    public Call(op: PackWorkerOp, fields: PackCallFields): Promise<PackWorkerResponse>
    {
        if (this.dead)
        {
            return Promise.reject(new AdapterPackError(AdapterPackErrorKind.SandboxCrashed, PackSandboxBase.DeadError));
        }
        const id = this.nextId++;
        return new Promise<PackWorkerResponse>((resolve, reject) =>
        {
            const entry: PendingCall = { resolve, reject };
            const timeoutMs = this.options.callTimeoutMs ?? PackSandboxBase.DefaultCallTimeoutMs;
            if (timeoutMs > 0)
            {
                entry.timer = setTimeout(() =>
                {
                    this.pending.delete(id);
                    reject(new AdapterPackError(AdapterPackErrorKind.SandboxTimeout, PackSandboxBase.CallTimeoutReason));
                }, timeoutMs);
                entry.timer.unref();
            }
            this.pending.set(id, entry);
            try
            {
                this.Post({ id, op, ...fields });
            }
            catch (err)
            {
                this.pending.delete(id);
                if (entry.timer !== undefined)
                {
                    clearTimeout(entry.timer);
                }
                reject(new AdapterPackError(AdapterPackErrorKind.PackCallFailed, `${PackSandboxBase.CallFailedReason}: ${(err as Error).message}`));
            }
        });
    }

    /** Throws the proxy-side typed error carried by an `ok:false` response. The sandbox is still
     *  live (the pack rejected or could not serve the call), so this is never `SandboxCrashed`. */
    public static EnsureOk(response: PackWorkerResponse): void
    {
        if (!response.ok)
        {
            throw new AdapterPackError(AdapterPackErrorKind.PackCallFailed, response.error ?? PackSandboxBase.CallFailedReason);
        }
    }

    /** Transport send; may throw (mapped to `PackCallFailed` by {@link Call}). */
    protected abstract Post(message: PackWorkerRequest): void;

    /** Transport teardown; must resolve even if already dead. */
    protected abstract Terminate(): Promise<void>;

    protected readonly OnChannelMessage = (response: PackWorkerResponse): void =>
    {
        if (response === null || typeof response !== "object" || typeof response.id !== "number")
        {
            return;
        }
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

    protected OnChannelError(reason: string): void
    {
        this.MarkDead(reason);
    }

    // Any exit of a sandbox we did not dispose is fatal: a later Call would otherwise register a
    // pending entry and post into a dead transport, dropping the message and hanging forever.
    protected OnChannelExit(reason: string): void
    {
        this.exited = true;
        if (this.disposed)
        {
            return;
        }
        this.MarkDead(reason);
    }

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

/** Host-side proxy for a pack factory of one kind; `Open` confirms the kind with the pack. */
export class PackProxyFactory implements IDataSourceAdapterFactory
{
    public readonly Kind: DataSourceKind;

    public constructor(private readonly sandbox: PackSandboxBase, kind: DataSourceKind)
    {
        this.Kind = kind;
    }

    public async Open(connection: ResolvedConnection): Promise<IDataSourceAdapter>
    {
        const response = await this.sandbox.Call(PackWorkerOp.Open, { kind: this.Kind, connection });
        PackSandboxBase.EnsureOk(response);
        return new PackProxyAdapter(this.sandbox, response.handle!);
    }
}

/** Host-side proxy for one open pack adapter, keyed by the pack-assigned handle. */
export class PackProxyAdapter implements IDataSourceAdapter
{
    public constructor(private readonly sandbox: PackSandboxBase, private readonly handle: number)
    {
    }

    public async Query(request: QueryRequest): Promise<readonly ExternalRecord[]>
    {
        const response = await this.sandbox.Call(PackWorkerOp.Query, { handle: this.handle, request });
        PackSandboxBase.EnsureOk(response);
        return response.records ?? [];
    }

    public async Apply(batch: WriteBatch): Promise<WriteResult>
    {
        const response = await this.sandbox.Call(PackWorkerOp.Apply, { handle: this.handle, batch });
        PackSandboxBase.EnsureOk(response);
        return response.result!;
    }

    public async Dispose(): Promise<void>
    {
        const response = await this.sandbox.Call(PackWorkerOp.Dispose, { handle: this.handle });
        PackSandboxBase.EnsureOk(response);
    }
}
