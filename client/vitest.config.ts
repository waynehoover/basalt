import { defineConfig } from "vitest/config";

/**
 * `obsidian` has no runtime.
 *
 * The npm package is type declarations only, because Obsidian itself provides
 * the implementation to a loaded plugin. So the plugin's own code could not be
 * run, only compiled, and "cannot be run" was turning into "is not tested".
 *
 * This aliases the module to a stub, for tests only. `tsconfig.json` has no such
 * alias, so `tsc` still checks every call against the real `obsidian.d.ts`, and
 * `esbuild.config.mjs` still marks it external so the shipped plugin gets the
 * real one. Types from the declarations, behaviour from the stub, and neither
 * one is the thing being tested.
 */
export default defineConfig({
    resolve: {
        alias: {
            obsidian: new URL("./src/obsidian/stub.ts", import.meta.url).pathname,
        },
    },
    test: {
        globals: true,
    },
});
