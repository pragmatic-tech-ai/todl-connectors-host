import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { AdapterPackError, AdapterPackErrorKind } from "../adapter-pack-error.js";
import { ScriptAllowlist } from "../script-allowlist.js";

class AllowlistFixture
{
    public static readonly FileName = "script-allowlist.json";
    public static readonly TempPrefix = "script-allowlist-";
    public static readonly Utf8 = "utf8";
    public static readonly SeedA = "seed-a";
    public static readonly SeedB = "seed-b";
    public static readonly NewPack = "new-pack";
    public static readonly Other = "other-pack";
    public static readonly InvalidNames: readonly string[] = ["../x", "a/b/c", "http://x"];

    public dir = "";

    public get FilePath(): string
    {
        return join(this.dir, AllowlistFixture.FileName);
    }

    public Setup(): void
    {
        this.dir = mkdtempSync(join(tmpdir(), AllowlistFixture.TempPrefix));
    }

    public Teardown(): void
    {
        rmSync(this.dir, { recursive: true, force: true });
    }

    public Create(seed: readonly string[]): ScriptAllowlist
    {
        return new ScriptAllowlist(this.FilePath, seed);
    }
}

const fx = new AllowlistFixture();
beforeEach(() => fx.Setup());
afterEach(() => fx.Teardown());

test("missing file reads as the seed", async () =>
{
    const list = fx.Create([AllowlistFixture.SeedB, AllowlistFixture.SeedA]);
    assert.equal(await list.Has(AllowlistFixture.SeedA), true);
    assert.equal(await list.Has(AllowlistFixture.Other), false);
    assert.deepEqual(await list.List(), [AllowlistFixture.SeedA, AllowlistFixture.SeedB]);
});

test("Allow persists across instances", async () =>
{
    await fx.Create([]).Allow(AllowlistFixture.NewPack);
    assert.equal(await fx.Create([]).Has(AllowlistFixture.NewPack), true);
});

test("Deny of a seed-only entry materializes the rest of the seed", async () =>
{
    const seed = [AllowlistFixture.SeedA, AllowlistFixture.SeedB];
    await fx.Create(seed).Deny(AllowlistFixture.SeedA);
    const fresh = fx.Create(seed);
    assert.equal(await fresh.Has(AllowlistFixture.SeedA), false);
    assert.equal(await fresh.Has(AllowlistFixture.SeedB), true);
});

test("invalid names are rejected with InvalidName and write nothing", async () =>
{
    const list = fx.Create([]);
    for (const bad of AllowlistFixture.InvalidNames)
    {
        for (const op of [() => list.Allow(bad), () => list.Deny(bad)])
        {
            await assert.rejects(op, (e: unknown) => e instanceof AdapterPackError && e.Kind === AdapterPackErrorKind.InvalidName);
        }
    }
    assert.equal(existsSync(fx.FilePath), false);
});

test("wrong-typed names reads as empty and invalid entries are filtered", async () =>
{
    writeFileSync(fx.FilePath, JSON.stringify({ names: "oops" }));
    assert.deepEqual(await fx.Create([AllowlistFixture.SeedA]).List(), []);
    writeFileSync(fx.FilePath, JSON.stringify({ names: ["ok", "../bad"] }));
    assert.deepEqual(await fx.Create([]).List(), ["ok"]);
});

test("concurrent Allow keeps the file valid JSON with at least one name", async () =>
{
    const list = fx.Create([]);
    await Promise.all([list.Allow("a"), list.Allow("b")]);
    const parsed = JSON.parse(readFileSync(fx.FilePath, AllowlistFixture.Utf8)) as { names: string[] };
    assert.ok(parsed.names.includes("a") || parsed.names.includes("b"));
    // Known limitation: simple read-modify-write is last-writer-wins, so one concurrent Allow may be lost.
});
