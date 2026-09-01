import { defineConfig } from "vitest/config";

/**
 * The stress suite: slow, hostile, and not run on every push.
 *
 * These are the tests that found four defects the 560 unit tests did not, all
 * of them silent. CLAUDE.md puts it plainly: unit tests are necessary here and
 * never sufficient, because every real bug in the predecessor only appeared
 * when the system ran. So this exists, and it is the gate before a release
 * rather than a thing to remember to do.
 *
 * One worker. These start real servers, write hundreds of files and kill
 * processes; running them beside each other would have them competing for the
 * same disk, and the first thing to give would be a timeout that means nothing.
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
    include: ["**/*.stress.ts"],
    maxWorkers: 1,
    minWorkers: 1,
    fileParallelism: false,
    testTimeout: 900_000,
    hookTimeout: 300_000,
  },
});
