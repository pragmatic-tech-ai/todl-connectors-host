import { WriteOperationKind } from "@pragmatic-tech-ai/todl";
import type { ExternalRecord, IDataSourceAdapter, QueryRequest, WriteBatch, WriteConflict, WriteOperation, WriteResult } from "@pragmatic-tech-ai/todl";
import { ExternalQuery } from "../query/external-query.js";
import { CypherIdentifier } from "./cypher-identifier.js";
import type { ICypherSession } from "./cypher-session.js";

/** Graph adapter: MATCH to read (Where re-applied in-adapter), MERGE/DETACH DELETE to write. */
export class CypherAdapter implements IDataSourceAdapter
{
    private static readonly NodeVar = "n";
    private static readonly PropsAlias = "props";
    private static readonly VersionAlias = "ver";
    private static readonly KeyParam = "key";
    private static readonly FieldsParam = "fields";
    private static readonly VersionConflictReason = "version mismatch";
    private static readonly Match = "MATCH";
    private static readonly Merge = "MERGE";
    private static readonly SetClause = "SET";
    private static readonly Return = "RETURN";
    private static readonly DetachDelete = "DETACH DELETE";

    public constructor(private readonly session: ICypherSession)
    {
    }

    public async Query(request: QueryRequest): Promise<readonly ExternalRecord[]>
    {
        const v = CypherAdapter.NodeVar;
        const cypher = `${CypherAdapter.Match} (${v}:${CypherIdentifier.Quote(request.Source)}) `
            + `${CypherAdapter.Return} properties(${v}) AS ${CypherAdapter.PropsAlias}`;
        const rows = await this.session.Run(cypher, {});
        const records = rows.map(r => (r[CypherAdapter.PropsAlias] ?? {}) as Record<string, unknown>);
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
                await this.Delete(batch, op);
                applied++;
            }
            else if (await this.ApplyUpsert(batch, op))
            {
                applied++;
            }
            else
            {
                conflicts.push({ Key: op.Key, Reason: CypherAdapter.VersionConflictReason });
            }
        }
        return { Applied: applied, Conflicts: conflicts };
    }

    public async Dispose(): Promise<void>
    {
        await this.session.Dispose?.();
    }

    private IdPattern(batch: WriteBatch): string
    {
        const label = CypherIdentifier.Quote(batch.Source);
        const idKey = CypherIdentifier.Quote(batch.IdKey);
        return `(${CypherAdapter.NodeVar}:${label} {${idKey}: $${CypherAdapter.KeyParam}})`;
    }

    private async ApplyUpsert(batch: WriteBatch, op: WriteOperation): Promise<boolean>
    {
        if (batch.VersionField !== undefined && !(await this.VersionMatches(batch, op)))
        {
            return false;
        }
        const cypher = `${CypherAdapter.Merge} ${this.IdPattern(batch)} `
            + `${CypherAdapter.SetClause} ${CypherAdapter.NodeVar} += $${CypherAdapter.FieldsParam}`;
        const fields: Record<string, unknown> = { ...op.Fields, [batch.IdKey]: op.Key };
        await this.session.Run(cypher, { [CypherAdapter.KeyParam]: op.Key, [CypherAdapter.FieldsParam]: fields });
        return true;
    }

    private async VersionMatches(batch: WriteBatch, op: WriteOperation): Promise<boolean>
    {
        const versionField = CypherIdentifier.Quote(batch.VersionField!);
        const cypher = `${CypherAdapter.Match} ${this.IdPattern(batch)} `
            + `${CypherAdapter.Return} ${CypherAdapter.NodeVar}.${versionField} AS ${CypherAdapter.VersionAlias}`;
        const rows = await this.session.Run(cypher, { [CypherAdapter.KeyParam]: op.Key });
        if (rows.length === 0)
        {
            return true; // new node: no prior version to conflict with
        }
        const stored = rows[0]![CypherAdapter.VersionAlias] ?? null;
        return stored === (op.Version ?? null);
    }

    private async Delete(batch: WriteBatch, op: WriteOperation): Promise<void>
    {
        const cypher = `${CypherAdapter.Match} ${this.IdPattern(batch)} `
            + `${CypherAdapter.DetachDelete} ${CypherAdapter.NodeVar}`;
        await this.session.Run(cypher, { [CypherAdapter.KeyParam]: op.Key });
    }
}
