import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

/** The package's own manifest: the workspace singletons it uses are peers, so a consumer never holds a second copy. */
class Manifest
{
    public static readonly Singletons = ["@pragmatic-tech-ai/todl", "@pragmatic-tech-ai/todl-runtime"];
    public static readonly Data = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "..", "..", "package.json"), "utf8")) as Record<string, Record<string, string> | undefined>;
}

test("todl and todl-runtime are peer dependencies, never dependencies or devDependencies", () =>
{
    for (const singleton of Manifest.Singletons)
    {
        assert.equal(Manifest.Data.dependencies?.[singleton], undefined, `${singleton} is a dependency (consumers would get a nested second copy)`);
        assert.equal(Manifest.Data.devDependencies?.[singleton], undefined, `${singleton} is a devDependency (a production prune would drop the link)`);
        assert.ok(Manifest.Data.peerDependencies?.[singleton] !== undefined, `${singleton} is a peer`);
    }
});

test("declares the Apache-2.0 license", () =>
{
    assert.equal(Manifest.Data.license, "Apache-2.0");
});
