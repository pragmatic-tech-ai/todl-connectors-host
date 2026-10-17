import { WriteFailureKind, WriteOperationKind } from "@pragmatic-tech-ai/todl";
import type { ExternalRecord, IDataSourceAdapter, QueryRequest, WriteBatch, WriteFailure, WriteOperation, WriteResult } from "@pragmatic-tech-ai/todl";
import { ExternalQuery } from "../query/external-query.js";
import { CypherIdentifier } from "./cypher-identifier.js";
import type { ICypherSession } from "./cypher-session.js";

/** Graph adapter: MATCH to read (Where re-applied in-adapter), MERGE/DETACH DELETE to write. */
export class CypherAdapter implements IDataSourceAdapter
{
    public static readonly NodeVar = "n";
    public static readonly PropsAlias = "props";
    public static readonly VersionAlias = "ver";
    public static readonly KeyParam = "key";
    public static readonly FieldsParam = "fields";
    public static readonly Match = "MATCH";
    public static readonly Merge = "MERGE";
    public static readonly SetClause = "SET";
    public static readonly Return = "RETURN";
    public static readonly DetachDelete = "DETACH DELETE";
    public static readonly PropertiesFn = "properties";
    public static readonly AsKeyword = "AS";
    public static readonly ParamPrefix = "$";
    public static readonly OpenParen = "(";
    public static readonly CloseParen = ")";
    public static readonly OpenBrace = "{";
    public static readonly CloseBrace = "}";
    public static readonly Colon = ":";
    public static readonly Space = " ";
    public static readonly Dot = ".";
    public static readonly MergeAssign = "+=";
    private static readonly VersionConflictReason = "version mismatch";

    public constructor(private readonly session: ICypherSession)
    {
    }

    public async Query(request: QueryRequest): Promise<readonly ExternalRecord[]>
    {
        const v = CypherAdapter.NodeVar;
        const label = CypherIdentifier.Quote(request.Source);
        const cypher = [CypherAdapter.Match, `${CypherAdapter.OpenParen}${v}${CypherAdapter.Colon}${label}${CypherAdapter.CloseParen}`,
            CypherAdapter.Return, `${CypherAdapter.PropertiesFn}${CypherAdapter.OpenParen}${v}${CypherAdapter.CloseParen}`,
            CypherAdapter.AsKeyword, CypherAdapter.PropsAlias].join(CypherAdapter.Space);
        const rows = await this.session.Run(cypher, {});
        const records = rows.map(r => (r[CypherAdapter.PropsAlias] ?? {}) as Record<string, unknown>);
        return ExternalQuery.Apply(records, request);
    }

    public async Apply(batch: WriteBatch): Promise<WriteResult>
    {
        let applied = 0;
        const conflicts: WriteFailure[] = [];
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
                conflicts.push({ Key: op.Key, Kind: WriteFailureKind.Conflict, Reason: CypherAdapter.VersionConflictReason });
            }
        }
        return { Applied: applied, Failures: conflicts };
    }

    public async Dispose(): Promise<void>
    {
        await this.session.Dispose?.();
    }

    private IdPattern(batch: WriteBatch): string
    {
        const label = CypherIdentifier.Quote(batch.Source);
        const idKey = CypherIdentifier.Quote(batch.IdKey);
        const param = `${CypherAdapter.ParamPrefix}${CypherAdapter.KeyParam}`;
        return `${CypherAdapter.OpenParen}${CypherAdapter.NodeVar}${CypherAdapter.Colon}${label}${CypherAdapter.Space}`
            + `${CypherAdapter.OpenBrace}${idKey}${CypherAdapter.Colon}${CypherAdapter.Space}${param}${CypherAdapter.CloseBrace}${CypherAdapter.CloseParen}`;
    }

    private async ApplyUpsert(batch: WriteBatch, op: WriteOperation): Promise<boolean>
    {
        if (batch.VersionField !== undefined && !(await this.VersionMatches(batch, op)))
        {
            return false;
        }
        const cypher = [CypherAdapter.Merge, this.IdPattern(batch), CypherAdapter.SetClause, CypherAdapter.NodeVar,
            CypherAdapter.MergeAssign, `${CypherAdapter.ParamPrefix}${CypherAdapter.FieldsParam}`].join(CypherAdapter.Space);
        const fields: Record<string, unknown> = { ...op.Fields, [batch.IdKey]: op.Key };
        await this.session.Run(cypher, { [CypherAdapter.KeyParam]: op.Key, [CypherAdapter.FieldsParam]: fields });
        return true;
    }

    private async VersionMatches(batch: WriteBatch, op: WriteOperation): Promise<boolean>
    {
        const versionField = CypherIdentifier.Quote(batch.VersionField!);
        const cypher = [CypherAdapter.Match, this.IdPattern(batch), CypherAdapter.Return,
            `${CypherAdapter.NodeVar}${CypherAdapter.Dot}${versionField}`, CypherAdapter.AsKeyword, CypherAdapter.VersionAlias].join(CypherAdapter.Space);
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
        const cypher = [CypherAdapter.Match, this.IdPattern(batch), CypherAdapter.DetachDelete, CypherAdapter.NodeVar].join(CypherAdapter.Space);
        await this.session.Run(cypher, { [CypherAdapter.KeyParam]: op.Key });
    }
}
