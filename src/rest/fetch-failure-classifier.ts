import { ConnectionFailureKind } from "@pragmatic-tech-ai/todl";

/** Classifies a thrown fetch/HTTP transport error. Reads only the error's type, name, status and the
 *  trailing integer of its message; never stringifies the error beyond that or touches a secret. */
export class FetchFailureClassifier
{
    private static readonly TransientStatuses: ReadonlySet<number> = new Set([502, 503, 504, 429]);
    private static readonly AuthStatuses: ReadonlySet<number> = new Set([401, 403]);
    private static readonly NetworkErrorNames: ReadonlySet<string> = new Set(["AbortError", "TimeoutError"]);
    private static readonly TrailingStatus = /(\d+)\s*$/;

    public static Classify(error: unknown): ConnectionFailureKind
    {
        if (error === null || typeof error !== "object")
        {
            return ConnectionFailureKind.Permanent;
        }
        const e = error as { name?: unknown; status?: unknown; message?: unknown };
        if (error instanceof TypeError || (typeof e.name === "string" && FetchFailureClassifier.NetworkErrorNames.has(e.name)))
        {
            return ConnectionFailureKind.Transient;
        }
        const status = FetchFailureClassifier.StatusOf(e);
        if (status !== undefined && FetchFailureClassifier.TransientStatuses.has(status))
        {
            return ConnectionFailureKind.Transient;
        }
        if (status !== undefined && FetchFailureClassifier.AuthStatuses.has(status))
        {
            return ConnectionFailureKind.Auth;
        }
        return ConnectionFailureKind.Permanent;
    }

    private static StatusOf(e: { status?: unknown; message?: unknown }): number | undefined
    {
        if (typeof e.status === "number")
        {
            return e.status;
        }
        if (typeof e.message === "string")
        {
            const match = FetchFailureClassifier.TrailingStatus.exec(e.message);
            return match === null ? undefined : Number(match[1]);
        }
        return undefined;
    }
}
