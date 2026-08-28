/**
 * Two bundles from one source tree.
 *
 * The headless client and the Obsidian plugin are the same engine with a
 * different adapter under it, so they are built from the same `src/core` and
 * differ only in their entry point and their platform. Building them separately
 * is what keeps that honest: if something platform-specific leaks into `core`,
 * one of these two builds stops working.
 */

import { build } from "esbuild";

const production = process.argv.includes("production");

/** The headless client, as a single file a person can run. */
const cli = {
    entryPoints: ["src/node/bin.ts"],
    outfile: "dist/basalt.mjs",
    bundle: true,
    platform: "node",
    target: "node20",
    format: "esm",
    // Nothing is external. A self-hosted sync client that needs an npm install
    // before it can run is one more thing to go wrong on the machine you were
    // trying to make reliable.
    banner: { js: "#!/usr/bin/env node" },
    sourcemap: production ? false : "inline",
    minify: false,
    logLevel: "info",
};

await build({ ...cli, ...(production ? {} : {}) });
