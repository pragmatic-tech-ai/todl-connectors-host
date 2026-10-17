import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AdapterPackError, AdapterPackErrorKind } from "../adapter-pack-error.js";
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

test("Install args pass --ignore-scripts and still install", () =>
{
    assert.equal(NpmCli.InstallArgs[0], "install");
    assert.ok(NpmCli.InstallArgs.includes("--ignore-scripts"));
});

test("RunInstallScripts args begin with rebuild and never pass --ignore-scripts", () =>
{
    assert.equal(NpmCli.RebuildArgs[0], "rebuild");
    assert.ok(!NpmCli.RebuildArgs.includes("--ignore-scripts"));
});

test("RunInstallScripts maps a spawn failure to InstallFailed", async () =>
{
    const missing = join(tmpdir(), "npm-cli-test-missing-dir-does-not-exist");
    await assert.rejects(
        new NpmCli().RunInstallScripts(missing),
        (err: unknown) => err instanceof AdapterPackError && err.Kind === AdapterPackErrorKind.InstallFailed);
});

test("RunInstallScripts maps a non-zero npm exit to InstallFailed", async () =>
{
    const dir = await mkdtemp(join(tmpdir(), "npm-cli-test-"));
    try
    {
        await writeFile(join(dir, "package.json"), JSON.stringify({ name: "npm-cli-failing-fixture", version: "1.0.0", scripts: { install: "node -e process.exit(1)" } }));
        await assert.rejects(
            new NpmCli().RunInstallScripts(dir),
            (err: unknown) => err instanceof AdapterPackError && err.Kind === AdapterPackErrorKind.InstallFailed);
    }
    finally
    {
        await rm(dir, { recursive: true, force: true });
    }
});
