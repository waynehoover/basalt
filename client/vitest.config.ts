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
      obsidian: new URL("./src/plugin/stub.ts", import.meta.url).pathname,
    },
  },
  test: {
    globals: true,
    globalSetup: ["./vitest.global-setup.ts"],
    /**
     * Most test files here start real Go servers and talk to them over real
     * sockets. Fifteen files at once means dozens of processes competing for
     * the same cores, and the first thing that gives is a timeout in
     * whichever test was unlucky. Capping this trades a little wall clock
     * for a suite whose failures mean something.
     */
    maxWorkers: 4,
    minWorkers: 1,
    testTimeout: 60_000,
    hookTimeout: 180_000,
    /**
     * The stress suite is not part of `npm test`.
     *
     * It kills processes and builds vaults of hundreds of notes, and it takes
     * minutes rather than seconds. A suite people stop running is worse than a
     * smaller one they run every time, so this stays out of the fast path and
     * `npm run stress` asks for it by name.
     */
    exclude: ["**/node_modules/**", "**/dist/**", "**/*.stress.ts"],
  },
});
