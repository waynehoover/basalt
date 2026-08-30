/**
 * Two bundles from one source tree.
 *
 * The headless client and the Obsidian plugin are the same engine with a
 * different adapter under it, so they are built from the same `src/core` and
 * differ only in their entry point and their platform. Building them separately
 * is what keeps that honest: anything platform-specific that leaks into `core`
 * breaks one of these two builds.
 */

import { copyFile, mkdir } from "node:fs/promises";
import { build } from "esbuild";

const production = process.argv.includes("production");

/** The headless client, as one file a person can run. */
const cli = {
    entryPoints: ["src/cli/bin.ts"],
    outfile: "dist/basalt.mjs",
    platform: "node",
    target: "node20",
    format: "esm",
    // Nothing is external. A self-hosted sync client that needs an npm install
    // before it will run is one more thing to go wrong on the machine you were
    // trying to make reliable.
    banner: { js: "#!/usr/bin/env node" },
};

/**
 * The Obsidian plugin.
 *
 * `obsidian` and Electron's built-ins are external because the app provides
 * them. CommonJS because that is what Obsidian loads. Everything else is
 * bundled, including fflate and diff-match-patch, so installing the plugin is
 * copying three files.
 */
const plugin = {
    entryPoints: ["src/plugin/main.ts"],
    outfile: "dist/plugin/main.js",
    platform: "browser",
    target: "es2020",
    format: "cjs",
    external: ["obsidian", "electron", "node:fs", "node:path", "node:os", "node:crypto"],
};

const common = {
    bundle: true,
    logLevel: "info",
    sourcemap: production ? false : "inline",
    // Minified for a release, readable during development. It halves both
    // bundles, 212 KB to 90 KB for the plugin and 198 KB to 85 KB for the
    // client, which is a real difference on a phone loading a plugin at
    // startup. Nothing is hidden by it: the source is MIT and in this
    // repository, and a sourcemap is inlined in a dev build.
    minify: production,
};

await build({ ...common, ...cli });
await build({ ...common, ...plugin });

// The manifest sits beside main.js, because that is how Obsidian loads a
// plugin. Its source is the repository root, because that is where the
// community directory reads it from.
await mkdir("dist/plugin", { recursive: true });
await copyFile("../manifest.json", "dist/plugin/manifest.json");
