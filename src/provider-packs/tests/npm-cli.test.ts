import assert from "node:assert/strict";
import { test } from "node:test";
import { AdapterPackErrorKind } from "../adapter-pack-error.js";
import { NpmCli } from "../npm-cli.js";

test("audit output reporting an invalid or missing signature classifies as SignatureInvalid", () =>
{
    assert.equal(NpmCli.ClassifyAuditFailure("audited 3 packages\n1 package has an invalid registry signature"), AdapterPackErrorKind.SignatureInvalid);
    assert.equal(NpmCli.ClassifyAuditFailure("2 packages have missing registry signatures"), AdapterPackErrorKind.SignatureInvalid);
});

test("registry or network trouble classifies as SignatureCheckUnavailable, not tampering", () =>
{
    assert.equal(NpmCli.ClassifyAuditFailure("npm error code ENOTFOUND\nnpm error network request failed"), AdapterPackErrorKind.SignatureCheckUnavailable);
    assert.equal(NpmCli.ClassifyAuditFailure("npm error code E503 service unavailable"), AdapterPackErrorKind.SignatureCheckUnavailable);
});

test("an affirmative invalid-signature report wins over incidental network wording", () =>
{
    assert.equal(NpmCli.ClassifyAuditFailure("network ok; 1 package has an invalid registry signature"), AdapterPackErrorKind.SignatureInvalid);
});

test("unrecognized audit failures stay fail-closed as SignatureInvalid", () =>
{
    assert.equal(NpmCli.ClassifyAuditFailure("something odd"), AdapterPackErrorKind.SignatureInvalid);
});
