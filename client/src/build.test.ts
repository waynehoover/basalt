/**
 * What the two bundles are allowed to contain.
 *
 * The claim this project makes about its client is that the plugin and the
 * headless client are the same engine with a different adapter under them. That
 * claim is easy to make and easy to quietly break: one `import { readFile } from
 * "node:fs"` in `core` and the plugin still compiles, still passes every unit
 * test, and fails the moment somebody loads it in Obsidian, on a platform this
 * machine cannot run.
 *
 * So the bundles are built and read. A `node:` import reaching the plugin is the
 * exact regression, and it is invisible in every other test here.
 */

import { execFile } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { promisify } from "node:util";
import { beforeAll, describe, expect, it } from "vitest";

const run = promisify(execFile);
const CLI = "dist/basalt.mjs";
const PLUGIN = "dist/plugin/main.js";

let plugin = "";
let cli = "";

beforeAll(async () => {
    await rm("dist", { recursive: true, force: true });
    await run("node", ["esbuild.config.mjs", "production"]);
    plugin = await readFile(PLUGIN, "utf8");
    cli = await readFile(CLI, "utf8");
}, 180_000);

describe("the plugin bundle", () => {
    it("needs nothing but Obsidian", async () => {
        const required = [...plugin.matchAll(/require\("([^"]+)"\)/g)].map((m) => m[1]);
        expect([...new Set(required)]).toEqual(["obsidian"]);
    });

    /**
     * The one that matters. Obsidian runs on Android and iOS, where there is no
     * `node:fs` to import, and a plugin that references one fails to load rather
     * than failing a feature.
     */
    it("has no trace of Node in it", () => {
        expect(plugin).not.toMatch(/node:(fs|path|os|crypto|child_process|util)/);
        expect(plugin).not.toMatch(/\bJsonIndexStore\b/);
        expect(plugin).not.toMatch(/\bNodeVault\b/);
    });

    it("brings its dependencies with it", () => {
        // fflate and diff-match-patch are bundled, so installing the plugin is
        // copying two files rather than running npm somewhere.
        expect(plugin).toMatch(/diff_match_patch/);
        expect(plugin.length).toBeGreaterThan(50_000);
    });

    it("ships a manifest beside it", async () => {
        const manifest = JSON.parse(await readFile("dist/plugin/manifest.json", "utf8")) as Record<string, unknown>;
        expect(manifest["id"]).toBe("basalt");
        // Mobile is not tested, but a manifest that declares desktop-only would
        // make sure it never could be.
        expect(manifest["isDesktopOnly"]).toBe(false);
    });
});

describe("the headless bundle", () => {
    it("runs, and says what it is", async () => {
        const { stdout } = await run("node", [CLI, "--help"]);
        expect(stdout).toMatch(/basalt sync/);
        expect(stdout).toMatch(/basalt pair/);
    });

    it("has a shebang, once", () => {
        expect(cli.startsWith("#!/usr/bin/env node\n")).toBe(true);
        expect(cli.split("\n").filter((l) => l.startsWith("#!")).length).toBe(1);
    });

    it("needs no npm install beside it", async () => {
        // Every import is either bundled or a Node built-in. Anything else means
        // the single file is not a single file.
        //
        // Checked against Node's own list rather than a `node:` prefix, because
        // esbuild emits a bare `import { createRequire } from "module"` to load
        // the one dependency that is still CommonJS.
        const { builtinModules } = await import("node:module");
        const builtin = new Set([...builtinModules, ...builtinModules.map((m) => `node:${m}`)]);
        const external = [...cli.matchAll(/(?:^|[;\n])\s*import\s[^"'\n]*from\s*"([^"\n]+)"/g)].map((m) => m[1]!);
        for (const name of new Set(external)) {
            expect(builtin.has(name), `${name} is not a Node built-in`).toBe(true);
        }
    });

    it("exits 2 on a command line it does not understand", async () => {
        await expect(run("node", [CLI, "--nonsense"])).rejects.toMatchObject({ code: 2 });
    });
});
