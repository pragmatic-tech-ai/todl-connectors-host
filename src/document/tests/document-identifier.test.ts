import { test } from "node:test";
import assert from "node:assert/strict";
import { DocumentIdentifier } from "../document-identifier.js";

class IdentifierCases
{
    public static readonly Valid = "customer_name";
    public static readonly Empty = "";
    public static readonly Control = "bad\u0001name";
    public static readonly Operator = "$where";
    public static readonly Dotted = "a.b";
}

test("Validate returns a valid name unchanged", () =>
{
    assert.equal(DocumentIdentifier.Validate(IdentifierCases.Valid), IdentifierCases.Valid);
});

test("Validate rejects empty, control-char, operator-prefixed and dotted names", () =>
{
    for (const bad of [IdentifierCases.Empty, IdentifierCases.Control, IdentifierCases.Operator, IdentifierCases.Dotted])
    {
        assert.throws(() => DocumentIdentifier.Validate(bad), /invalid document identifier/);
    }
});
