import { WriteOperationKind } from "@pragmatic-tech-ai/todl";
import type { ExternalRecord, IDataSourceAdapter, QueryRequest, WriteBatch, WriteConflict, WriteOperation, WriteResult } from "@pragmatic-tech-ai/todl";
import { ExternalQuery } from "../query/external-query.js";
import { MongoFilter } from "./mongo-filter.js";
import { DocumentIdentifier } from "./document-identifier.js";
import type { IDocumentSession } from "./document-session.js";

/** Document adapter: Find to read (Where re-applied in-adapter), Upsert/Delete to write. */
export class DocumentAdapter implements IDataSourceAdapter
{
    private static readonly VersionConflictReason = "version mismatch";

    public constructor(private readonly session: IDocumentSession)
    {
    }

    public async Query(request: QueryRequest): Promise<readonly ExternalRecord[]>
    {
        const filter = MongoFilter.From(request.Where?.All ?? []);
        const docs = await this.session.Find(request.Source, filter);
        return ExternalQuery.Apply(docs, request);
    }

    public async Apply(batch: WriteBatch): Promise<WriteResult>
    {
        let applied = 0;
        const conflicts: WriteConflict[] = [];
        for (const op of batch.Operations)
        {
            if (op.Kind === WriteOperationKind.Delete)
            {
                await this.session.Delete(batch.Source, batch.IdKey, op.Key);
                applied++;
            }
            else if (await this.ApplyUpsert(batch, op))
            {
                applied++;
            }
            else
            {
                conflicts.push({ Key: op.Key, Reason: DocumentAdapter.VersionConflictReason });
            }
        }
        return { Applied: applied, Conflicts: conflicts };
    }

    public async Dispose(): Promise<void>
    {
        await this.session.Dispose?.();
    }

    private async ApplyUpsert(batch: WriteBatch, op: WriteOperation): Promise<boolean>
    {
        for (const field of Object.keys(op.Fields))
        {
            DocumentIdentifier.Validate(field);
        }
        // Guard keys off batch.VersionField, but ReadVersion reads the CONNECTION-configured versionField (its signature carries no field name); if they differ, the connection's field is what is actually read.
        if (batch.VersionField !== undefined && this.session.ReadVersion !== undefined)
        {
            const stored = (await this.session.ReadVersion(batch.Source, batch.IdKey, op.Key)) ?? null;
            // A stored null (doc absent OR present-but-unversioned) is treated as writable (fail-open); only a present, concrete
            // stored version that differs from op.Version is a conflict. Documented v1 best-effort optimistic-concurrency limitation.
            if (stored !== null && stored !== (op.Version ?? null))
            {
                return false;
            }
        }
        await this.session.Upsert(batch.Source, batch.IdKey, op.Key, { ...op.Fields, [batch.IdKey]: op.Key });
        return true;
    }
}
