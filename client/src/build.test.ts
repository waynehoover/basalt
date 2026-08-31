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
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { cleanupBinary, removeTree, serverBinary, TestServer } from "./core/test-server.ts";
import * as stub from "./plugin/stub.ts";
import type { Plugin as StubPlugin } from "./plugin/stub.ts";

const run = promisify(execFile);
const CLI = "dist/basalt.mjs";
const PLUGIN = "dist/plugin/main.js";

let plugin = "";
let cli = "";

beforeAll(async () => {
  await removeTree("dist");
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

  /**
   * The stub and the fake exist so the plugin can be tested at all. They must
   * never ship: a bundle carrying its own `DataAdapter` would be a plugin that
   * could quietly talk to the wrong one.
   */
  it("carries none of the scaffolding that made it testable", () => {
    expect(plugin).not.toMatch(/FakeAdapter/);
    expect(plugin).not.toMatch(/class FakeEl/);
    expect(plugin).not.toMatch(/resetStub/);
    // And the real module is still expected to come from outside.
    expect(plugin).toMatch(/require\("obsidian"\)/);
  });

  it("brings its dependencies with it", () => {
    // fflate and diff-match-patch are bundled, so installing the plugin is
    // copying two files rather than running npm somewhere.
    expect(plugin).toMatch(/diff_match_patch/);
    expect(plugin.length).toBeGreaterThan(50_000);
  });

  it("ships a manifest beside it", async () => {
    const manifest = JSON.parse(await readFile("dist/plugin/manifest.json", "utf8")) as Record<
      string,
      unknown
    >;
    expect(manifest["id"]).toBe("basalt-sync");
    expect(manifest["isDesktopOnly"]).toBe(false);

    // The shipped manifest has to be the repository's own, because the
    // community directory reads that one and Obsidian installs this one. If
    // they drifted, the directory would list a version nobody receives.
    const root = JSON.parse(await readFile("../manifest.json", "utf8")) as Record<string, unknown>;
    expect(manifest).toEqual(root);

    // The tag a release is cut at has to be exactly this, so a version that
    // is not plain x.y.z cannot be submitted at all.
    expect(String(manifest["version"])).toMatch(/^\d+\.\d+\.\d+$/);
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
    const external = [...cli.matchAll(/(?:^|[;\n])\s*import\s[^"'\n]*from\s*"([^"\n]+)"/g)].map(
      (m) => m[1]!,
    );
    for (const name of new Set(external)) {
      expect(builtin.has(name), `${name} is not a Node built-in`).toBe(true);
    }
  });

  it("exits 2 on a command line it does not understand", async () => {
    await expect(run("node", [CLI, "--nonsense"])).rejects.toMatchObject({ code: 2 });
  });
});

/**
 * The bundle, actually run.
 *
 * Everything else in this project tests source. This loads the file that would
 * be copied into a vault, hands it the stub in place of Obsidian, and pairs two
 * of them against a real server. It is as close to installing the plugin as it
 * is possible to get without Obsidian.
 *
 * It has caught the class of thing only a bundle can get wrong: an entry point
 * that exports the wrong shape, a dependency that did not survive bundling, a
 * top-level statement that throws on load. None of those are visible in a test
 * that imports the source.
 */
describe("the plugin bundle, loaded and run", () => {
  let server: TestServer;

  beforeAll(async () => {
    await serverBinary();
  }, 180_000);

  afterEach(async () => {
    if (server) await server.cleanup();
  });

  afterAll(async () => {
    await cleanupBinary();
  });

  /**
   * Evaluates the CommonJS bundle with a `require` that only knows `obsidian`.
   *
   * Anything else it asks for is an error rather than a silent resolution, so
   * a dependency that failed to bundle shows up here as a name instead of as a
   * mystery in somebody's vault.
   */
  function loadBundle(): new (
    app: unknown,
    manifest: unknown,
  ) => StubPlugin & {
    onload(): Promise<void>;
    onunload(): void;
    pairFirst(url: string, token: string, device: string): Promise<string>;
    pair(pairing: string, device: string): Promise<void>;
    invite(): string | undefined;
    currentState: { kind: string };
  } {
    const mod: { exports: Record<string, unknown> } = { exports: {} };
    const factory = new Function("require", "module", "exports", plugin);
    factory(
      (name: string) => {
        if (name === "obsidian") return stub;
        throw new Error(`the bundle asked for ${name}, which will not be there`);
      },
      mod,
      mod.exports,
    );
    const exported = mod.exports["default"];
    if (typeof exported !== "function") {
      throw new Error(
        `the bundle's default export is ${typeof exported}, and Obsidian needs a class`,
      );
    }
    return exported as never;
  }

  it("exports something Obsidian can construct", () => {
    const Built = loadBundle();
    const app = new stub.App();
    const instance = new Built(app, { id: "basalt", dir: ".obsidian/plugins/basalt" });
    expect(instance).toBeInstanceOf(stub.Plugin);
  });

  it("pairs two vaults and syncs a note between them", async () => {
    server = new TestServer();
    await server.start();
    stub.resetStub();
    const Built = loadBundle();

    const appA = new stub.App();
    const a = new Built(appA, { id: "basalt", dir: ".obsidian/plugins/basalt" });
    const appB = new stub.App();
    const b = new Built(appB, { id: "basalt", dir: ".obsidian/plugins/basalt" });

    try {
      await a.onload();
      await b.onload();
      appA.vault.adapter.seed("From the bundle.md", "# Built\n\nThis came out of dist.\n");

      const pairing = await a.pairFirst(server.wsUrl, server.token, "laptop");
      await until(() => a.currentState.kind === "synced");

      await b.pair(pairing, "desktop");
      await until(() => appB.vault.adapter.text("From the bundle.md") !== undefined, 25_000);

      expect(appB.vault.adapter.text("From the bundle.md")).toBe(
        "# Built\n\nThis came out of dist.\n",
      );
      // And its own state stayed out of the vault it was syncing.
      expect(appB.vault.adapter.filePaths().filter((p) => !p.startsWith(".obsidian/"))).toEqual([
        "From the bundle.md",
      ]);
    } finally {
      a.onunload();
      b.onunload();
    }
  }, 300_000);
});

async function until(cond: () => boolean, ms = 20_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("timed out");
}
