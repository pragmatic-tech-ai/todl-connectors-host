/** Dot-separated JSON path traversal over a response envelope (an optional leading "$." is tolerated). */
export class JsonPath
{
    private static readonly Separator = ".";
    private static readonly RootPrefix = "$.";
    private static readonly Root = "$";
    private static readonly InvalidPathMessage = "json path must be a non-empty dot-separated path";

    /** Splits a path into segments; throws a clear error when it has none. */
    public static Segments(path: string): string[]
    {
        let trimmed = path.trim();
        if (trimmed.startsWith(JsonPath.RootPrefix))
        {
            trimmed = trimmed.slice(JsonPath.RootPrefix.length);
        }
        else if (trimmed === JsonPath.Root)
        {
            trimmed = "";
        }
        const segments = trimmed.split(JsonPath.Separator);
        if (trimmed.length === 0 || segments.some(s => s.length === 0))
        {
            throw new Error(JsonPath.InvalidPathMessage);
        }
        return segments;
    }

    /** Reads the value at the path; undefined when any hop is missing or not an object. */
    public static Read(root: unknown, path: string): unknown
    {
        let current: unknown = root;
        for (const segment of JsonPath.Segments(path))
        {
            if (current === null || typeof current !== "object") return undefined;
            current = (current as Record<string, unknown>)[segment];
        }
        return current;
    }

    /** A token is a non-empty string or a finite number; anything else (null, missing, "") means "no next page". */
    public static AsToken(value: unknown): string | number | undefined
    {
        if (typeof value === "string" && value.length > 0) return value;
        if (typeof value === "number" && Number.isFinite(value)) return value;
        return undefined;
    }
}
