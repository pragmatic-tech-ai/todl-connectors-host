import { RestPagingConfig } from "./rest-paging.js";
import { DeclaredFilters } from "./declared-filters.js";
import type { RestPaging } from "./rest-paging.js";

/** Parsed REST connection: base URL + headers (incl. bearer from the resolved secret). */
export interface RestConnection
{
    readonly baseUrl: string;
    readonly headers: Record<string, string>;
    /** Present only when the connection declares paging; gates the adapter's CanPage. */
    readonly paging?: RestPaging;
    /** Declared server-side equality filters (`filterParams`); None when undeclared. */
    readonly filters?: DeclaredFilters;
}

export class RestConnectionConfig
{
    private static readonly TrailingSlashes = /\/+$/;
    private static readonly BaseUrlKey = "baseUrl";
    private static readonly AuthorizationHeader = "Authorization";
    private static readonly BearerPrefix = "Bearer ";
    private static readonly MissingBaseUrlMessage = "rest connector config requires 'baseUrl'";
    private static readonly FilterParamsKey = "filterParams";

    public static From(config: Record<string, string>, secret?: string): RestConnection
    {
        const rawBaseUrl = config[RestConnectionConfig.BaseUrlKey];
        if (rawBaseUrl === undefined) throw new Error(RestConnectionConfig.MissingBaseUrlMessage);
        const baseUrl = rawBaseUrl.replace(RestConnectionConfig.TrailingSlashes, "");
        const headers: Record<string, string> = {};
        if (secret !== undefined) headers[RestConnectionConfig.AuthorizationHeader] = RestConnectionConfig.BearerPrefix + secret;
        const paging = RestPagingConfig.From(config);
        const filters = DeclaredFilters.Parse(config[RestConnectionConfig.FilterParamsKey], false);
        return { baseUrl, headers, ...(paging !== undefined ? { paging } : {}), ...(filters.IsEmpty ? {} : { filters }) };
    }
}
