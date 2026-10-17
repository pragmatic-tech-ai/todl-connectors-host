import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { PackCache } from "../pack-cache.js";

class Env
{
    public static async With(fn: (cacheDir: string) => Promise<void>): Promise<void>
    {
        const dir = mkdtempSync(join(tmpdir(), "pack-cache-"));
        try
        {
            await fn(dir);
        }
        finally
        {
            rmSync(dir, { recursive: true, force: true });
        }
    }

    public static Seed(dir: string, marker: string): void
    {
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "marker.txt"), marker);
    }
}

test("PathFor composes cacheDir/name/version", async () =>
{
    await Env.With(async cacheDir =>
    {
        assert.equal(new PackCache(cacheDir).PathFor("@s/p", "1.0.0"), join(cacheDir, "@s/p", "1.0.0"));
    });
});

test("Promote renames tmp into place and Has becomes true", async () =>
{
    await Env.With(async cacheDir =>
    {
        const cache = new PackCache(cacheDir);
        const tmp = join(cacheDir, ".tmp-a");
        Env.Seed(tmp, "first");
        const root = cache.PathFor("p", "1.0.0");
        assert.equal(await cache.Promote(tmp, root), true);
        assert.equal(await cache.Has(root), true);
        assert.equal(existsSync(tmp), false);
    });
});

test("a second Promote into an existing root returns false and keeps the first root", async () =>
{
    await Env.With(async cacheDir =>
    {
        const cache = new PackCache(cacheDir);
        const root = cache.PathFor("p", "1.0.0");
        const winner = join(cacheDir, ".tmp-a");
        const loser = join(cacheDir, ".tmp-b");
        Env.Seed(winner, "first");
        Env.Seed(loser, "second");
        assert.equal(await cache.Promote(winner, root), true);
        assert.equal(await cache.Promote(loser, root), false);
        assert.equal(readFileSync(join(root, "marker.txt"), "utf8"), "first");
        assert.equal(existsSync(loser), true);
        rmSync(loser, { recursive: true, force: true });
    });
});

test("Touch creates the access marker", async () =>
{
    await Env.With(async cacheDir =>
    {
        const cache = new PackCache(cacheDir);
        const root = cache.PathFor("p", "1.0.0");
        mkdirSync(root, { recursive: true });
        await cache.Touch(root);
        assert.ok(existsSync(join(root, ".todl-accessed")));
    });
});

test("Touch on a missing root does not throw", async () =>
{
    await Env.With(async cacheDir =>
    {
        await new PackCache(cacheDir).Touch(join(cacheDir, "gone", "1.0.0"));
    });
});
