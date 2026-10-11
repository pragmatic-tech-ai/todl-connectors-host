import { test } from "node:test";
import assert from "node:assert/strict";
import { CypherIdentifier } from "../cypher-identifier.js";

class IdentifierFixture
{
    public static readonly Plain = "Customer";
    public static readonly PlainQuoted = "`Customer`";
    public static readonly Weird = "we`ird";
    public static readonly WeirdQuoted = "`we``ird`";
    public static readonly Bad = "bad\u0000name";
    public static readonly Ok = "ok_name";
}

test("Quote backtick-wraps and doubles embedded backticks", () =>
{
    assert.equal(CypherIdentifier.Quote(IdentifierFixture.Plain), IdentifierFixture.PlainQuoted);
    assert.equal(CypherIdentifier.Quote(IdentifierFixture.Weird), IdentifierFixture.WeirdQuoted);
});

test("Validate rejects control characters", () =>
{
    assert.throws(() => CypherIdentifier.Validate(IdentifierFixture.Bad));
    assert.equal(CypherIdentifier.Validate(IdentifierFixture.Ok), IdentifierFixture.Ok);
});

test("Validate and Quote reject an empty name", () =>
{
    assert.throws(() => CypherIdentifier.Validate(""));
    assert.throws(() => CypherIdentifier.Quote(""));
});
