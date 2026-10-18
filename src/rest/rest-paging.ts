import { JsonPath } from "./json-path.js";

/** Declared REST paging: query-param names + where the items and the next token live in the response. */
export interface RestPaging
{
    readonly limitParam: string;
    /** The query param that carries the page token (from either pageAfterParam or pageTokenParam). */
    readonly tokenParam: string;
    readonly itemsPath: string;
    /** Envelope path of the next token; undefined when the token comes from the Link rel="next" header. */
    readonly nextTokenPath?: string;
    readonly useLinkHeader: boolean;
}

/** Parses the optional REST paging keys. No key present = not configured; a partial or contradictory set is a config error. */
export class RestPagingConfig
{
    private static readonly LimitParamKey = "pageLimitParam";
    private static readonly AfterParamKey = "pageAfterParam";
    private static readonly TokenParamKey = "pageTokenParam";
    private static readonly ItemsPathKey = "itemsPath";
    private static readonly NextTokenPathKey = "nextTokenPath";
    private static readonly LinkHeaderKey = "linkHeader";
    private static readonly TrueValue = "true";
    private static readonly IncompleteMessage =
        "rest paging config requires pageLimitParam, itemsPath, exactly one of pageAfterParam/pageTokenParam, and exactly one of nextTokenPath/linkHeader";

    public static From(config: Record<string, string>): RestPaging | undefined
    {
        const limitParam = config[RestPagingConfig.LimitParamKey];
        const afterParam = config[RestPagingConfig.AfterParamKey];
        const tokenParam = config[RestPagingConfig.TokenParamKey];
        const itemsPath = config[RestPagingConfig.ItemsPathKey];
        const nextTokenPath = config[RestPagingConfig.NextTokenPathKey];
        const linkRaw = config[RestPagingConfig.LinkHeaderKey];
        const useLinkHeader = linkRaw === RestPagingConfig.TrueValue;
        const any = [limitParam, afterParam, tokenParam, itemsPath, nextTokenPath, linkRaw].some(v => v !== undefined);
        if (!any) return undefined;
        const paramCount = (afterParam !== undefined ? 1 : 0) + (tokenParam !== undefined ? 1 : 0);
        const nextCount = (nextTokenPath !== undefined ? 1 : 0) + (useLinkHeader ? 1 : 0);
        if (limitParam === undefined || itemsPath === undefined || paramCount !== 1 || nextCount !== 1)
        {
            throw new Error(RestPagingConfig.IncompleteMessage);
        }
        JsonPath.Segments(itemsPath);
        if (nextTokenPath !== undefined) JsonPath.Segments(nextTokenPath);
        return {
            limitParam,
            tokenParam: (afterParam ?? tokenParam)!,
            itemsPath,
            useLinkHeader,
            ...(nextTokenPath !== undefined ? { nextTokenPath } : {}),
        };
    }
}

/** Extracts the rel="next" target from an RFC 5988 Link header. */
export class LinkHeader
{
    private static readonly EntrySeparator = ",";
    private static readonly EntryPattern = /<([^>]*)>\s*;(.*)/;
    private static readonly RelPattern = /rel\s*=\s*"?([^";]*)"?/i;
    private static readonly NextRel = "next";
    private static readonly RelSeparator = /\s+/;

    public static Next(header: string | undefined): string | undefined
    {
        if (header === undefined) return undefined;
        for (const entry of header.split(LinkHeader.EntrySeparator))
        {
            const match = LinkHeader.EntryPattern.exec(entry);
            if (match === null) continue;
            const rel = LinkHeader.RelPattern.exec(match[2]!);
            if (rel !== null && rel[1]!.trim().split(LinkHeader.RelSeparator).includes(LinkHeader.NextRel)) return match[1];
        }
        return undefined;
    }
}
