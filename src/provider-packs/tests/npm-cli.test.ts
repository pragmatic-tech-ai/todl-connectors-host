import assert from "node:assert/strict";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { AdapterPackError, AdapterPackErrorKind } from "../adapter-pack-error.js";
import { NpmCli } from "../npm-cli.js";

/** Fake child process: drive it with emit("close", code) / emit("error", err). */
class FakeChild extends EventEmitter
{
    public readonly stdout = new EventEmitter();
    public readonly stderr = new EventEmitter();

    public kill(): boolean
    {
        return true;
    }
}

/** Captures what reaches spawn and replies via a scripted event on the next tick. */
class SpawnCapture
{
    public Args: readonly string[] = [];

    public constructor(private readonly event: string, private readonly payload: unknown)
    {
    }

    public Spawn = (_command: string, args: readonly string[], _options: SpawnOptions): ChildProcess =>
    {
        this.Args = args;
        const child = new FakeChild();
        setImmediate(() => child.emit(this.event, this.payload));
        return child as unknown as ChildProcess;
    };
}

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

test("Install passes --ignore-scripts and install to spawn", async () =>
{
    const capture = new SpawnCapture("close", 0);
    await new NpmCli({ spawn: capture.Spawn }).Install("/x");
    assert.ok(capture.Args.includes("install"));
    assert.ok(capture.Args.includes("--ignore-scripts"));
});

test("RunInstallScripts passes rebuild to spawn and never --ignore-scripts", async () =>
{
    const capture = new SpawnCapture("close", 0);
    await new NpmCli({ spawn: capture.Spawn }).RunInstallScripts("/x");
    assert.strictEqual(capture.Args[capture.Args.length - 1], "rebuild");
    assert.ok(!capture.Args.includes("--ignore-scripts"));
});

test("RunInstallScripts maps a non-zero exit to InstallFailed", async () =>
{
    const capture = new SpawnCapture("close", 1);
    await assert.rejects(
        new NpmCli({ spawn: capture.Spawn }).RunInstallScripts("/x"),
        (err: unknown) => err instanceof AdapterPackError && err.Kind === AdapterPackErrorKind.InstallFailed);
});

test("RunInstallScripts maps a spawn error to InstallFailed", async () =>
{
    const capture = new SpawnCapture("error", new Error("ENOENT"));
    await assert.rejects(
        new NpmCli({ spawn: capture.Spawn }).RunInstallScripts("/x"),
        (err: unknown) => err instanceof AdapterPackError && err.Kind === AdapterPackErrorKind.InstallFailed);
});
