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

class EvictEnv
{
    public static readonly Day = 86400000;

    public static Seed(cache: PackCache, name: string, version: string, ageMs: number | undefined): string
    {
        const root = cache.PathFor(name, version);
        mkdirSync(root, { recursive: true });
        if (ageMs !== undefined)
        {
            writeFileSync(join(root, ".todl-accessed"), String(Date.now() - ageMs));
        }
        return root;
    }
}

test("Evict with MaxVersionsPerPack keeps only the most recently touched versions", async () =>
{
    await Env.With(async cacheDir =>
    {
        const cache = new PackCache(cacheDir);
        const a1 = EvictEnv.Seed(cache, "a", "1.0.0", 3 * EvictEnv.Day);
        const a2 = EvictEnv.Seed(cache, "a", "2.0.0", 2 * EvictEnv.Day);
        const a3 = EvictEnv.Seed(cache, "a", "3.0.0", 1 * EvictEnv.Day);
        const b1 = EvictEnv.Seed(cache, "b", "1.0.0", 5 * EvictEnv.Day);
        const removed = await cache.Evict({ MaxVersionsPerPack: 1 }, new Set<string>());
        assert.deepEqual([...removed].sort(), [a1, a2].sort());
        assert.equal(existsSync(a3), true);
        assert.equal(existsSync(b1), true);
    });
});

test("Evict never removes an in-use root even when it is the oldest", async () =>
{
    await Env.With(async cacheDir =>
    {
        const cache = new PackCache(cacheDir);
        const old = EvictEnv.Seed(cache, "a", "1.0.0", 9 * EvictEnv.Day);
        const mid = EvictEnv.Seed(cache, "a", "2.0.0", 2 * EvictEnv.Day);
        const fresh = EvictEnv.Seed(cache, "a", "3.0.0", 1000);
        const removed = await cache.Evict({ MaxVersionsPerPack: 1, MaxAgeMs: EvictEnv.Day }, new Set<string>([old]));
        assert.equal(existsSync(old), true);
        assert.equal(removed.includes(old), false);
        assert.equal(existsSync(mid), false);
        assert.equal(existsSync(fresh), true);
    });
});

test("Evict with MaxAgeMs removes roots older than the bound unless in use", async () =>
{
    await Env.With(async cacheDir =>
    {
        const cache = new PackCache(cacheDir);
        const stale = EvictEnv.Seed(cache, "a", "1.0.0", 10 * EvictEnv.Day);
        const pinned = EvictEnv.Seed(cache, "b", "1.0.0", 10 * EvictEnv.Day);
        const fresh = EvictEnv.Seed(cache, "c", "1.0.0", 1000);
        const removed = await cache.Evict({ MaxAgeMs: 5 * EvictEnv.Day }, new Set<string>([pinned]));
        assert.deepEqual([...removed], [stale]);
        assert.equal(existsSync(pinned), true);
        assert.equal(existsSync(fresh), true);
    });
});

test("Evict treats a missing marker as oldest and leaves a pack within limits untouched", async () =>
{
    await Env.With(async cacheDir =>
    {
        const cache = new PackCache(cacheDir);
        const unmarked = EvictEnv.Seed(cache, "a", "1.0.0", undefined);
        const marked = EvictEnv.Seed(cache, "a", "2.0.0", 1000);
        const lone = EvictEnv.Seed(cache, "b", "1.0.0", undefined);
        const removed = await cache.Evict({ MaxVersionsPerPack: 1 }, new Set<string>());
        assert.deepEqual([...removed], [unmarked]);
        assert.equal(existsSync(marked), true);
        assert.equal(existsSync(lone), true);
    });
});

test("Evict handles scoped pack names and ignores temp dirs", async () =>
{
    await Env.With(async cacheDir =>
    {
        const cache = new PackCache(cacheDir);
        const s1 = EvictEnv.Seed(cache, "@scope/p", "1.0.0", 2 * EvictEnv.Day);
        const s2 = EvictEnv.Seed(cache, "@scope/p", "2.0.0", 1000);
        mkdirSync(join(cacheDir, ".tmp-xyz"));
        const removed = await cache.Evict({ MaxVersionsPerPack: 1 }, new Set<string>());
        assert.deepEqual([...removed], [s1]);
        assert.equal(existsSync(s2), true);
        assert.equal(existsSync(join(cacheDir, ".tmp-xyz")), true);
    });
});

test("Evict on a missing cache dir removes nothing", async () =>
{
    await Env.With(async cacheDir =>
    {
        const removed = await new PackCache(join(cacheDir, "nope")).Evict({ MaxVersionsPerPack: 1 }, new Set<string>());
        assert.deepEqual([...removed], []);
    });
});

class LockedCache extends PackCache
{
    public constructor(cacheDir: string, private readonly lockedRoot: string)
    {
        super(cacheDir);
    }

    protected override async RemoveTree(root: string): Promise<void>
    {
        if (root === this.lockedRoot)
        {
            throw new Error("EBUSY: resource busy or locked");
        }
        await super.RemoveTree(root);
    }
}

test("Promote stamps the access marker inside the promoted root atomically with the tree", async () =>
{
    await Env.With(async cacheDir =>
    {
        const cache = new PackCache(cacheDir);
        const tmp = join(cacheDir, ".tmp-a");
        Env.Seed(tmp, "first");
        const root = cache.PathFor("p", "1.0.0");
        assert.equal(await cache.Promote(tmp, root), true);
        const stamp = Number(readFileSync(join(root, ".todl-accessed"), "utf8"));
        assert.ok(Number.isFinite(stamp) && stamp > 0, "marker must exist and be a timestamp right after promote");
    });
});

test("Evict does not let an in-use root occupy a keep-slot", async () =>
{
    await Env.With(async cacheDir =>
    {
        const cache = new PackCache(cacheDir);
        const pinned = EvictEnv.Seed(cache, "a", "3.0.0", 1000);
        const idleNew = EvictEnv.Seed(cache, "a", "2.0.0", 2 * EvictEnv.Day);
        const idleOld = EvictEnv.Seed(cache, "a", "1.0.0", 3 * EvictEnv.Day);
        const removed = await cache.Evict({ MaxVersionsPerPack: 1 }, new Set<string>([pinned]));
        assert.deepEqual([...removed], [idleOld]);
        assert.equal(existsSync(pinned), true);
        assert.equal(existsSync(idleNew), true, "the newest idle version keeps the single keep-slot");
    });
});

test("Evict skips an un-removable root without throwing and still removes the others", async () =>
{
    await Env.With(async cacheDir =>
    {
        const seeder = new PackCache(cacheDir);
        const locked = EvictEnv.Seed(seeder, "a", "1.0.0", 9 * EvictEnv.Day);
        const stale = EvictEnv.Seed(seeder, "a", "2.0.0", 8 * EvictEnv.Day);
        const removed = await new LockedCache(cacheDir, locked).Evict({ MaxAgeMs: EvictEnv.Day }, new Set<string>());
        assert.deepEqual([...removed], [stale]);
        assert.equal(existsSync(locked), true);
    });
});

test("Evict ignores a stray file under the cache and under a pack dir, and keeps that pack dir", async () =>
{
    await Env.With(async cacheDir =>
    {
        const cache = new PackCache(cacheDir);
        const stale = EvictEnv.Seed(cache, "a", "1.0.0", 9 * EvictEnv.Day);
        writeFileSync(join(cacheDir, "stray.txt"), "x");
        writeFileSync(join(cacheDir, "a", "notes.txt"), "x");
        const removed = await cache.Evict({ MaxAgeMs: EvictEnv.Day }, new Set<string>());
        assert.deepEqual([...removed], [stale]);
        assert.equal(existsSync(join(cacheDir, "stray.txt")), true);
        assert.equal(existsSync(join(cacheDir, "a", "notes.txt")), true);
    });
});

test("Evict prunes an emptied name dir and an emptied scope dir, but keeps a scope that still has packs", async () =>
{
    await Env.With(async cacheDir =>
    {
        const cache = new PackCache(cacheDir);
        EvictEnv.Seed(cache, "plain", "1.0.0", 9 * EvictEnv.Day);
        EvictEnv.Seed(cache, "@gone/p", "1.0.0", 9 * EvictEnv.Day);
        EvictEnv.Seed(cache, "@kept/p", "1.0.0", 9 * EvictEnv.Day);
        const survivor = EvictEnv.Seed(cache, "@kept/q", "1.0.0", 1000);
        await cache.Evict({ MaxAgeMs: EvictEnv.Day }, new Set<string>());
        assert.equal(existsSync(join(cacheDir, "plain")), false);
        assert.equal(existsSync(join(cacheDir, "@gone")), false);
        assert.equal(existsSync(join(cacheDir, "@kept", "p")), false);
        assert.equal(existsSync(survivor), true);
    });
});
