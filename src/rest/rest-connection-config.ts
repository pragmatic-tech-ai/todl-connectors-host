/** Parsed REST connection: base URL + headers (incl. bearer from the resolved secret). */
export interface RestConnection
{
    readonly baseUrl: string;
    readonly headers: Record<string, string>;
}

export class RestConnectionConfig
{
    private static readonly BaseUrlKey = "baseUrl";
    private static readonly AuthorizationHeader = "Authorization";
    private static readonly BearerPrefix = "Bearer ";
    private static readonly MissingBaseUrlMessage = "rest connector config requires 'baseUrl'";

    public static From(config: Record<string, string>, secret?: string): RestConnection
    {
        const baseUrl = config[RestConnectionConfig.BaseUrlKey];
        if (baseUrl === undefined) throw new Error(RestConnectionConfig.MissingBaseUrlMessage);
        const headers: Record<string, string> = {};
        if (secret !== undefined) headers[RestConnectionConfig.AuthorizationHeader] = RestConnectionConfig.BearerPrefix + secret;
        return { baseUrl, headers };
    }
}
