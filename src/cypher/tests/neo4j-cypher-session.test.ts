import { test } from "node:test";
import assert from "node:assert/strict";
import { ConnectionFailureKind } from "@pragmatic-tech-ai/todl";
import { CypherAdapter } from "../cypher-adapter.js";
import type { ICypherSession } from "../cypher-session.js";

class Neo4jClassifyCases
{
    public static readonly Rows: readonly { Label: string; Error: unknown; Kind: ConnectionFailureKind }[] = [
        { Label: "ServiceUnavailable", Error: { code: "ServiceUnavailable" }, Kind: ConnectionFailureKind.Transient },
        { Label: "SessionExpired", Error: { code: "SessionExpired" }, Kind: ConnectionFailureKind.Transient },
        { Label: "transient database unavailable", Error: { name: "Neo4jError", code: "Neo.TransientError.General.DatabaseUnavailable" }, Kind: ConnectionFailureKind.Transient },
        { Label: "Unauthorized", Error: { code: "Neo.ClientError.Security.Unauthorized" }, Kind: ConnectionFailureKind.Auth },
        { Label: "AuthenticationRateLimit", Error: { code: "Neo.ClientError.Security.AuthenticationRateLimit" }, Kind: ConnectionFailureKind.Auth },
        { Label: "Forbidden", Error: { code: "Neo.ClientError.Security.Forbidden" }, Kind: ConnectionFailureKind.Auth },
        { Label: "syntax error", Error: { code: "Neo.ClientError.Statement.SyntaxError" }, Kind: ConnectionFailureKind.Permanent },
        { Label: "unknown", Error: new Error("boom"), Kind: ConnectionFailureKind.Permanent },
        { Label: "non-string code", Error: { code: 42 }, Kind: ConnectionFailureKind.Permanent },
        { Label: "null", Error: null, Kind: ConnectionFailureKind.Permanent },
        { Label: "string", Error: "ServiceUnavailable", Kind: ConnectionFailureKind.Permanent },
    ];
}

for (const row of Neo4jClassifyCases.Rows)
{
    test(`CypherAdapter.ClassifyFailure: ${row.Label}`, () =>
    {
        const adapter = new CypherAdapter({} as ICypherSession);
        assert.equal(adapter.ClassifyFailure(row.Error), row.Kind);
    });
}
