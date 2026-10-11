import { WriteOperationKind } from "@pragmatic-tech-ai/todl";
import type { ExternalRecord, QueryRequest, WriteBatch, WriteConflict, WriteOperation, WriteResult } from "@pragmatic-tech-ai/todl";
import type { IDataSourceAdapter } from "@pragmatic-tech-ai/todl";
import { ExternalQuery } from "../query/external-query.js";
import { RestHttpMethod } from "./rest-http-client.js";
import type { IRestHttpClient } from "./rest-http-client.js";
import type { RestConnection } from "./rest-connection-config.js";

/** REST adapter: GET a collection, PUT/DELETE a resource; Where re-applied in-adapter. */
export class RestAdapter implements IDataSourceAdapter
{
    private static readonly PathSeparator = "/";
    private static readonly IfMatchHeader = "If-Match";
    private static readonly ConflictStatus = 409;
    private static readonly VersionConflictReason = "version mismatch";

    public constructor(private readonly client: IRestHttpClient, private readonly connection: RestConnection)
    {
    }

    public async Query(request: QueryRequest): Promise<readonly ExternalRecord[]>
    {
        const url = this.CollectionUrl(request.Source);
        const payload = await this.client.GetJson(url, this.connection.headers);
        const records = Array.isArray(payload) ? payload as Record<string, unknown>[] : [];
        return ExternalQuery.Apply(records, request);
    }

    public async Apply(batch: WriteBatch): Promise<WriteResult>
    {
        let applied = 0;
        const conflicts: WriteConflict[] = [];
        for (const op of batch.Operations)
        {
            if (op.Kind === WriteOperationKind.Delete)
            {
                await this.client.Send(RestHttpMethod.Delete, this.ResourceUrl(batch.Source, op.Key), this.connection.headers);
                applied++;
            }
            else if (await this.ApplyUpsert(batch, op)) applied++;
            else conflicts.push({ Key: op.Key, Reason: RestAdapter.VersionConflictReason });
        }
        return { Applied: applied, Conflicts: conflicts };
    }

    public async Dispose(): Promise<void>
    {
    }

    private async ApplyUpsert(batch: WriteBatch, op: WriteOperation): Promise<boolean>
    {
        const headers = { ...this.connection.headers };
        if (batch.VersionField !== undefined && op.Version !== undefined && op.Version !== null)
        {
            headers[RestAdapter.IfMatchHeader] = String(op.Version);
        }
        const response = await this.client.Send(
            RestHttpMethod.Put, this.ResourceUrl(batch.Source, op.Key), headers, op.Fields);
        return response.Status !== RestAdapter.ConflictStatus;
    }

    private CollectionUrl(source: string): string
    {
        return this.connection.baseUrl + RestAdapter.PathSeparator + encodeURIComponent(source);
    }

    private ResourceUrl(source: string, key: unknown): string
    {
        return this.CollectionUrl(source) + RestAdapter.PathSeparator + encodeURIComponent(String(key));
    }
}
