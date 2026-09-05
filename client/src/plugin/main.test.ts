/**
 * The plugin, run.
 *
 * `main.ts` was written to be the one file no test could reach: it imports
 * `obsidian`, and the npm package is type declarations with no runtime. That is
 * a reason it is hard to test, not a reason it is fine untested, and the shell
 * is where a sync client's setup bugs live.
 *
 * So `stub.ts` supplies the runtime, `vitest.config.ts` aliases the module to it
 * for tests only, and everything below is the real plugin: real pairing, real
 * engine, real WebSocket, real Go server. `tsc` still checks `main.ts` against
 * the genuine declarations, and the shipped bundle still gets Obsidian's own
 * implementation.
 *
 * What this cannot tell you is whether Obsidian calls `onload` when this expects
 * or draws what this builds. That needs Obsidian.
 */

import type { App as ObsidianApp, PluginManifest } from "obsidian";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { TestServer, cleanupBinary, serverBinary } from "../core/test-server.ts";
import {
  App,
  type FakeEl,
  Platform,
  Plugin as StubPlugin,
  built,
  modals,
  notices,
  resetStub,
} from "./stub.ts";
import BasaltPlugin, { connectionDetail, describeConnection, describeDeleted } from "./main.ts";
import { describeRestore } from "./history.ts";
import type { SyncReport } from "../core/engine.ts";
import { redeemInvite } from "../core/client.ts";
import { parseInvite } from "../core/pairing.ts";

beforeAll(async () => {
  await serverBinary();
}, 180_000);

afterAll(async () => {
  await cleanupBinary();
});

/**
 * A plugin wired to the stub.
 *
 * The casts are the seam and there is no way around them: `main.ts` is typed
 * against the real declarations, on purpose, and the stub is a different class
 * that happens to have the same shape. Doing it in one place keeps it honest.
 */
type Testable = BasaltPlugin & StubPlugin;

/**
 * The recovery key `pairFirst` returned, kept for the tests that add a second
 * device with it.
 *
 * It is shown once and no device holds it: a device that did could re-derive
 * the vault's credential and register itself again after being revoked, so
 * revoking it would stop nothing. These tests therefore write it down, which
 * is what a person is told to do.
 */
const writtenDown = new WeakMap<object, string>();
async function startVault(plugin: Testable, name = "laptop", setup?: string): Promise<string> {
  const key = await plugin.pairFirst(setup ?? server.setup, name);
  writtenDown.set(plugin, key);
  return key;
}
const keyOf = (plugin: Testable): string => {
  const key = writtenDown.get(plugin);
  if (key === undefined) throw new Error("this vault was not started by startVault");
  return key;
};

function makePlugin(
  app: App,
  manifest: { id: string; dir?: string } = { id: "basalt", dir: ".obsidian/plugins/basalt" },
): Testable {
  return new BasaltPlugin(
    app as unknown as ObsidianApp,
    manifest as unknown as PluginManifest,
  ) as unknown as Testable;
}

let server: TestServer;
const loaded: Testable[] = [];

beforeEach(() => {
  resetStub();
});

afterEach(async () => {
  const closing: Promise<void>[] = [];
  while (loaded.length) {
    const p = loaded.pop()!;
    p.onunload();
    if (p.closing) closing.push(p.closing);
  }
  await Promise.all(closing);
  if (server) await server.cleanup();
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fresh(): Promise<void> {
  server = new TestServer();
  await server.start();
}

/** Loads a plugin, and returns it and its app. */
async function load(
  saved: unknown = null,
  manifest?: { id: string; dir?: string },
  configDir?: string,
  /** A chance to make the host look like an older Obsidian before onload. */
  beforeLoad?: (plugin: Testable) => void,
): Promise<{ plugin: Testable; app: App }> {
  const app = new App();
  if (configDir !== undefined) app.vault.configDir = configDir;
  const plugin = makePlugin(app, manifest);
  plugin.savedData = saved;
  loaded.push(plugin);
  beforeLoad?.(plugin);
  await plugin.onload();
  return { plugin, app };
}

/** Waits for something to become true, or explains what it was waiting for. */
async function until(what: string, cond: () => boolean, ms = 20_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out waiting for ${what}`);
}

const synced = (p: Testable) =>
  until("a sync", () => p.currentState.kind === "synced").catch((err: Error) => {
    throw new Error(`${err.message}; the state is ${JSON.stringify(p.currentState)}`);
  });
/**
 * What the status bar says, which is now a tooltip rather than text: the item
 * itself is a glyph the size of its neighbours.
 */
const status = (p: Testable) => p.statusBarItems[0]?.attributes.get("aria-label") ?? "";

/**
 * Every `?` tooltip in the panel that is open, joined.
 *
 * Each description in the panel is one line now, and the detail that used to
 * be inside them is on an `aria-label` beside the section it belongs to, which
 * is what Obsidian draws as a hover tooltip. The assertions that used to read
 * a `desc` and now read this did not go anywhere: they followed their sentence.
 * Deleting them instead would have made the cut unfalsifiable.
 */
const tooltips = (): string => {
  const found: string[] = [];
  const walk = (el: FakeEl): void => {
    const label = el.attributes.get("aria-label");
    if (label !== undefined) found.push(label);
    for (const child of el.children) walk(child);
  };
  const modal = modals.at(-1);
  if (modal) walk(modal.contentEl);
  return found.join("\n");
};

/** Which glyph it chose, which is the other half of what it says. */
const statusIcon = (p: Testable) =>
  p.statusBarItems[0]?.children
    .find((c) => c.cls.includes("basalt-status-icon"))
    ?.attributes.get("data-icon") ?? "";

describe("loading", () => {
  it("comes up unpaired, and says so", async () => {
    const { plugin } = await load();
    expect(plugin.paired).toBe(false);
    expect(status(plugin)).toBe("Basalt Sync: Not paired.");
    expect(statusIcon(plugin)).toBe("link");
  });

  it("registers the things a plugin registers", async () => {
    const { plugin, app } = await load();
    expect(plugin.commands.map((c) => c.id).sort()).toEqual([
      "recover-deleted",
      "show-status",
      "sync-now",
      "version-history",
    ]);
    expect(plugin.ribbonIcons.map((r) => r.title)).toEqual(["Basalt Sync"]);
    expect(plugin.statusBarItems.length).toBe(1);
    // create, modify, delete, rename. Without these it only syncs on a timer.
    expect(app.vault.handlerCount()).toBe(4);
    // Those four, plus the file-menu entry that puts history where somebody
    // already looks for it.
    expect(plugin.registeredEvents.length).toBe(5);
    expect([...plugin.cliHandlers.keys()].sort()).toEqual(["basalt:history", "basalt:restore"]);
  });

  /**
   * Obsidian's own documentation: "If you do not wish to receive create events
   * on vault load, register your event handler inside
   * Workspace.onLayoutReady". Registering earlier means opening a vault fires
   * a create for every file in it.
   */
  it("waits for the layout before listening for file events", async () => {
    const app = new App();
    app.workspace.layoutReady = false;
    const plugin = makePlugin(app);
    loaded.push(plugin);
    await plugin.onload();

    expect(app.vault.handlerCount(), "listening before the layout was ready").toBe(0);
    app.workspace.finishLayout();
    expect(app.vault.handlerCount()).toBe(4);
  });

  /**
   * Rule 2, and the incident behind it: code that read a config, fell back to
   * an empty result on error and wrote that back disabled every plugin on a
   * device. Here the fallback would be worse: an unreadable config read as
   * "unpaired" means the next pairing generates a new root secret, and
   * everything already on the server stops being decryptable on this device.
   */
  it("refuses to start over from a config it cannot read", async () => {
    const { plugin } = await load({ url: "ws://x", token: "t", vaultId: "default", device: "d" });
    expect(plugin.paired).toBe(false);
    expect(plugin.currentState.kind).toBe("stopped");
    expect(notices.map((n) => n.message).join(" ")).toMatch(
      /neither the vault's recovery key nor this device's own credential/,
    );
    // And it did not quietly overwrite the config it could not read.
    expect(plugin.savedData).toEqual({
      url: "ws://x",
      token: "t",
      vaultId: "default",
      device: "d",
    });
  });

  it("refuses a stored secret of the wrong length", async () => {
    const { plugin } = await load({
      url: "ws://x",
      token: "t",
      vaultId: "default",
      device: "d",
      secret: "AAAA",
    });
    expect(plugin.currentState.kind).toBe("stopped");
    expect(notices.map((n) => n.message).join(" ")).toMatch(/root secret is 32 bytes/);
  });
});

describe("where its own state goes", () => {
  /**
   * The index must land inside Obsidian's config folder, which never syncs. An
   * index that synced would sync to itself, and every device would overwrite
   * every other device's idea of what had been synced.
   */
  it("keeps the index inside the config folder", async () => {
    await fresh();
    const { plugin, app } = await load();
    app.vault.adapter.seed("note.md", "x");
    await startVault(plugin, "laptop");
    await synced(plugin);

    expect(app.vault.adapter.filePaths()).toContain(".obsidian/plugins/basalt/index.json");
    // Nothing of the plugin's leaked into the vault proper.
    const inVault = app.vault.adapter.filePaths().filter((p) => !p.startsWith(".obsidian/"));
    expect(inVault).toEqual(["note.md"]);
  }, 300_000);

  it("follows a vault that calls its config folder something else", async () => {
    await fresh();
    const { plugin, app } = await load(
      null,
      { id: "basalt", dir: ".my-config/plugins/basalt" },
      ".my-config",
    );
    app.vault.adapter.seed("note.md", "x");
    await startVault(plugin, "laptop");
    await synced(plugin);

    expect(app.vault.adapter.filePaths()).toContain(".my-config/plugins/basalt/index.json");
    expect(app.vault.adapter.filePaths().filter((p) => !p.startsWith(".my-config/"))).toEqual([
      "note.md",
    ]);
  }, 300_000);

  /**
   * `manifest.dir` is optional in Obsidian's API. Interpolating it without
   * looking produces "undefined/index.json" at the vault root, which the
   * never-sync list has no reason to skip, so the index would be uploaded and
   * then fought over by every device.
   */
  it("works out where it lives when Obsidian does not say", async () => {
    await fresh();
    const { plugin, app } = await load(null, { id: "basalt" });
    app.vault.adapter.seed("note.md", "x");
    await startVault(plugin, "laptop");
    await synced(plugin);

    expect(app.vault.adapter.filePaths()).toContain(".obsidian/plugins/basalt/index.json");
    expect(app.vault.adapter.filePaths().some((p) => p.startsWith("undefined"))).toBe(false);
  }, 300_000);

  it("refuses to run from outside the config folder", async () => {
    // And says so. The loop that assembles the client runs detached, so
    // without somewhere for this to land the plugin would simply never
    // sync, with a status bar still saying "connecting".
    await fresh();
    const { plugin } = await load(null, { id: "basalt", dir: "somewhere/else" });
    await startVault(plugin, "laptop");
    await until("it to give up", () => plugin.currentState.kind === "stopped");
    expect(notices.map((n) => n.message).join(" ")).toMatch(/would sync/);
    expect(statusIcon(plugin)).toBe("alert-triangle");
    expect(status(plugin)).toMatch(/^Basalt Sync: Stopped:/);
  }, 300_000);
});

describe("pairing", () => {
  it("starts a vault, and syncs it", async () => {
    await fresh();
    const { plugin, app } = await load();
    app.vault.adapter.seed("note.md", "# Hello\n");

    const pairing = await startVault(plugin, "laptop");
    expect(pairing).toMatch(/^basalt3_/);
    await synced(plugin);

    expect(plugin.paired).toBe(true);
    expect(plugin.deviceName).toBe("laptop");
    expect(statusIcon(plugin)).toBe("check");
    expect(status(plugin)).toMatch(/^Basalt Sync: 1 sent, as of /);
    // Saved in a form that survives the JSON round trip Obsidian does.
    // No token: the vault has one secret, and what authenticates is derived
    // from it. The server's first-run token is kept only until the vault has
    // been claimed with it, and by now it has.
    await until("the spent bootstrap to be dropped", () => {
      const saved = plugin.savedData as Record<string, unknown> | null;
      return saved !== null && saved["bootstrap"] === undefined;
    });
    // What is left is this device's own credential and the data key it reads
    // with. Not the vault's root: a device that held it could register itself
    // again after being revoked, so revoking would stop nothing.
    expect(Object.keys(plugin.savedData as object).sort()).toEqual([
      "dataKey",
      "device",
      "deviceId",
      "deviceSecret",
      "url",
      "vaultId",
    ]);
  }, 300_000);

  it("joins a vault another device started", async () => {
    await fresh();
    const first = await load();
    first.app.vault.adapter.seed("note.md", "# Hello\n");
    const pairing = await startVault(first.plugin, "laptop");
    await synced(first.plugin);

    const second = await load();
    await second.plugin.pair(pairing, "desktop");
    await synced(second.plugin);
    await until("the note to arrive", () => second.app.vault.adapter.text("note.md") !== undefined);

    expect(second.app.vault.adapter.text("note.md")).toBe("# Hello\n");
    expect(second.plugin.deviceName).toBe("desktop");
  }, 300_000);

  it("comes back paired after a restart", async () => {
    await fresh();
    const first = await load();
    first.app.vault.adapter.seed("note.md", "x");
    await startVault(first.plugin, "laptop");
    await synced(first.plugin);
    const saved = first.plugin.savedData;
    first.plugin.onunload();

    // Same data.json, a fresh plugin object. It must not ask to be paired.
    const again = await load(saved);
    expect(again.plugin.paired).toBe(true);
    await synced(again.plugin);
    expect(again.plugin.currentState.kind).toBe("synced");
  }, 300_000);

  /**
   * Re-pairing would replace the root secret. Everything already on the server
   * would stop being decryptable here, the vault would look empty, and the
   * local copies would then be uploaded under new keys. There is no coming
   * back from that.
   */
  it("refuses to pair a vault that is already paired", async () => {
    await fresh();
    const { plugin } = await load();
    const pairing = await startVault(plugin, "laptop");
    await synced(plugin);

    await expect(startVault(plugin, "again")).rejects.toThrow(/already paired/);
    await expect(plugin.pair(pairing, "again")).rejects.toThrow(/already paired/);
  }, 300_000);

  it("refuses a pairing string that was mangled", async () => {
    const { plugin } = await load();
    await expect(plugin.pair("hello", "d")).rejects.toThrow(/basalt3_/);
    expect(plugin.paired).toBe(false);
    expect(plugin.savedData).toBe(null);
  });

  it("needs a server to start a vault against", async () => {
    const { plugin } = await load();
    await expect(plugin.pairFirst("#token", "d")).rejects.toThrow(/server address/);
    await expect(plugin.pairFirst("ws://host#  ", "d")).rejects.toThrow(/token/);
    await expect(plugin.pairFirst("ws://host", "d")).rejects.toThrow(/host:3003#TOKEN/);
    expect(plugin.paired).toBe(false);
  });

  /**
   * The key is shown once and no device keeps it. That is the feature rather
   * than a gap: a device holding the root could re-derive the vault's
   * credential and register itself again after being revoked, so revoking
   * would stop nothing. The panel says so where the key used to be.
   */
  it("does not keep the recovery key, and the panel says why", async () => {
    await fresh();
    const { plugin } = await load();
    await startVault(plugin, "laptop");
    await synced(plugin);

    const stored = plugin.savedData as Record<string, string>;
    expect(stored["secret"], "the root secret is on this device").toBeUndefined();
    expect(stored["deviceId"]).toMatch(/^[A-Za-z0-9_-]+$/);

    built.length = 0;
    plugin.ribbonIcons[0]!.callback();
    const row = built.find((s) => s.name === "Recovery key")!;
    expect(tooltips()).toMatch(/not kept here/);
    // And the reason, on the section's `?`, where the sentence went.
    expect(tooltips()).toMatch(/not on this device and cannot be shown again/);
    // And no button, because there is nothing for one to do.
    expect(row.buttons, "the panel offers to show a key it does not have").toEqual([]);
  }, 300_000);
});

describe("syncing while it runs", () => {
  it("syncs when Obsidian says a file changed", async () => {
    await fresh();
    const a = await load();
    await startVault(a.plugin, "laptop");
    await synced(a.plugin);

    const b = await load();
    await b.plugin.pair(keyOf(a.plugin), "desktop");
    await synced(b.plugin);

    // A note appears, and Obsidian says so. Nothing else prompts a sync
    // here: the 30 second backstop would not have fired yet.
    const before = a.plugin.currentState;
    a.app.vault.adapter.seed("fresh.md", "written just now");
    a.app.vault.fire("create");

    // The nudge coalesces for 400ms before it looks, so this waits for the
    // state to move rather than for a state it is already in.
    await until("A to act on the event", () => a.plugin.currentState !== before);

    // B has to be told. Its own backstop is 30 seconds away, so it is asked.
    for (let i = 0; i < 10 && b.app.vault.adapter.text("fresh.md") === undefined; i++) {
      await b.plugin.syncNow();
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(b.app.vault.adapter.text("fresh.md")).toBe("written just now");
  }, 300_000);

  it("says what happened when asked to sync", async () => {
    await fresh();
    const { plugin, app } = await load();
    await startVault(plugin, "laptop");
    await synced(plugin);

    app.vault.adapter.seed("another.md", "x");
    notices.length = 0;
    // Obsidian's Command.callback returns void, so the command can only
    // start the work. Waiting for the notice is waiting for the same thing
    // a person waits for.
    await plugin.runCommand("sync-now");
    await until("the command to report", () => notices.length > 0);
    expect(notices.map((n) => n.message).join(" ")).toMatch(/sent|up to date/);
  }, 300_000);

  it("says so rather than nothing when it is not paired", async () => {
    const { plugin } = await load();
    await plugin.runCommand("sync-now");
    await until("the command to report", () => notices.length > 0);
    expect(notices.map((n) => n.message).join(" ")).toMatch(/not paired/);
  });

  /**
   * A conflict is one of two outcomes that do not resolve themselves, and a
   * status bar nobody is looking at is not how somebody finds out about it.
   */
  it("tells the user when it kept both versions", async () => {
    await fresh();
    const a = await load();
    a.app.vault.adapter.seed("note.md", "# Note\n\nThe original sentence.\n");
    await startVault(a.plugin, "laptop");
    await synced(a.plugin);

    const b = await load();
    await b.plugin.pair(keyOf(a.plugin), "desktop");
    await synced(b.plugin);
    await until("the note to arrive", () => b.app.vault.adapter.text("note.md") !== undefined);

    a.app.vault.adapter.seed(
      "note.md",
      "# Note\n\nA's completely different sentence.\n",
      9_000_000_000_000,
    );
    b.app.vault.adapter.seed(
      "note.md",
      "# Note\n\nB's entirely other sentence.\n",
      9_000_000_000_000,
    );
    notices.length = 0;
    for (let i = 0; i < 5; i++) {
      await a.plugin.syncNow();
      await b.plugin.syncNow();
    }

    const said = notices.map((n) => n.message).join(" ");
    expect(said, `notices were: ${said}`).toMatch(/Conflicted copy/);
    const all = b.app.vault.adapter
      .filePaths()
      .filter((p) => !p.startsWith(".obsidian/"))
      .map((p) => b.app.vault.adapter.text(p))
      .join("\n");
    expect(all).toContain("A's completely different sentence");
    expect(all).toContain("B's entirely other sentence");
  }, 300_000);
});

describe("when things go wrong", () => {
  /**
   * A dead connection has to be forgotten, not just noticed.
   *
   * The loop clears the client when a connection ends. If it did not, "sync
   * now" would reach for a socket that is gone: the person would get an
   * exception rather than a sentence, and the plugin would look broken rather
   * than offline.
   */
  it("says it is offline rather than reaching for a dead connection", async () => {
    await fresh();
    const { plugin } = await load();
    await startVault(plugin, "laptop");
    await synced(plugin);

    await server.cleanup();
    await until("it to notice", () => plugin.currentState.kind === "offline");

    notices.length = 0;
    await plugin.syncNow();
    expect(notices.map((n) => n.message).join(" ")).toMatch(/not connected/);
    expect(statusIcon(plugin)).toBe("cloud-off");
    expect(status(plugin)).toMatch(/^Basalt Sync: Offline:/);
  }, 300_000);

  /**
   * A file the server will refuse for the same reason every time.
   *
   * The engine stops retrying it, which is right: retrying forever is noise
   * that hides everything else. But a file that will never sync and nobody
   * mentions is a note quietly left behind, so it is said out loud. This uses
   * a path past the server's limit, which is the cheapest permanent refusal
   * there is.
   */
  it("says out loud when a file can never sync", async () => {
    await fresh();
    const { plugin, app } = await load();
    app.vault.adapter.seed("fine.md", "this one is ok");
    app.vault.adapter.seed(`${"far/".repeat(1200)}too-deep.md`, "this one is not");

    await startVault(plugin, "laptop");
    await synced(plugin);
    // Said once, when the refusal first appears (P5), so it is looked for
    // rather than provoked again.
    await until("the refusal to be announced", () =>
      notices.some((n) => /cannot sync/.test(n.message)),
    );
    await plugin.syncNow();
    // And the refusal did not stop the file that was fine, and the status
    // says the vault needs a person (P33). One phrase, not three: "stuck",
    // "ignored" and "in the way" were three words a person had to learn before
    // the status could be read, and what differs between them is the reason,
    // which the notice above carries.
    expect(status(plugin)).toMatch(/need attention/);
    expect(status(plugin)).toMatch(/files? need attention\./);
  }, 300_000);
});

describe("recovering a deleted note from the app", () => {
  it("lists what the server still has, and puts one back", async () => {
    await fresh();
    const { plugin, app } = await load();
    app.vault.adapter.seed("keep.md", "still here");
    app.vault.adapter.seed("gone.md", "# Gone\n\nBut not forgotten.\n");
    await startVault(plugin, "laptop");
    await synced(plugin);

    await app.vault.adapter.remove("gone.md");
    await plugin.syncNow();
    expect(app.vault.adapter.text("gone.md")).toBeUndefined();

    built.length = 0;
    notices.length = 0;
    await plugin.runCommand("recover-deleted");
    await until(
      "the list to load",
      () => modals.at(-1)!.contentEl.allText().length > "Deleted notes".length,
      15_000,
    );
    const row = built.find((s) => s.name === "gone.md");
    expect(row, `the modal said: ${modals.at(-1)!.contentEl.allText()}`).toBeDefined();
    expect(built.map((s) => s.name)).not.toContain("keep.md");
    await row!.buttons[0]!.click();

    await until("the note to come back", () => app.vault.adapter.text("gone.md") !== undefined);
    expect(app.vault.adapter.text("gone.md")).toBe("# Gone\n\nBut not forgotten.\n");
    expect(notices.map((n) => n.message).join(" ")).toMatch(/Restored/);
  }, 300_000);

  it("says nothing has been deleted when nothing has", async () => {
    await fresh();
    const { plugin, app } = await load();
    app.vault.adapter.seed("keep.md", "here");
    await startVault(plugin, "laptop");
    await synced(plugin);

    await plugin.runCommand("recover-deleted");
    await until("the list to load", () =>
      modals.at(-1)!.contentEl.allText().includes("Nothing has been"),
    );
    expect(modals.at(-1)!.contentEl.allText()).toMatch(/Nothing has been deleted/);
  }, 300_000);

  /**
   * An empty list and an unanswerable question look identical on screen and
   * mean opposite things. Somebody opening this has already lost a note.
   */
  it("says it could not ask, rather than showing an empty list", async () => {
    await fresh();
    const { plugin } = await load();
    await startVault(plugin, "laptop");
    await synced(plugin);
    await server.cleanup();
    await until("it to notice", () => plugin.currentState.kind === "offline");

    await plugin.runCommand("recover-deleted");
    await until("the modal to answer", () =>
      modals.at(-1)!.contentEl.allText().includes("Cannot ask"),
    );
    const shown = modals.at(-1)!.contentEl.allText();
    expect(shown).toMatch(/Cannot ask the server/);
    expect(shown).not.toMatch(/Nothing has been deleted/);
  }, 300_000);
});

describe("renames, which only Obsidian can report", () => {
  /**
   * A rename has to travel as one operation.
   *
   * A filesystem scan cannot see one: it finds a path gone and another
   * arrived and has nothing connecting them, which is why the headless client
   * reports a rename as a deletion. Obsidian does know, and hands the old path
   * to its rename event, and until that was wired up the engine was never told
   * either. Every rename then retired the old path as a deletion, and the list
   * of deleted notes filled with phantoms of files that still exist.
   */
  it("tells the engine the old path, so it is one operation and not two", async () => {
    await fresh();
    const { plugin, app } = await load();
    app.vault.adapter.seed("old-name.md", "the same content throughout");
    await startVault(plugin, "laptop");
    await synced(plugin);

    // Obsidian moves the file and says so, old path included.
    await app.vault.adapter.rename("old-name.md", "new-name.md");
    app.vault.fire("rename", { path: "new-name.md" }, "old-name.md");
    for (let i = 0; i < 4; i++) await plugin.syncNow();

    // The server knows it was a rename, so the old path is not offered as
    // something to recover.
    const client = (
      plugin as unknown as { client?: { deleted(): Promise<{ notes: { path: string }[] }> } }
    ).client;
    const gone = (await client!.deleted()).notes.map((v) => v.path);
    expect(gone, `deleted list was ${JSON.stringify(gone)}`).not.toContain("old-name.md");
  }, 300_000);

  it("still moves the file when nothing told it the old path", async () => {
    // The delete-plus-add path, which is what happens on any platform that
    // cannot report a rename. Noisier, and it must still not lose anything.
    await fresh();
    const { plugin, app } = await load();
    app.vault.adapter.seed("before.md", "content that moves");
    await startVault(plugin, "laptop");
    await synced(plugin);

    await app.vault.adapter.rename("before.md", "after.md");
    await plugin.syncNow();
    await plugin.syncNow();

    const client = (
      plugin as unknown as { client?: { deleted(): Promise<{ notes: { path: string }[] }> } }
    ).client;
    const gone = (await client!.deleted()).notes.map((v) => v.path);
    expect(gone).toContain("before.md");
    expect(app.vault.adapter.text("after.md")).toBe("content that moves");
  }, 300_000);
});

describe("unlinking", () => {
  it("forgets the pairing and keeps every note", async () => {
    await fresh();
    const { plugin, app } = await load();
    app.vault.adapter.seed("keep.md", "still here");
    await startVault(plugin, "laptop");
    await synced(plugin);

    expect(app.vault.adapter.filePaths()).toContain(".obsidian/plugins/basalt/index.json");

    await plugin.unlink();
    expect(plugin.paired).toBe(false);
    expect(plugin.savedData).toBe(null);
    expect(statusIcon(plugin)).toBe("link");
    expect(status(plugin)).toBe("Basalt Sync: Not paired.");
    expect(app.vault.adapter.text("keep.md")).toBe("still here");

    // The index goes too. It records what this device believes it has
    // already synced, and left behind it would be read as fact by the next
    // pairing, possibly against a different server entirely.
    expect(app.vault.adapter.filePaths()).not.toContain(".obsidian/plugins/basalt/index.json");
  }, 300_000);

  /**
   * Unlinking and pairing again has to be a genuinely fresh start.
   *
   * This is the failure the stale index would cause: a cursor and a set of
   * entries from the old pairing, read as the truth about a server that has
   * never seen this device, so notes that were never uploaded are treated as
   * already sent.
   */
  it("starts clean when paired again afterwards", async () => {
    await fresh();
    const { plugin, app } = await load();
    app.vault.adapter.seed("note.md", "the only note");
    await startVault(plugin, "laptop");
    await synced(plugin);
    await plugin.unlink();

    // A different server, which has never heard of this device.
    const second = new TestServer();
    await second.start();
    try {
      await startVault(plugin, "laptop-again", second.setup);
      await synced(plugin);
      await plugin.syncNow();

      // The note must have been uploaded to the new server, not assumed
      // to be there already.
      const elsewhere = await load();
      await elsewhere.plugin.pair(keyOf(plugin), "other");
      await synced(elsewhere.plugin);
      await until(
        "the note to arrive",
        () => elsewhere.app.vault.adapter.text("note.md") !== undefined,
      );
      expect(elsewhere.app.vault.adapter.text("note.md")).toBe("the only note");
    } finally {
      await second.cleanup();
    }
  }, 300_000);
});

describe("the panel, which is a modal and a settings tab", () => {
  /**
   * The panel has to be in Settings, and this is the test that says so.
   *
   * It was reachable from the ribbon, the status bar and the command palette,
   * and nowhere else, because the plugin registered no settings tab. Obsidian
   * draws a plugin's gear in Settings only for a plugin that calls
   * `addSettingTab`, so Settings had no Basalt entry at all and somebody
   * looking for the plugin's interface where every other plugin keeps it
   * found nothing and concluded there was none. Reported by the one person
   * running it, who could not find the settings screen.
   *
   * Registering it is the fix, and drawing the same panel is the point: no
   * options were added to earn the place.
   */
  it("is in Obsidian's settings, drawing the same rows as the modal", async () => {
    const { plugin } = await load();
    expect(
      plugin.settingTabs.length,
      "the plugin registers no settings tab, so Settings shows no Basalt entry at all",
    ).toBe(1);

    const tab = plugin.settingTabs[0]!;
    built.length = 0;
    tab.display();
    const inTab = built.map((s) => s.name);

    built.length = 0;
    plugin.ribbonIcons[0]!.callback();
    const inModal = built.map((s) => s.name);

    expect(inTab, "the settings tab drew nothing").not.toEqual([]);
    expect(inTab, "the tab and the modal are different panels").toEqual(inModal);

    // And it tears down, because Obsidian calls hide on the way out and a tab
    // that kept its state watcher would add one every time Settings opened.
    tab.hide();
    expect(tab.containerEl.children).toEqual([]);
  }, 300_000);

  it("asks to be paired when it is not", async () => {
    const { plugin } = await load();
    plugin.ribbonIcons[0]!.callback();

    const names = built.map((s) => s.name);
    expect(names).toContain("Invite or recovery key");
    expect(names).toContain("Device name");
    // One field for the first device, holding the line the server printed,
    // rather than a Server and a Token to split it into by hand.
    expect(names).toContain("Setup string");
    expect(names).not.toContain("Server");
    expect(names).not.toContain("Token");
    // No options anywhere in it. docs/design.md refuses a settings
    // screen, and this is the thing that would quietly become one.
    expect(names.filter((n) => n.toLowerCase().includes("enable"))).toEqual([]);
  });

  it("pairs from what was typed into it", async () => {
    await fresh();
    const first = await load();
    const pairing = await startVault(first.plugin, "laptop");
    await synced(first.plugin);

    const second = await load();
    second.plugin.ribbonIcons[0]!.callback();

    built.find((s) => s.name === "Device name")!.texts[0]!.type("desktop");
    built.find((s) => s.name === "Invite or recovery key")!.texts[0]!.type(pairing);
    await built.find((s) => s.buttons.some((b) => b.label === "Pair"))!.buttons[0]!.click();

    expect(second.plugin.paired).toBe(true);
    expect(second.plugin.deviceName).toBe("desktop");
    await synced(second.plugin);
  }, 300_000);

  /**
   * The invite row and the device list, in that order, because they are one
   * subject: an invite is how a row appears in the list, and a row in the list
   * is what can be cut off.
   */
  it("offers an invite and a device list, and says the key is not needed", async () => {
    await fresh();
    const { plugin } = await load();
    await startVault(plugin, "laptop");
    await synced(plugin);

    built.length = 0;
    plugin.ribbonIcons[0]!.callback();
    const adding = built.find((s) => s.name === "Add another device")!;
    expect(adding, "the panel offers no way to add a device").toBeDefined();
    expect(adding.buttons.map((b) => b.label)).toContain("Create invite");
    // The sentence that keeps the recovery key written down and offline. If
    // the panel is silent about it, adding a device becomes fetching the key.
    // On the row's `?` with everything else it has to say, because a row is a
    // label and a control now and the prose is one hover away.
    expect(tooltips()).toMatch(/recovery key is not needed/i);
    expect(tooltips()).toMatch(/no root secret/);

    const row = built.find((s) => s.name === "Devices")!;
    expect(row, "the panel has no device list").toBeDefined();
    expect(tooltips()).toMatch(/Add one with an invite/);

    built.length = 0;
    await row.buttons[0]!.click();
    await until("the list to arrive", () => built.some((s) => s.desc.includes("added ")));
    const listed = built.find((s) => s.name.startsWith("laptop"))!;
    expect(listed.name).toMatch(/\(this device\)/);
    // No button on it, because it is the vault's only device and emptying the
    // vault takes the recovery key. What the panel offers instead is in "the
    // device list in the panel", below; the row with a Revoke button on it is
    // there too.
    expect(listed.buttons).toEqual([]);
  }, 300_000);

  it("shows what is happening once it is paired", async () => {
    await fresh();
    const { plugin } = await load();
    await startVault(plugin, "laptop");
    await synced(plugin);

    built.length = 0;
    plugin.ribbonIcons[0]!.callback();
    const names = built.map((s) => s.name);
    expect(names).toContain("Sync now");
    expect(names).toContain("Devices");
    expect(names).toContain("Recovery key");
    expect(names).toContain("Unlink this vault");
  }, 300_000);

  /**
   * The rare rows behind one press, and the everyday ones not.
   *
   * design.md: a thing that matters only when something specific happens
   * appears in that moment. Devices, the recovery key, replacing the secret
   * and unlinking are rare and three of the four cannot be undone, so they are
   * inside one `<details>`. A `<details>` and not a tab or a second modal
   * because it needs no code and holds no state, which is the whole reason the
   * panel can be the whole interface.
   */
  it("puts the rare rows behind one disclosure and leaves the everyday ones out", async () => {
    await fresh();
    const { plugin } = await load();
    await startVault(plugin, "laptop");
    await synced(plugin);

    built.length = 0;
    plugin.ribbonIcons[0]!.callback();
    const manage = modals.at(-1)!.contentEl.children.find((el) => el.tag === "details")!;
    expect(manage, "the panel has no disclosure").toBeDefined();
    expect(manage.children[0]!.tag).toBe("summary");
    expect(manage.children[0]!.text).toBe("Manage this vault");

    const inside = (name: string): boolean =>
      manage.children.includes(built.find((s) => s.name === name)!.settingEl);
    for (const row of [
      "Devices",
      "Recovery key",
      "Replace the vault's secret",
      "Unlink this vault",
    ])
      expect(inside(row), `"${row}" is on the everyday panel`).toBe(true);
    for (const row of ["Sync now", "Add another device", "Recover a deleted note"])
      expect(inside(row), `"${row}" is behind the disclosure`).toBe(false);

    // And the way out of the panel for anybody who wants the rest of it, which
    // is where the four hundred words that used to be on screen went.
    const links = modals
      .at(-1)!
      .contentEl.children.flatMap((el) => el.children)
      .filter((el) => el.tag === "a");
    expect(links.map((el) => el.attributes.get("href"))).toContain(
      "https://github.com/waynehoover/basalt-sync/blob/main/docs/plugin.md",
    );
  }, 300_000);

  it("says what went wrong rather than failing quietly", async () => {
    const { plugin } = await load();
    plugin.ribbonIcons[0]!.callback();
    built
      .find((s) => s.name === "Invite or recovery key")!
      .texts[0]!.type("this is not a pairing string");
    notices.length = 0;
    await built.find((s) => s.buttons.some((b) => b.label === "Pair"))!.buttons[0]!.click();

    expect(notices.map((n) => n.message).join(" ")).toMatch(/basalt3_/);
    expect(plugin.paired).toBe(false);
  });
});

describe("on a device with no status bar", () => {
  /**
   * Obsidian mobile has no status bar, so `addStatusBarItem` returns an
   * element nothing displays and the plugin's only ongoing feedback is the
   * plugin talking to itself. The ribbon is on both, so the state goes there
   * too, as the tooltip somebody gets by holding the icon.
   */
  it("puts the state on the ribbon as well", async () => {
    await fresh();
    const { plugin } = await load();
    const ribbon = plugin.ribbonIcons[0]!;
    expect(ribbon.title).toBe("Basalt Sync");

    await startVault(plugin, "laptop");
    await synced(plugin);

    // The same sentence the status bar carries, somewhere a phone shows it.
    const label = ribbon.el.attributes.get("aria-label") ?? "";
    expect(label, `the ribbon says ${JSON.stringify(label)}`).toMatch(/^Basalt: /);
    expect(label).not.toMatch(/connecting/);
  }, 300_000);

  /**
   * A server refuses a browser origin it does not know, and the only thing
   * that knows this device's origin is this device. The mobile origins in the
   * server's list are Capacitor's documented defaults and have never been
   * checked against a device, so an offline phone has to be able to say what
   * to add rather than leaving somebody guessing.
   */
  it("says what to allow when it has never got through", async () => {
    // A server that is not there looks the same as one that refuses this
    // origin, and this plugin cannot tell them apart, so the advice is
    // offered while nothing has ever connected. A paired phone that comes up
    // with the server unreachable is that: joining a vault reaches the server
    // by definition, and this is the next time it tries.
    await fresh();
    const first = await load();
    await startVault(first.plugin, "laptop");
    await synced(first.plugin);
    const saved = first.plugin.savedData;
    first.plugin.onunload();
    await first.plugin.closing;
    await server.cleanup();

    const { plugin } = await load(saved);
    await until("it to notice", () => plugin.currentState.kind === "offline");

    built.length = 0;
    plugin.ribbonIcons[0]!.callback();
    await until("the modal to say so", () =>
      modals.at(-1)!.contentEl.allText().includes("-allow-origin"),
    );
    const shown = modals.at(-1)!.contentEl.allText();
    expect(shown).toMatch(/allow-origin/);
    expect(shown, "it did not say what this device's origin actually is").toMatch(/origin is \S+/);
  }, 300_000);

  /**
   * review finding P13. A connection that was up and went is network loss, and
   * the origin was demonstrably fine. Advice about it on every offline state
   * sent people to restart a server that had nothing wrong with it.
   */
  it("says nothing about origins when a working connection is lost (P13)", async () => {
    await fresh();
    const { plugin } = await load();
    await startVault(plugin, "laptop");
    await synced(plugin);
    await server.cleanup();
    await until("it to notice", () => plugin.currentState.kind === "offline");

    built.length = 0;
    plugin.ribbonIcons[0]!.callback();
    await sleep(100);
    expect(modals.at(-1)!.contentEl.allText()).not.toMatch(/allow-origin/);
  }, 300_000);

  it("says nothing about origins while it is working", async () => {
    await fresh();
    const { plugin } = await load();
    await startVault(plugin, "laptop");
    await synced(plugin);

    built.length = 0;
    plugin.ribbonIcons[0]!.callback();
    expect(modals.at(-1)!.contentEl.allText()).not.toMatch(/allow-origin/);
  }, 300_000);
});

describe("saying what it is working on", () => {
  /**
   * A large attachment is minutes inside one pass. Without a state for it the
   * status shows the previous pass's result the whole time, so working and
   * idle look exactly alike, which is rule 7 with the two conditions that
   * matter most collapsed.
   *
   * Not a percentage. What somebody wants to know is whether it is doing
   * something and what, and a byte counter for one file out of forty answers
   * a question nobody asked.
   */
  it("reports the file it is on, once it has been on it a while", async () => {
    await fresh();
    const { plugin, app } = await load();
    await startVault(plugin, "laptop");
    await synced(plugin);

    const seen: string[] = [];
    const stop = plugin.watchState((s) => {
      if (s.kind === "syncing") seen.push(s.path);
    });

    // Incompressible and large enough that sealing it reliably outlasts the
    // threshold. A compressible file seals in a few milliseconds and the
    // state never fires, which made an earlier version of this pass or fail
    // depending on how loaded the machine was.
    const big = new Uint8Array(24 * 1024 * 1024);
    for (let at = 0; at < big.length; at += 65536) {
      crypto.getRandomValues(big.subarray(at, Math.min(at + 65536, big.length)));
    }
    await app.vault.adapter.writeBinary("big.bin", big.buffer as ArrayBuffer, { mtime: 5000 });

    const syncing = plugin.syncNow();
    // Watched while it runs rather than checked afterwards, because by the
    // time it finishes the state has moved on to the result.
    await until("it to say what it is working on", () => seen.length > 0, 60_000);
    await syncing;
    stop();

    expect(seen).toContain("big.bin");
    // And it ends on a result rather than stuck saying it is working.
    expect(plugin.currentState.kind).toBe("synced");
  }, 300_000);

  /**
   * A pass over a settled vault visits every path and does nothing to any of
   * them. Reporting each one would replace a useful summary with a blur.
   */
  it("says nothing while passing over a vault with nothing to do", async () => {
    await fresh();
    const { plugin, app } = await load();
    app.vault.adapter.seed("a.md", "one");
    app.vault.adapter.seed("b.md", "two");
    await startVault(plugin, "laptop");
    await synced(plugin);
    await plugin.syncNow();

    const seen: string[] = [];
    const stop = plugin.watchState((s) => {
      if (s.kind === "syncing") seen.push(s.path);
    });
    await plugin.syncNow();
    stop();
    expect(seen, `a quiet pass announced ${JSON.stringify(seen)}`).toEqual([]);
  }, 300_000);
});

/**
 * Every socket the plugin opens, so a test can see whether one is still open.
 *
 * The plugin uses the platform's WebSocket, and this wraps it for the duration
 * of a test. `readyState` 2 and 3 are closing and closed, per the standard.
 */
function recordSockets(): { sockets: WebSocket[]; restore: () => void } {
  const Real = globalThis.WebSocket;
  const sockets: WebSocket[] = [];
  class Recording extends Real {
    constructor(url: string | URL, protocols?: string | string[]) {
      super(url, protocols);
      sockets.push(this);
    }
  }
  globalThis.WebSocket = Recording as typeof WebSocket;
  return {
    sockets,
    restore: () => {
      globalThis.WebSocket = Real;
    },
  };
}

/** Slows the plugin's index load, which runs inside `connect()`, so a test can act during the handshake. */
function slowIndexLoad(app: App, ms: number): { began: Promise<void> } {
  const adapter = app.vault.adapter;
  const realExists = adapter.exists.bind(adapter);
  let begin!: () => void;
  const began = new Promise<void>((r) => {
    begin = r;
  });
  adapter.exists = async (path: string) => {
    if (path.endsWith("/index.json")) {
      begin();
      await sleep(ms);
    }
    return realExists(path);
  };
  return { began };
}

/**
 * P1 and review finding P12. A run inside `connect()` used to survive `unlink`:
 * the shell was handed the client only once the handshake had succeeded, so
 * a vault unlinked during a slow handshake had nothing to close, and the
 * connection went on to complete with the old secret. The two tests this
 * replaces asserted that a counter had moved, which is not the property.
 */
describe("unlinking during the handshake (P1)", () => {
  it("closes the connecting client, and nothing of the old pairing is written afterwards", async () => {
    await fresh();
    const { sockets, restore } = recordSockets();
    try {
      const { plugin, app } = await load();
      app.vault.adapter.seed("secret-note.md", "must never reach the old server after unlink");
      const { began } = slowIndexLoad(app, 1500);

      const oldPairing = await startVault(plugin, "laptop");
      await began;
      expect(plugin.currentState.kind).toBe("connecting");
      await plugin.unlink();

      // Quiescent: when unlink resolves, no socket of the plugin's is open.
      expect(sockets.length).toBeGreaterThan(0);
      for (const s of sockets)
        expect(s.readyState, "a socket was still open after unlink").toBeGreaterThanOrEqual(2);
      expect(plugin.paired).toBe(false);

      // And after the slow handshake would have finished, still nothing.
      await sleep(2500);
      expect(await app.vault.adapter.exists(".obsidian/plugins/basalt/index.json")).toBe(false);
      expect(plugin.currentState.kind).toBe("unpaired");

      // The old server holds nothing. It has heard from this device, because
      // starting a vault claims it and registers a row rather than writing a
      // config and contacting nobody, but not one note went up: the run was
      // retired before its first pass.
      const { Client } = await import("../core/client.ts");
      const { parsePairing } = await import("../core/pairing.ts");
      const { testWrapped } = await import("../core/test-keys.ts");
      const { MemoryIndexStore, MemoryVault } = await import("../core/vault.ts");
      const secret = parsePairing(oldPairing).secret;
      const checker = new Client({
        vault: new MemoryVault(),
        store: new MemoryIndexStore(),
        url: server.wsUrl,
        ...(await server.deviceCredentials(secret, await testWrapped(secret), "checker")),
        vaultId: "default",
        device: "checker",
      });
      try {
        await checker.connect();
        expect(checker.serverCursor, "the old run uploaded after unlink").toBe(0);
      } finally {
        await checker.close();
      }
    } finally {
      restore();
    }
  }, 300_000);

  it("unloading during the handshake retires the run and closes it (P1)", async () => {
    await fresh();
    const { sockets, restore } = recordSockets();
    try {
      const { plugin, app } = await load();
      const { began } = slowIndexLoad(app, 1000);
      await startVault(plugin, "laptop");
      await began;
      const seen: string[] = [];
      plugin.watchState((s) => void seen.push(s.kind));
      plugin.onunload();
      await plugin.closing;
      for (const s of sockets) expect(s.readyState).toBeGreaterThanOrEqual(2);
      await sleep(2000);
      // The retired run said nothing: the only state seen is the one the
      // watcher was handed on subscribing.
      expect(seen).toEqual(["connecting"]);
    } finally {
      restore();
    }
  }, 300_000);
});

/**
 * P15 and review finding P23, the plugin half of C13. Unlink used to discard the
 * promise from `close()`, clear the saved config, and then remove the index,
 * so a pass in flight could recreate the index after its removal and an
 * adapter failure left the vault unpaired on disk and paired in memory.
 */
describe("unlink, in order and all the way (P15)", () => {
  const INDEX = ".obsidian/plugins/basalt/index.json";
  const STAGED = ".obsidian/plugins/basalt/.basalt-tmp-index-index.json";

  it("closes, then removes the index, then forgets the pairing", async () => {
    await fresh();
    const { sockets, restore } = recordSockets();
    try {
      const { plugin, app } = await load();
      app.vault.adapter.seed("note.md", "x");
      await startVault(plugin, "laptop");
      await synced(plugin);

      const order: string[] = [];
      const adapter = app.vault.adapter;
      const realRemove = adapter.remove.bind(adapter);
      adapter.remove = async (path) => {
        if (path === INDEX) order.push("remove index");
        return realRemove(path);
      };
      const realSave = plugin.saveData.bind(plugin);
      plugin.saveData = async (data) => {
        if (data === null) {
          order.push("forget pairing");
          expect(await adapter.exists(INDEX), "the pairing went before the index").toBe(false);
        }
        return realSave(data);
      };
      const socket = sockets[sockets.length - 1]!;
      const realClose = socket.close.bind(socket);
      socket.close = (...args) => {
        order.push("close");
        return realClose(...args);
      };

      await plugin.unlink();
      expect(order).toEqual(["close", "remove index", "forget pairing"]);
    } finally {
      restore();
    }
  }, 300_000);

  it("waits for the pass in flight, so the index it saves is the one removed", async () => {
    await fresh();
    const a = await load();
    await startVault(a.plugin, "laptop");
    await synced(a.plugin);
    const b = await load();
    await b.plugin.pair(keyOf(a.plugin), "desktop");
    await synced(b.plugin);

    // A download on b that takes a while, and an unlink in the middle of it.
    let writing!: () => void;
    const began = new Promise<void>((r) => {
      writing = r;
    });
    const adapter = b.app.vault.adapter;
    const realWrite = adapter.writeBinary.bind(adapter);
    adapter.writeBinary = async (path, data, options) => {
      if (path.includes("slow.md")) {
        writing();
        await sleep(1500);
      }
      return realWrite(path, data, options);
    };
    a.app.vault.adapter.seed("slow.md", "arrives slowly");
    await a.plugin.syncNow();
    await began;

    await b.plugin.unlink();
    expect(b.plugin.paired).toBe(false);
    // The pass finished before the index was removed, so nothing of it comes
    // back afterwards.
    await sleep(2500);
    expect(await adapter.exists(INDEX)).toBe(false);
    expect(await adapter.exists(STAGED)).toBe(false);
    expect(b.plugin.savedData).toBe(null);
  }, 300_000);

  it("takes the staged index copy too (P23)", async () => {
    await fresh();
    const { plugin, app } = await load();
    await startVault(plugin, "laptop");
    await synced(plugin);
    await app.vault.adapter.write(
      STAGED,
      JSON.stringify({ cursor: 99, entries: {}, remote: {}, pending: [] }),
    );
    await plugin.unlink();
    expect(await app.vault.adapter.exists(STAGED)).toBe(false);
    expect(await app.vault.adapter.exists(INDEX)).toBe(false);
  }, 300_000);

  it("leaves memory and disk agreeing when a step fails, and can be tried again", async () => {
    await fresh();
    const { plugin, app } = await load();
    await startVault(plugin, "laptop");
    await synced(plugin);
    const saved = plugin.savedData;

    app.vault.adapter.fault = (op, path) =>
      op === "remove" && path === INDEX ? new Error("EACCES: index is locked") : undefined;
    await expect(plugin.unlink()).rejects.toThrow(/index could not be removed/);
    // Still paired, both places, and honest about being stopped.
    expect(plugin.paired).toBe(true);
    expect(plugin.savedData).toEqual(saved);
    expect(plugin.currentState.kind).toBe("stopped");
    expect(status(plugin)).toMatch(/unlink did not finish/);

    app.vault.adapter.fault = undefined;
    await plugin.unlink();
    expect(plugin.paired).toBe(false);
    expect(plugin.savedData).toBe(null);
    expect(await app.vault.adapter.exists(INDEX)).toBe(false);
  }, 300_000);

  it("leaves the index gone and the pairing kept when forgetting the pairing fails", async () => {
    await fresh();
    const { plugin, app } = await load();
    await startVault(plugin, "laptop");
    await synced(plugin);
    const saved = plugin.savedData;
    const realSave = plugin.saveData.bind(plugin);
    plugin.saveData = async (data) => {
      if (data === null) throw new Error("EIO: data.json");
      return realSave(data);
    };
    await expect(plugin.unlink()).rejects.toThrow(/pairing could not be removed/);
    expect(plugin.paired).toBe(true);
    expect(plugin.savedData).toEqual(saved);
    // A missing index is the safe side: it only means starting over from
    // the server, never skipping an upload.
    expect(await app.vault.adapter.exists(INDEX)).toBe(false);
  }, 300_000);

  /**
   * P26 in TODO-NEW.md. A "working on" timer armed before unlink fired after
   * it and painted the bar back to syncing an unpaired vault.
   */
  it("clears the timers, so nothing paints over unpaired (P26)", async () => {
    await fresh();
    const { plugin } = await load();
    await startVault(plugin, "laptop");
    await synced(plugin);
    (plugin as unknown as { working(p: string): void }).working("big.bin");
    await plugin.unlink();
    await sleep(600);
    expect(plugin.currentState.kind).toBe("unpaired");
  }, 300_000);
});

/**
 * review finding P16, the plugin half of C15. The first device claims the vault
 * with the server's bootstrap token and then drops the token. If the drop
 * never saved, or the claim's reply was lost, the next start offered the
 * spent token first and was refused for ever.
 */
/**
 * review finding P16, and what protocol 4 leaves of it.
 *
 * Starting a vault writes the root to `data.json` and reads it back before the
 * claim goes out, because the claim binds the server to that secret for good
 * and a secret that never reached the disk is a vault nobody can open. If the
 * registration after it fails, that is what is left: a root, no row, and a
 * phone. Nothing resumes from that and retries the spent token, so the whole
 * of the answer has to be in what the phone shows, and it is tested for the
 * key itself rather than for advice about it.
 */
describe("a vault that was started and never joined (P16)", () => {
  it("stops with the recovery key on screen rather than retrying for ever", async () => {
    await fresh();
    const first = await load();
    await startVault(first.plugin, "laptop");
    await synced(first.plugin);
    const recoveryKey = keyOf(first.plugin);

    // What a registration that failed after the claim committed leaves on
    // disk: the config as it was saved before the claim, root and all.
    const { parsePairing } = await import("../core/pairing.ts");
    const { base64urlEncode } = await import("../core/crypto.ts");
    const saved = first.plugin.savedData as Record<string, unknown>;
    const stale = {
      url: saved["url"],
      vaultId: saved["vaultId"],
      device: saved["device"],
      secret: base64urlEncode(parsePairing(recoveryKey).secret),
    };
    first.plugin.onunload();
    await first.plugin.closing;

    const again = await load(stale);
    await until("it to stop", () => again.plugin.currentState.kind === "stopped");
    const why = (again.plugin.currentState as { why: string }).why;
    expect(why).toMatch(/never registered itself/);
    // The key, on screen. This config is the only copy of it, so a phone that
    // said "could not connect" and no more would be a lost vault.
    expect(why).toContain(recoveryKey);
    expect(why).toMatch(/unlink this vault and pair again with it/);
    // Stopped, not offline: nothing here is going to change on a retry, and a
    // status bar saying "connecting" about that is the lie rule 7 is about.
    expect(again.plugin.savedData).not.toBe(null);
  }, 300_000);

  it("keeps the root when the claim went through and the credential could not be saved", async () => {
    // The save that records this device's credential is the one that cannot be
    // taken on trust: it lands between a registration the server has committed
    // and a phone with nothing to show for it.
    await fresh();
    const { plugin } = await load();
    let failing = true;
    const realSave = plugin.saveData.bind(plugin);
    plugin.saveData = async (data) => {
      const record = data as Record<string, unknown> | null;
      if (failing && record !== null && record["deviceId"] !== undefined) {
        throw new Error("EIO: data.json");
      }
      return realSave(data);
    };
    const failed = await startVault(plugin, "laptop").then(
      () => undefined,
      (err: Error) => err,
    );
    expect(failed?.message, "starting the vault succeeded").toMatch(/could not register itself/);
    // The row the registration may already have committed, named. A phone
    // told only to pair again registers a second row and spends another of
    // the vault's eight slots, and nothing ever says the first one is there.
    expect(failed?.message).toMatch(/device row was registered/);
    expect(failed?.message).toMatch(/never connected/);
    expect(failed?.message).toMatch(/Write the recovery key shown in the Basalt panel down/);

    // On disk and in memory, the root is still there: the claim may have
    // committed, and throwing it away is a vault nothing will ever open.
    const held = plugin.savedData as Record<string, unknown>;
    expect(held["secret"], "the root went with the failed save").toBeDefined();
    await until("it to stop", () => plugin.currentState.kind === "stopped");
    const why = (plugin.currentState as { why: string }).why;
    expect(why).toMatch(/never registered itself/);
    // And the key is on the panel, which is where the person was sent.
    const printed = why.match(/basalt3_[A-Za-z0-9_-]+/)![0];
    const { parsePairing } = await import("../core/pairing.ts");
    expect(parsePairing(printed).vaultId).toBe("default");

    // The way out the words name: forget this pairing, and pair with the key.
    failing = false;
    await plugin.unlink();
    const rejoined = await load();
    await rejoined.plugin.pair(printed, "laptop");
    await synced(rejoined.plugin);
    const after = rejoined.plugin.savedData as Record<string, unknown>;
    expect(after["secret"], "pairing with the recovery key kept it").toBeUndefined();
    expect(after["deviceId"]).toBeDefined();
  }, 300_000);

  /**
   * The panel's pairing form, at the same moment: the registration commits and
   * the credential does not reach data.json.
   *
   * A row exists on the vault that nothing holds the key to, and the advice
   * has to name it. Pairing again registers a second one, so a phone that is
   * only told to try again spends one of the vault's eight slots per attempt
   * and nothing ever says so. The words come from `adviseAfterRegistering`,
   * which the CLI's `init` and `pair` also take theirs from.
   */
  it("names the row the panel's pairing left when the credential could not be saved", async () => {
    await fresh();
    const first = await load();
    const key = await startVault(first.plugin, "laptop");
    await synced(first.plugin);

    const second = await load();
    const realSave = second.plugin.saveData.bind(second.plugin);
    second.plugin.saveData = async (data: unknown) => {
      const record = data as Record<string, unknown> | null;
      if (record !== null && record["deviceId"] !== undefined) throw new Error("EIO: data.json");
      return realSave(data);
    };
    const failed = await second.plugin.pair(key, "desktop").then(
      () => undefined,
      (err: Error) => err,
    );
    expect(failed?.message, "the pairing succeeded").toMatch(/EIO/);
    expect(failed?.message).toMatch(/device row was registered/);
    expect(failed?.message).toMatch(/never connected/);
    expect(failed?.message).toMatch(/device slots/);
    // Nothing here claims to be paired, because nothing here can connect.
    expect(second.plugin.savedData).toBe(null);

    // And the row it names is really there, and really goes.
    const rows = (await first.plugin.devices()).devices;
    const orphan = rows.find((d) => d.lastSeen === 0);
    expect(orphan, JSON.stringify(rows)).toBeDefined();
    await first.plugin.revoke(orphan!.id);
    expect((await first.plugin.devices()).devices).toHaveLength(1);
  }, 300_000);

  /**
   * The mirror image, and why the advice is read off the disk in four states.
   *
   * A data.json that writes and will not read back holds a credential for a
   * live row, and "that row is one nothing can connect as, revoke it" would
   * destroy the row this phone could have used. Rule 2: absent and unreadable
   * are different states, here with different consequences.
   */
  it("will not name a row for revoking when data.json refuses to read back", async () => {
    await fresh();
    const first = await load();
    const key = await startVault(first.plugin, "laptop");
    await synced(first.plugin);

    const second = await load();
    let breaking = false;
    const realLoad = second.plugin.loadData.bind(second.plugin);
    const realSave = second.plugin.saveData.bind(second.plugin);
    second.plugin.saveData = async (data: unknown) => {
      const record = data as Record<string, unknown> | null;
      if (record !== null && record["deviceId"] !== undefined) breaking = true;
      return realSave(data);
    };
    second.plugin.loadData = async () => {
      if (breaking) throw new Error("EIO: data.json");
      return realLoad();
    };
    const failed = await second.plugin.pair(key, "desktop").then(
      () => undefined,
      (err: Error) => err,
    );
    expect(failed?.message, "the pairing succeeded").toMatch(/could not be read/);
    expect(failed?.message).toMatch(/not known/);
    expect(failed?.message).not.toMatch(/never connected/);
    // The credential really was written, and it is the row's only key.
    expect((second.plugin.savedData as Record<string, unknown>)["deviceId"]).toBeDefined();
    expect((await first.plugin.devices()).devices).toHaveLength(2);
  }, 300_000);
});

/**
 * review finding P3. An unreadable data.json set the state to stopped, but the
 * panel branched on `paired` and offered the pairing form, and pairing
 * overwrote the file with a new secret.
 */
describe("a config that cannot be read (P3)", () => {
  it("refuses to pair over it, and the panel shows why and where instead of the form", async () => {
    await fresh();
    const unreadable = { url: "ws://x", vaultId: "default", device: "d", secret: "AAAA" };
    const { plugin } = await load(unreadable);
    expect(plugin.currentState.kind).toBe("stopped");

    built.length = 0;
    plugin.ribbonIcons[0]!.callback();
    expect(built.map((s) => s.name)).not.toContain("Pairing string");
    const shown = modals.at(-1)!.contentEl.allText();
    expect(shown).toMatch(/root secret is 32 bytes/);
    expect(shown).toContain(".obsidian/plugins/basalt/data.json");

    await expect(startVault(plugin, "laptop")).rejects.toThrow(/could not be read/);
    await expect(plugin.pair("basalt3_whatever", "laptop")).rejects.toThrow(/could not be read/);
    expect(plugin.savedData).toEqual(unreadable);
  }, 300_000);
});

/**
 * review finding P4. "Working on X" stuck after any pass the plugin did not
 * start: the ticker and an arriving batch. Every pass now reports through one
 * hook, and the state follows it.
 */
describe("passes the plugin did not start (P4)", () => {
  it("returns to synced after a slow download that a batch started", async () => {
    await fresh();
    const a = await load();
    await startVault(a.plugin, "laptop");
    await synced(a.plugin);
    const b = await load();
    const adapter = b.app.vault.adapter;
    const realWrite = adapter.writeBinary.bind(adapter);
    adapter.writeBinary = async (path, data, options) => {
      if (path.includes("slow.md")) await sleep(700);
      return realWrite(path, data, options);
    };
    await b.plugin.pair(keyOf(a.plugin), "desktop");
    await synced(b.plugin);

    const seen: string[] = [];
    b.plugin.watchState((s) => void seen.push(s.kind));
    a.app.vault.adapter.seed("slow.md", "takes a while to land");
    await a.plugin.syncNow();
    await until("b to receive it", () => adapter.text("slow.md") !== undefined, 30_000);
    await until("b to settle", () => b.plugin.currentState.kind === "synced", 5_000);
    expect(seen, "b never said it was working").toContain("syncing");
    expect(b.plugin.currentState.kind).toBe("synced");
  }, 300_000);
});

/**
 * review finding P5. "Cannot sync N file(s)" fired on every pass for a file that
 * would never sync, and a notice on every pass is a notice nobody reads.
 */
describe("what is announced, and how often (P5)", () => {
  it("says a file is stuck once, not on every pass", async () => {
    await fresh();
    const { plugin, app } = await load();
    app.vault.adapter.seed("fine.md", "ok");
    app.vault.adapter.seed(`${"far/".repeat(1200)}too-deep.md`, "nope");
    await startVault(plugin, "laptop");
    await synced(plugin);
    await until("the refusal to be announced", () =>
      notices.some((n) => /cannot sync/.test(n.message)),
    );
    notices.length = 0;
    for (let i = 0; i < 4; i++) await plugin.syncNow();
    expect(notices.filter((n) => /cannot sync/.test(n.message))).toHaveLength(0);

    // And a save, which syncs through the nudge, says nothing new either.
    app.vault.adapter.seed("fine.md", "edited", 9_000_000_000_000);
    app.vault.fire("modify");
    await sleep(1500);
    expect(notices.filter((n) => /cannot sync/.test(n.message))).toHaveLength(0);
    // The status still says so, because a status describes the vault.
    expect(status(plugin)).toMatch(/attention/);
  }, 300_000);

  /**
   * N2. The notice fired on the count changing, so one file being fixed in the
   * same pass as another started failing left the number where it was and the
   * new failure was never announced. The glyph said something was wrong and
   * nothing said what.
   */
  it("announces a different stuck file even when the count did not move (N2)", async () => {
    await fresh();
    const { plugin, app } = await load();
    const adapter = app.vault.adapter;
    const cannotOpen = new Set(["one.md"]);
    adapter.fault = (op, path) => {
      if (op !== "readBinary" || !cannotOpen.has(path)) return undefined;
      const err = new Error(`this device will not open ${path}`) as Error & { code: string };
      // The code the engine writes a path off for good by.
      err.code = "neversync";
      return err;
    };
    adapter.seed("one.md", "cannot be opened");
    adapter.seed("two.md", "fine for now");
    await startVault(plugin, "laptop");
    await synced(plugin);
    await until("the first refusal", () => notices.some((n) => /cannot sync/.test(n.message)));
    expect(notices.at(-1)!.message, "the notice did not say which file").toContain("one.md");

    // Taking it out of the vault is what stops a written-off path being
    // counted. One pass to see it has gone.
    notices.length = 0;
    await adapter.remove("one.md");
    await plugin.syncNow();

    // A different file now, and the count is one both before and after.
    cannotOpen.clear();
    cannotOpen.add("two.md");
    adapter.seed("two.md", "and now this one will not open", 9_000_000_000_000);
    await plugin.syncNow();

    const said = notices.filter((n) => /cannot sync/.test(n.message));
    expect(said.length, "the swapped failure was never announced").toBeGreaterThan(0);
    expect(said.at(-1)!.message).toContain("two.md");
  }, 300_000);

  /**
   * The notice key assumes the list the type promises. A report built by hand
   * with a count and no list must still announce the count rather than throw
   * inside the announcement.
   */
  it("announces the count when a report names no paths", async () => {
    const { plugin } = await load();
    const report = {
      uploaded: 0,
      downloaded: 0,
      merged: 0,
      conflicted: 0,
      deletedLocally: 0,
      deletedRemotely: 0,
      restored: 0,
      foldersCreated: 0,
      unchanged: 0,
      waiting: 0,
      retrying: 0,
      skipped: 1,
      ignored: 0,
      blocked: 0,
      inTheWay: [],
      chunksSent: 0,
      bytesSent: 0,
    } as unknown as SyncReport;
    (plugin as unknown as { announce(report: SyncReport): void }).announce(report);
    expect(notices.map((n) => n.message).join(" ")).toMatch(/cannot sync 1 file\(s\)\./);
  });
});

/**
 * review finding P7. `syncNow` could reject with the promise discarded by both
 * callers, so a pass that threw was a button that did nothing.
 */
describe("a sync that fails (P7)", () => {
  it("says so, and the state is honest about it", async () => {
    await fresh();
    const { plugin, app } = await load();
    app.vault.adapter.seed("note.md", "x");
    await startVault(plugin, "laptop");
    await synced(plugin);

    // The index cannot be written: the pass throws on its way out.
    app.vault.adapter.seed("another.md", "y");
    app.vault.adapter.fault = (op, path) =>
      (op === "writeBinary" || op === "append") && path.includes("/plugins/basalt/")
        ? new Error("EACCES: index")
        : undefined;
    notices.length = 0;
    await plugin.syncNow();
    expect(notices.map((n) => n.message).join(" ")).toMatch(/sync failed.*EACCES/);
    expect(plugin.currentState.kind).toBe("failed");
    expect(statusIcon(plugin)).toBe("alert-triangle");
    expect(status(plugin)).toMatch(/Last sync failed/);

    app.vault.adapter.fault = undefined;
    await plugin.syncNow();
    expect(plugin.currentState.kind).toBe("synced");
  }, 300_000);
});

/**
 * review finding P8. "It will sync as soon as it reconnects" was shown while
 * stopped, which is the one state in which it will not.
 */
describe("what is said while stopped (P8)", () => {
  it("does not promise a reconnection that is not coming", async () => {
    await fresh();
    const first = await load();
    await startVault(first.plugin, "laptop");
    await synced(first.plugin);
    const saved = first.plugin.savedData as Record<string, unknown>;
    first.plugin.onunload();
    await first.plugin.closing;

    // The same server and the same row, a different device secret: refused
    // for good, because a credential the vault does not know is not something
    // another attempt improves on.
    const { decodeConfig, encodeConfig } = await import("../core/pairing.ts");
    const wrong = encodeConfig({
      ...decodeConfig(saved, "test"),
      deviceSecret: new Uint8Array(32).fill(7),
    });
    const other = await load(wrong);
    await until("it to stop", () => other.plugin.currentState.kind === "stopped");
    notices.length = 0;
    await other.plugin.syncNow();
    const said = notices.map((n) => n.message).join(" ");
    expect(said).toMatch(/has stopped/);
    expect(said).not.toMatch(/reconnects/);
    other.plugin.openHistory("note.md");
    expect(notices.at(-1)!.message).toMatch(/has stopped/);
    await expect(other.plugin.deletedNotes()).rejects.toThrow(/has stopped/);
  }, 300_000);
});

/**
 * review finding P9. A folder rename is one event, for the folder, and every
 * path under it moved without a word. Each file inside used to be reported
 * deleted at its old path and new at its new one.
 */
describe("renaming a folder (P9)", () => {
  it("produces no phantom deletions for the files inside it", async () => {
    await fresh();
    const { plugin, app } = await load();
    app.vault.adapter.seed("docs/one.md", "one");
    app.vault.adapter.seed("docs/two.md", "two");
    await startVault(plugin, "laptop");
    await synced(plugin);

    await app.vault.adapter.rename("docs", "moved");
    app.vault.fire("rename", { path: "moved" }, "docs");
    for (let i = 0; i < 4; i++) await plugin.syncNow();

    const client = (
      plugin as unknown as { client: { deleted(): Promise<{ notes: { path: string }[] }> } }
    ).client;
    const gone = (await client.deleted()).notes.map((v) => v.path);
    expect(gone, `deleted list was ${JSON.stringify(gone)}`).toEqual([]);
    expect(app.vault.adapter.text("moved/one.md")).toBe("one");
  }, 300_000);
});

/**
 * review finding P10. `basalt:restore` looked at one page of two hundred
 * versions, so a version older than that was one `basalt:history` would list
 * and this would then say did not exist.
 */
describe("restoring by uid from the command line (P10)", () => {
  it("pages back as far as it has to", async () => {
    await fresh();
    const { plugin, app } = await load();
    app.vault.adapter.seed("note.md", "first");
    await startVault(plugin, "laptop");
    await synced(plugin);
    app.vault.adapter.seed("note.md", "second", 9_000_000_000_000);
    await plugin.syncNow();

    const client = (plugin as unknown as { client: { findVersion: unknown; history: unknown } })
      .client;
    const versions = (await plugin.cliHandlers
      .get("basalt:history")!
      .handler({ path: "note.md" })) as string;
    const oldest = Number(versions.trim().split("\n").at(-1)!.split("\t")[0]);
    // Paged one at a time, so the version wanted is not on the first page.
    let pages = 0;
    const realHistory = (client.history as (p: string, o: unknown) => Promise<unknown[]>).bind(
      client,
    );
    client.history = async (path: string, opts: { before?: number; limit?: number }) => {
      pages++;
      return realHistory(path, { ...opts, limit: 1 });
    };
    const realFind = client.findVersion as (
      p: string,
      m: (v: unknown) => boolean,
      size?: number,
    ) => unknown;
    client.findVersion = (path: string, match: (v: unknown) => boolean) =>
      realFind.call(client, path, match, 1);

    const answer = (await plugin.cliHandlers
      .get("basalt:restore")!
      .handler({ path: "note.md", uid: oldest })) as string;
    expect(answer).toMatch(/^Restored to note \(restored \d+\)\.md/);
    expect(pages).toBeGreaterThan(1);
  }, 300_000);
});

/**
 * review finding P11 and P32 in TODO-NEW.md. A pairing string was saved and
 * announced as paired before the server had been reached, and two presses of
 * Pair made two secrets.
 */
describe("pairing honestly (P11, P32)", () => {
  it("reaches the server before saving a pairing, and saves nothing it could not reach", async () => {
    await fresh();
    const first = await load();
    const pairing = await startVault(first.plugin, "laptop");
    await synced(first.plugin);

    // A server that is not there.
    const dead = pairing;
    const second = await load();
    const { url } = { url: server.wsUrl };
    await server.cleanup();
    await expect(second.plugin.pair(dead, "desktop")).rejects.toThrow(/could not connect|closed/);
    expect(second.plugin.paired).toBe(false);
    expect(second.plugin.savedData).toBe(null);
    expect(second.plugin.currentState.kind).toBe("unpaired");
    void url;
  }, 300_000);

  it("refuses a pairing the server refuses, and saves nothing", async () => {
    await fresh();
    const first = await load();
    await startVault(first.plugin, "laptop");
    await synced(first.plugin);

    // A string for the same server with a secret the vault was not claimed with.
    const { formatPairing } = await import("../core/pairing.ts");
    const wrong = formatPairing({
      url: server.wsUrl,
      vaultId: "default",
      secret: new Uint8Array(32).fill(9),
    });
    const second = await load();
    await expect(second.plugin.pair(wrong, "desktop")).rejects.toThrow(/auth/i);
    expect(second.plugin.paired).toBe(false);
    expect(second.plugin.savedData).toBe(null);
  }, 300_000);

  it("offers unlink when a new vault's claim is refused for good", async () => {
    await fresh();
    const { plugin } = await load();
    // A setup string with the wrong token: the claim is refused, for ever.
    // Reported to whoever asked rather than left to a retry that cannot win.
    await expect(plugin.pairFirst(`${server.wsUrl}#not-the-token`, "laptop")).rejects.toThrow(
      /could not register itself/,
    );
    await until("it to stop", () => plugin.currentState.kind === "stopped");
    const said = notices.map((n) => n.message).join(" ");
    expect(said).toMatch(/could not join/);
    expect(said).toMatch(/unlink/i);
    expect(said).not.toMatch(/syncing/);
  }, 300_000);

  it("runs one pairing at a time (P32)", async () => {
    await fresh();
    const { plugin } = await load();
    const [a, b] = await Promise.allSettled([startVault(plugin, "one"), startVault(plugin, "two")]);
    const outcomes = [a.status, b.status].sort();
    expect(outcomes).toEqual(["fulfilled", "rejected"]);
    const rejected = [a, b].find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(String(rejected.reason)).toMatch(/already/);
    // One secret, on disk and running.
    await synced(plugin);
    const saved = plugin.savedData as Record<string, string>;
    expect(saved["device"]).toBe(plugin.deviceName);
  }, 300_000);

  it("makes up a device name that tells two blank ones apart", async () => {
    await fresh();
    const a = await load();
    const pairing = await startVault(a.plugin, "   ");
    await synced(a.plugin);
    const b = await load();
    await b.plugin.pair(pairing, "");
    await synced(b.plugin);
    expect(a.plugin.deviceName).toMatch(/^obsidian-[0-9a-f]{4}$/);
    expect(b.plugin.deviceName).toMatch(/^obsidian-[0-9a-f]{4}$/);
    expect(a.plugin.deviceName).not.toBe(b.plugin.deviceName);
  }, 300_000);
});

/**
 * review finding P13. `addStatusBarItem` is declared "not available on mobile"
 * and was called unguarded.
 */
describe("on a phone (P13)", () => {
  it("adds no status bar item and still says everything on the ribbon", async () => {
    await fresh();
    Platform.isMobileApp = true;
    try {
      const { plugin } = await load();
      expect(plugin.statusBarItems).toHaveLength(0);
      await startVault(plugin, "phone");
      await until("a sync", () => plugin.currentState.kind === "synced");
      expect(plugin.ribbonIcons[0]!.el.attributes.get("aria-label")).toMatch(/^Basalt: .*as of/);
    } finally {
      Platform.isMobileApp = false;
    }
  }, 300_000);
});

/**
 * review finding P22. Every row was called recoverable, including the ones drawn
 * a few lines down as purged.
 */
describe("the recovery header (P22)", () => {
  const note = (path: string, restorable: number) => ({
    uid: 1,
    path,
    size: 1,
    ctime: 0,
    mtime: 0,
    folder: false,
    deleted: true,
    device: "d",
    chunks: 0,
    contentId: "-empty-",
    restorable,
  });

  it("counts what can come back and what cannot, separately", () => {
    const text = describeDeleted({
      notes: [note("a.md", 3), note("b.md", 0), note("c.md", 0)],
      more: false,
    });
    expect(text).toMatch(/1 note is recoverable/);
    expect(text).toMatch(/2 notes are listed but cannot be restored/);
    expect(text).not.toMatch(/all/);
  });

  it("says when the list is cut short, without pointing at a command line", () => {
    const text = describeDeleted({ notes: [note("a.md", 3)], more: true });
    expect(text).toMatch(/older deletions than the 1 shown/);
    expect(text).not.toMatch(/basalt deleted/);
  });
});

/**
 * P31 in TODO-NEW.md. A restore that landed on disk and then could not be
 * uploaded was reported as a failure, and a retry made a second copy.
 */
describe("a restore whose upload fails (P31)", () => {
  it("is reported as restored here and not yet sent", async () => {
    await fresh();
    const { plugin, app } = await load();
    app.vault.adapter.seed("gone.md", "bring me back");
    await startVault(plugin, "laptop");
    await synced(plugin);
    await app.vault.adapter.remove("gone.md");
    await plugin.syncNow();
    const deletion = (await plugin.deletedNotes()).notes.find((n) => n.path === "gone.md")!;

    // The upload after the restore cannot save its index.
    app.vault.adapter.fault = (op, path) =>
      (op === "writeBinary" || op === "append") && path.includes("/plugins/basalt/")
        ? new Error("EACCES: index")
        : undefined;
    const done = await plugin.recover(deletion);
    expect(done.path).toBe("gone.md");
    expect(done.sent).toBe(false);
    expect(done.why).toMatch(/EACCES/);
    expect(app.vault.adapter.text("gone.md")).toBe("bring me back");
  }, 300_000);
});

/**
 * P-D1 in the 0.3.0 review. The plugin handed the modal a finished sentence and
 * the modal wrapped it in a second one, so every restore from History read
 * "Restored to Restored note.md. Sent to your other devices., because something
 * is already at note.md." The fakes in history.test.ts hand back paths, so
 * nothing pinned the shape the plugin itself produces: this does, through the
 * modal, by pressing the button a person presses.
 */
/**
 * P-D8 in the 0.3.0 review. Obsidian Sync puts version history on the file
 * menu, so this plugin does too, and until now the only thing asserted about
 * it was that a handler had been registered: what the entry says and what
 * clicking it does were untested, which is the whole of the feature.
 */
describe("version history on the file menu (P-D8)", () => {
  /**
   * Just enough of Obsidian's `Menu`: `addItem` hands a builder to the
   * caller and keeps what it built. The real one returns `this` from every
   * setter so they chain, which is the only shape the plugin depends on.
   */
  function fakeMenu() {
    const items: { title: string; icon: string; click(): void }[] = [];
    const menu = {
      addItem(build: (item: unknown) => void): void {
        const item = { title: "", icon: "", click: () => {} };
        build({
          setTitle(title: string) {
            item.title = title;
            return this;
          },
          setIcon(icon: string) {
            item.icon = icon;
            return this;
          },
          onClick(fn: () => void) {
            item.click = fn;
            return this;
          },
        });
        items.push(item);
      },
    };
    return { menu, items };
  }

  it("opens the history of the file the menu was opened on", async () => {
    await fresh();
    const { plugin, app } = await load();
    app.vault.adapter.seed("daily/note.md", "text");
    await startVault(plugin, "laptop");
    await synced(plugin);

    // A decoy. Proving "not the active file" against no active file at all
    // proves nothing: a regression that reached for `getActiveFile()` would
    // have read undefined and opened the clicked one anyway (N8).
    app.workspace.activeFile = { path: "other.md", extension: "md" };

    const { menu, items } = fakeMenu();
    app.workspace.fire("file-menu", menu, { path: "daily/note.md", extension: "md" });
    expect(items.map((i) => i.title)).toEqual(["Basalt: version history"]);
    expect(items[0]!.icon).toBe("history");

    modals.length = 0;
    items[0]!.click();
    // That file, not whichever one happens to be open: the menu is the one
    // place where the file acted on is not the active one.
    await until("the history modal", () => modals.length > 0);
    expect(modals.at(-1)!.titleEl.allText()).toBe("History of daily/note.md");
  }, 300_000);

  it("puts nothing on the menu of a folder", async () => {
    const { plugin, app } = await load();
    expect(plugin.paired).toBe(false);
    const { menu, items } = fakeMenu();
    // A TFolder has no extension, and there is no history of a folder.
    app.workspace.fire("file-menu", menu, { path: "daily" });
    expect(items).toEqual([]);
  });
});

describe("what History says after a restore (P-D1)", () => {
  /** The buttons the newest modal drew, in the order it drew them. */
  function buttons(): { text: string; click(): void }[] {
    const found: { text: string; click(): void }[] = [];
    const visit = (n: FakeEl): void => {
      if (n.tag === "button") found.push({ text: n.allText(), click: () => n.fire("click") });
      for (const c of n.children) visit(c);
    };
    visit(modals[modals.length - 1]!.contentEl);
    return found;
  }

  async function restoreFromHistory(plugin: Testable): Promise<string> {
    notices.length = 0;
    plugin.openHistory("note.md");
    await until("a Restore button", () => buttons().some((b) => b.text.includes("Restore")));
    buttons()
      .find((b) => b.text.includes("Restore"))!
      .click();
    await until("a notice about the restore", () => notices.length > 0);
    return notices.map((n) => n.message).join(" ");
  }

  it("says it once, and still says when the copy has not been sent", async () => {
    await fresh();
    const { plugin, app } = await load();
    app.vault.adapter.seed("note.md", "first");
    await startVault(plugin, "laptop");
    await synced(plugin);

    const said = await restoreFromHistory(plugin);
    expect(said, "the notice was built from another notice").not.toMatch(/Restored to Restored/);
    expect(said).toMatch(
      /^Restored to note \(restored \d+\)\.md, because something is already at note\.md\. Sent to your other devices\.$/,
    );

    // The other half: a restore that landed here and could not be uploaded
    // has to say so from this path too, which is what returning a path
    // rather than the outcome would have thrown away.
    app.vault.adapter.fault = (op, path) =>
      (op === "writeBinary" || op === "append") && path.includes("/plugins/basalt/")
        ? new Error("EACCES: index")
        : undefined;
    const stuck = await restoreFromHistory(plugin);
    expect(stuck).toMatch(/will be sent when the next sync succeeds: .*EACCES/);
  }, 300_000);
});

/**
 * P-D2 and P-D3 in the 0.3.0 review. Three things carry on running across an
 * unlink: the settle save started by a connection, a Sync now the person asked
 * for, and a restore waiting for its upload. All three used to speak for a
 * vault that had already been removed.
 */
describe("what is still in flight when a vault is unlinked (P-D2, P-D3)", () => {
  /** Holds the next call to `settle`, so an unlink can happen underneath it. */
  function holdSettle(plugin: Testable): { reached: () => boolean; release: () => void } {
    const client = (plugin as unknown as { client: { settle(o: unknown): Promise<unknown> } })
      .client;
    const real = client.settle.bind(client);
    let reached = false;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    client.settle = async (o: unknown) => {
      reached = true;
      await gate;
      return real(o);
    };
    return { reached: () => reached, release };
  }

  it("does not put the pairing back on disk after unlink (P-D2)", async () => {
    await fresh();
    const { plugin } = await load();
    await startVault(plugin, "laptop");
    await synced(plugin);
    expect(plugin.savedData).not.toBe(null);

    // A config write of the shape a conversion makes, in flight past its own
    // generation check, and slower than the whole of unlink. Only the first
    // one is held: unlink's own write of null must not be, or nothing lands.
    const { decodeConfig } = await import("../core/pairing.ts");
    const inner = plugin as unknown as {
      generation: number;
      saveDuringRun(mine: number, config: unknown): Promise<void>;
    };
    const config = decodeConfig(plugin.savedData, "test");
    let saves = 0;
    const realSave = plugin.saveData.bind(plugin);
    plugin.saveData = async (data: unknown) => {
      if (++saves === 1) await sleep(300);
      return realSave(data);
    };

    const settling = inner.saveDuringRun(inner.generation, config).catch(() => undefined);
    await plugin.unlink();
    await settling;

    // The one that matters: what a restart would read. A pairing here means
    // the next start syncs a vault the person removed.
    expect(plugin.savedData, "the conversion's save landed on top of the unlink").toBe(null);
    expect(plugin.paired).toBe(false);
    expect(plugin.currentState.kind).toBe("unpaired");
  }, 300_000);

  /**
   * R10. The same race with two saves in the air. A conversion makes three,
   * and holding only the newest let an older one land its pairing on top of
   * the null that unlink had just written.
   */
  it("waits for every save in flight, not just the newest (R10)", async () => {
    await fresh();
    const { plugin } = await load();
    await startVault(plugin, "laptop");
    await synced(plugin);
    expect(plugin.savedData).not.toBe(null);

    const { decodeConfig } = await import("../core/pairing.ts");
    const inner = plugin as unknown as {
      generation: number;
      saveDuringRun(mine: number, config: unknown): Promise<void>;
    };
    const config = decodeConfig(plugin.savedData, "test");

    // The first save is the slow one and the second is quick, so the newest
    // is not the one still in the air when unlink asks.
    let saves = 0;
    const realSave = plugin.saveData.bind(plugin);
    plugin.saveData = async (data: unknown) => {
      if (++saves === 1) await sleep(400);
      return realSave(data);
    };

    const first = inner.saveDuringRun(inner.generation, config).catch(() => undefined);
    const second = inner.saveDuringRun(inner.generation, config).catch(() => undefined);
    await plugin.unlink();
    await Promise.all([first, second]);

    expect(plugin.savedData, "an older save landed on top of the unlink").toBe(null);
    expect(plugin.paired).toBe(false);
  }, 300_000);

  /**
   * The other half of the same guarantee, and the one that covers a save that
   * had not started when the vault was unlinked: a retired run may not write
   * the config at all.
   */
  it("refuses a config write from a run that has been retired", async () => {
    await fresh();
    const { plugin } = await load();
    await startVault(plugin, "laptop");
    await synced(plugin);
    const { decodeConfig } = await import("../core/pairing.ts");
    const inner = plugin as unknown as {
      generation: number;
      saveDuringRun(mine: number, config: unknown): Promise<void>;
    };
    const config = decodeConfig(plugin.savedData, "test");
    const stale = inner.generation;
    await plugin.unlink();
    await expect(inner.saveDuringRun(stale, config)).rejects.toThrow(/no longer paired/);
    expect(plugin.savedData).toBe(null);
  }, 300_000);

  it("does not report a pass into a vault that is no longer there (P-D3)", async () => {
    await fresh();
    const { plugin, app } = await load();
    app.vault.adapter.seed("note.md", "text");
    await startVault(plugin, "laptop");
    await synced(plugin);

    const gate = holdSettle(plugin);
    const pass = plugin.syncNow();
    await until("the pass to reach settle", gate.reached);
    await plugin.unlink();
    notices.length = 0;
    gate.release();
    await pass;

    // Unpaired is the truth. "Basalt has stopped" or a summary of a pass
    // over a vault that is gone are both louder than the truth and wrong.
    expect(plugin.currentState.kind).toBe("unpaired");
    expect(notices.map((n) => n.message).join(" ")).toBe("");
  }, 300_000);

  it("does not promise a next sync to a restore after unlink (P-D3)", async () => {
    await fresh();
    const { plugin, app } = await load();
    app.vault.adapter.seed("gone.md", "bring me back");
    await startVault(plugin, "laptop");
    await synced(plugin);
    await app.vault.adapter.remove("gone.md");
    await plugin.syncNow();
    const deletion = (await plugin.deletedNotes()).notes.find((n) => n.path === "gone.md")!;

    const gate = holdSettle(plugin);
    const restoring = plugin.recover(deletion);
    await until("the restore to reach its upload", gate.reached);
    await plugin.unlink();
    gate.release();
    const done = await restoring;

    expect(app.vault.adapter.text("gone.md")).toBe("bring me back");
    expect(done.sent).toBe(false);
    const said = describeRestore(deletion, done);
    expect(said, "promised a sync that cannot happen").not.toMatch(/next sync succeeds/);
    expect(said).toMatch(/on this device and nowhere else/);
  }, 300_000);
});

/**
 * P33 in TODO-NEW.md. One permanently refused file showed the same green
 * check as a clean vault.
 */
describe("synced, with files that need a person (P33)", () => {
  it("is not the plain check", async () => {
    const { plugin } = await load();
    const set = (s: unknown) => (plugin as unknown as { setState(s: unknown): void }).setState(s);
    set({ kind: "synced", summary: "up to date", at: 1_700_000_000_000, refused: 0 });
    expect(statusIcon(plugin)).toBe("check");
    expect(plugin.statusBarItems[0]!.cls).not.toContain("basalt-attention");
    set({ kind: "synced", summary: "1 stuck", at: 1_700_000_000_000, refused: 1 });
    expect(statusIcon(plugin)).not.toBe("check");
    expect(plugin.statusBarItems[0]!.cls).toContain("basalt-attention");
    expect(status(plugin)).toMatch(/1 file needs attention/);
  });
});

/**
 * P34 and P35 in TODO-NEW.md. The gap between `exists` and `read`, and the
 * command-line handlers throwing out of their channel.
 */
describe("small honesties (P34, P35)", () => {
  it("reads a note that is gone as nothing, not as a failure (P34)", async () => {
    const { plugin, app } = await load();
    const source = plugin.historySource();
    expect(await source.currentText("never.md")).toBeUndefined();
    app.vault.adapter.seed("here.md", "text");
    expect(await source.currentText("here.md")).toBe("text");

    // Deleted between being looked for and being read: what a person
    // deleting the note while its history loads does.
    app.vault.adapter.seed("gone.md", "about to go");
    const adapter = app.vault.adapter;
    const realExists = adapter.exists.bind(adapter);
    adapter.exists = async (path: string) => {
      const was = await realExists(path);
      if (path === "gone.md") await adapter.remove(path);
      return was;
    };
    await expect(source.currentText("gone.md")).resolves.not.toThrow();
  });

  it("answers the command line in words, whatever happens (P35)", async () => {
    await fresh();
    const { plugin } = await load();
    const history = plugin.cliHandlers.get("basalt:history")!.handler;
    const restore = plugin.cliHandlers.get("basalt:restore")!.handler;
    expect(await history({})).toMatch(/needs a path/);
    expect(await history({ path: "x.md" })).toMatch(/not paired/);
    expect(await restore({ path: "x.md" })).toMatch(/needs a uid/);

    await startVault(plugin, "laptop");
    await synced(plugin);
    expect(await history({ path: "nothing-here.md" })).toMatch(/No history/);
    const client = (plugin as unknown as { client: { history: unknown } }).client;
    client.history = async () => {
      throw new Error("the wire broke");
    };
    expect(await history({ path: "x.md" })).toMatch(/could not ask: the wire broke/);
    expect(await restore({ path: "x.md", uid: 1 })).toMatch(/could not restore: the wire broke/);
  }, 300_000);
});

/**
 * An Obsidian without `registerCliHandler` must still get a whole plugin.
 *
 * It arrived in 1.12.2 and everything else this plugin needs is older, so
 * declaring 1.12.2 would exclude people for an optional integration. Calling a
 * method that is not there throws inside onload, and onload stops where it
 * throws: the commands after it never register and the plugin half exists with
 * nothing saying why.
 */
describe("an older Obsidian", () => {
  it("loads everything except the command line integration", async () => {
    const { plugin } = await load(null, undefined, undefined, (p) => {
      // Shadowed on the instance rather than deleted: the stub declares
      // this on the prototype, where a delete of an own property does
      // nothing at all and the method is still found.
      (p as { registerCliHandler?: unknown }).registerCliHandler = undefined;
    });

    expect(plugin.commands.map((c) => c.id).sort()).toEqual([
      "recover-deleted",
      "show-status",
      "sync-now",
      "version-history",
    ]);
    expect(plugin.ribbonIcons.map((r) => r.title)).toEqual(["Basalt Sync"]);
    expect(plugin.statusBarItems.length).toBe(1);
    // The four vault events and the file-menu entry, all after the guard.
    expect(plugin.registeredEvents.length).toBe(5);
    expect([...plugin.cliHandlers.keys()]).toEqual([]);
  });
});

/**
 * The status bar is a glyph and a tooltip, so every state has to produce both.
 *
 * The settled state has no tone, and painting it called addClass with an empty
 * string, which throws. It surfaced as a sync failure complaining about a
 * DOMTokenList, which says nothing at all about the status bar it came from.
 */
describe("what the status bar shows", () => {
  const states = [
    { kind: "unpaired" },
    { kind: "connecting" },
    { kind: "syncing", path: "Notes/one.md" },
    { kind: "synced", summary: "up to date", at: 1_700_000_000_000, refused: 0 },
    { kind: "synced", summary: "1 stuck", at: 1_700_000_000_000, refused: 1 },
    { kind: "failed", why: "could not save the index", at: 1_700_000_000_000 },
    { kind: "offline", why: "no route to host", retryAt: 1_700_000_000_000, refused: false },
    { kind: "stopped", why: "not authorised" },
  ] as const;

  it("gives every state a glyph and a sentence, and never throws", async () => {
    const { plugin } = await load();
    const seen = new Set<string>();
    for (const state of states) {
      expect(() =>
        (plugin as unknown as { setState(s: unknown): void }).setState(state),
      ).not.toThrow();
      const icon = statusIcon(plugin);
      expect(icon, `${state.kind} chose no glyph`).not.toBe("");
      expect(status(plugin), `${state.kind} has no tooltip`).toMatch(/^Basalt Sync: \S/);
      seen.add(icon);
    }
    // Not all the same glyph, or the bar would say nothing by changing.
    expect(seen.size).toBeGreaterThan(2);
  });

  /**
   * `summarise` returns a fragment, because three of its four callers put it
   * after a colon. The fourth starts a sentence with it, in the tooltip and on
   * the panel's first line, and it read "up to date, as of 9:41 PM." under a
   * heading and above two proper sentences. Every other state here already
   * capitalises; only the settled one, the one seen most, did not. Found in a
   * screenshot, like the last three layout faults, and not by any of these.
   */
  it("starts every state's sentence the way a sentence starts", async () => {
    const { plugin } = await load();
    for (const state of states) {
      (plugin as unknown as { setState(s: unknown): void }).setState(state);
      const sentence = status(plugin).replace(/^Basalt Sync: /, "");
      expect(sentence, `${state.kind} opens mid-sentence`).toMatch(/^[A-Z0-9]/);
    }
  });
});

/**
 * Working and settled must not share a glyph. If they do, the only thing
 * separating "still syncing" from "done" is whether the icon is spinning, and
 * a spin is not something you can see in a glance at a status bar.
 */
it("does not draw the settled state the same as the working one", async () => {
  const { plugin } = await load();
  const set = (s: unknown) => (plugin as unknown as { setState(s: unknown): void }).setState(s);
  set({ kind: "syncing", path: "a.md" });
  const working = statusIcon(plugin);
  set({ kind: "synced", summary: "up to date", at: 1_700_000_000_000, refused: 0 });
  expect(statusIcon(plugin)).not.toBe(working);
});

/**
 * The status bar must stay legible against the status bar.
 *
 * The faint states measured 2.57:1 in dark and 2.12:1 in light, both under the
 * 3:1 a UI icon needs, and offline (the state meaning notes are not reaching
 * the server) was the faintest thing on screen. Nothing here can measure a
 * colour, so it pins the decision instead: only the error state is tinted, and
 * everything else inherits the status bar's own colour.
 */
it("tints only the state that is actually wrong", async () => {
  const { plugin } = await load();
  const set = (s: unknown) => (plugin as unknown as { setState(s: unknown): void }).setState(s);
  const tone = () =>
    (plugin as unknown as { statusEl: { cls: string } }).statusEl.cls
      .split(" ")
      .filter((c) => c.startsWith("basalt-") && c !== "basalt-status-icon");

  for (const s of [
    { kind: "unpaired" },
    { kind: "offline", why: "x", retryAt: 1, refused: false },
  ]) {
    set(s);
    expect(tone(), `${s.kind} should carry no colour`).not.toContain("basalt-muted");
  }
  set({ kind: "stopped", why: "x" });
  expect(tone()).toContain("basalt-attention");
});

/**
 * Adding a device from the panel: an invite from a device that has the vault,
 * and the recovery key when there is no such device left.
 *
 * The invite is the ordinary path. What it carries is the vault's data key,
 * which is what a device holds anyway, and the redemption registers the new
 * device's own row; no root reaches either end, which is what makes revoking
 * one of them mean something. The recovery key stays written down and offline,
 * and the panel says so where it used to be shown.
 */
describe("adding a device from the panel", () => {
  it("adds one with an invite, and neither device ends up with a root", async () => {
    await fresh();
    const first = await load();
    first.app.vault.adapter.seed("note.md", "# From the first device\n");
    await startVault(first.plugin, "laptop");
    await synced(first.plugin);

    // The invite comes out of the panel, from the live connection, because
    // the server has to store it.
    built.length = 0;
    first.plugin.ribbonIcons[0]!.callback();
    const adding = built.find((s) => s.name === "Add another device")!;
    await adding.buttons.find((b) => b.label === "Create invite")!.click();
    const shown = notices.map((n) => n.message).join(" ");
    expect(shown, "the invite was not offered for copying").toMatch(/Copied|clipboard/);
    const invite = (await first.plugin.createInvite()).invite;
    expect(invite).toMatch(/^basalt3i_/);

    const second = await load();
    built.length = 0;
    second.plugin.ribbonIcons[0]!.callback();
    built.find((s) => s.name === "Device name")!.texts[0]!.type("phone");
    built.find((s) => s.name === "Invite or recovery key")!.texts[0]!.type(invite);
    await built.find((s) => s.buttons.some((b) => b.label === "Pair"))!.buttons[0]!.click();
    expect(second.plugin.paired).toBe(true);
    await synced(second.plugin);
    await until("the note to arrive", () => second.app.vault.adapter.text("note.md") !== undefined);
    expect(second.app.vault.adapter.text("note.md")).toBe("# From the first device\n");

    // Two devices, two credentials, one data key, and no root on either. The
    // invite handed over the data key and nothing that could add a third
    // device or rewrap the vault.
    const a = first.plugin.savedData as Record<string, string>;
    const b = second.plugin.savedData as Record<string, string>;
    expect(a["secret"], "the first device is holding the vault's root").toBeUndefined();
    expect(b["secret"], "an invite handed over the vault's root").toBeUndefined();
    expect(b["deviceId"]).not.toBe(a["deviceId"]);
    expect(b["deviceSecret"]).not.toBe(a["deviceSecret"]);
    expect(b["dataKey"]).toBe(a["dataKey"]);

    // And each is a row the other can see and cut off.
    const listed = await first.plugin.devices();
    expect(listed.devices.map((d) => d.name).sort()).toEqual(["laptop", "phone"]);
  }, 300_000);

  it("spends an invite once, and leaves nothing behind on the second try", async () => {
    await fresh();
    const first = await load();
    await startVault(first.plugin, "laptop");
    await synced(first.plugin);
    const invite = (await first.plugin.createInvite()).invite;

    const second = await load();
    await second.plugin.pair(invite, "phone");
    expect(second.plugin.paired).toBe(true);

    const third = await load();
    await expect(third.plugin.pair(invite, "tablet")).rejects.toThrow(/auth/i);
    expect(third.plugin.paired).toBe(false);
    expect(third.plugin.savedData, "a spent invite left a pairing on disk").toBe(null);
    const listed = await first.plugin.devices();
    expect(listed.devices).toHaveLength(2);
  }, 300_000);

  it("adds one with the recovery key, and neither device keeps it", async () => {
    await fresh();
    const first = await load();
    first.app.vault.adapter.seed("note.md", "# From the first device\n");
    const key = await startVault(first.plugin, "laptop");
    await synced(first.plugin);

    const second = await load();
    built.length = 0;
    second.plugin.ribbonIcons[0]!.callback();
    built.find((s) => s.name === "Device name")!.texts[0]!.type("phone");
    built.find((s) => s.name === "Invite or recovery key")!.texts[0]!.type(key);
    await built.find((s) => s.buttons.some((b) => b.label === "Pair"))!.buttons[0]!.click();
    expect(second.plugin.paired).toBe(true);
    await synced(second.plugin);
    await until("the note to arrive", () => second.app.vault.adapter.text("note.md") !== undefined);
    expect(second.app.vault.adapter.text("note.md")).toBe("# From the first device\n");

    // Two devices, two credentials, one data key, and the root on neither.
    const a = first.plugin.savedData as Record<string, string>;
    const b = second.plugin.savedData as Record<string, string>;
    expect(a["secret"], "the first device is holding the vault's root").toBeUndefined();
    expect(b["secret"], "the second device is holding the vault's root").toBeUndefined();
    expect(b["deviceId"]).not.toBe(a["deviceId"]);
    expect(b["deviceSecret"]).not.toBe(a["deviceSecret"]);
    // The same data key, or one of them would be sealing under a schedule the
    // other cannot derive.
    expect(b["dataKey"]).toBe(a["dataKey"]);

    // And each is a row the other can see and cut off.
    const listed = await first.plugin.devices();
    expect(listed.devices.map((d) => d.name).sort()).toEqual(["laptop", "phone"]);
  }, 300_000);

  it("refuses a damaged invite string, and saves nothing", async () => {
    await fresh();
    const { plugin } = await load();
    await expect(plugin.pair("basalt3i_notreallyaninvite", "tablet")).rejects.toThrow(
      /this invite is damaged/,
    );
    expect(plugin.paired).toBe(false);
    expect(plugin.savedData).toBe(null);
  }, 300_000);

  it("leaves nothing behind when the recovery key is not the vault's", async () => {
    // C39, I13. A key the server does not know used to be saved and announced
    // as paired, and the first sign of it was a status bar saying stopped.
    await fresh();
    const first = await load();
    const key = await startVault(first.plugin, "laptop");
    await synced(first.plugin);
    const { parsePairing, formatPairing } = await import("../core/pairing.ts");
    const stranger = formatPairing({ ...parsePairing(key), secret: new Uint8Array(32).fill(9) });

    const second = await load();
    await expect(second.plugin.pair(stranger, "phone")).rejects.toThrow(/auth/i);
    expect(second.plugin.paired).toBe(false);
    expect(second.plugin.savedData, "a refused pairing was left on disk").toBe(null);
  }, 300_000);

  it("shows the recovery key once when a vault is started, and says to write it down", async () => {
    await fresh();
    const { plugin } = await load();
    plugin.ribbonIcons[0]!.callback();
    built.find((s) => s.name === "Setup string")!.texts[0]!.type(server.setup);
    built.find((s) => s.name === "Device name")!.texts[0]!.type("laptop");
    await built
      .find((s) => s.buttons.some((b) => b.label === "Start a new vault"))!
      .buttons[0]!.click();

    const shown = modals.at(-1)!.contentEl.allText();
    expect(shown).toMatch(/Write this down/);
    // What it is for, on the `?` beside the key: the screen itself says the
    // two things somebody has to act on now, which is write it down and keep
    // it offline.
    expect(shown).toMatch(/keep it offline/);
    expect(tooltips()).toMatch(/only way back/);
    // The key itself, taken off the screen, because this is the one moment it
    // exists anywhere: no device keeps it and nothing reprints it.
    const key = shown.split(/\s+/).find((w) => w.startsWith("basalt3_"))!;
    expect(key, "no recovery key was shown").toBeDefined();

    // Acknowledged, it is gone from the panel, and reopening does not bring
    // it back on its own.
    await built
      .find((s) => s.buttons.some((b) => b.label === "I have written it down"))!
      .buttons[0]!.click();
    expect(modals.at(-1)!.contentEl.allText()).not.toContain(key);
    modals.at(-1)!.close();
    built.length = 0;
    plugin.ribbonIcons[0]!.callback();
    expect(modals.at(-1)!.contentEl.allText()).not.toContain(key);
    await synced(plugin);
  }, 300_000);

  it("says where the recovery key is rather than offering to show it", async () => {
    await fresh();
    const { plugin } = await load();
    await startVault(plugin, "laptop");
    await synced(plugin);
    built.length = 0;
    plugin.ribbonIcons[0]!.callback();

    const key = keyOf(plugin);
    expect(modals.at(-1)!.contentEl.allText(), "the key was on screen unasked").not.toContain(key);
    const setting = built.find((s) => s.name === "Recovery key")!;
    // Said, not shown, because there is nothing to show: the key was
    // displayed once and this device kept its own credential instead. The row
    // says where the key is; the `?` beside the section says why it is there
    // and not here.
    expect(tooltips()).toMatch(/not kept here/);
    expect(tooltips()).toMatch(/not on this device and cannot be shown again/);
    expect(tooltips()).toMatch(/register itself again after being revoked/);
    expect(setting.buttons, "the panel offers to show a key it does not have").toEqual([]);
    expect(modals.at(-1)!.contentEl.allText()).not.toContain(key);
  }, 300_000);

  it("shows both cursors in the panel (I11)", async () => {
    await fresh();
    const { plugin, app } = await load();
    app.vault.adapter.seed("one.md", "1");
    await startVault(plugin, "laptop");
    await synced(plugin);
    await until("the cursor to move", () => (plugin.cursors()?.local ?? 0) > 0);

    plugin.ribbonIcons[0]!.callback();
    const shown = modals.at(-1)!.contentEl.allText();
    const at = plugin.cursors()!;
    expect(at.local).toBeGreaterThan(0);
    expect(shown).toContain(`Local cursor ${at.local}, server cursor ${at.server}.`);
    // Not `at.server` against itself: reading the panel's own source proves
    // only that it is consistent, and the number was frozen at hello for as
    // long as this test has existed. This device has just uploaded and
    // caught up, so the server holds what it holds.
    expect(at.server, "the server cursor was stale").toBe(at.local);
  }, 300_000);
});

/**
 * The pairing form's device name, and the connection line under the status.
 *
 * Both are the same complaint from the same evening: the panel is the whole
 * interface, and it was not saying two things it already knew. It knew what
 * kind of machine it was running on and offered nothing, so every device was
 * called after the app. It knew the address, the protocol and the server's
 * build, and said "up to date, cursor 66".
 */
describe("what the panel knows and used to keep to itself", () => {
  /** The pairing form's name field, from the last render. */
  const nameField = () => built.find((s) => s.name === "Device name")!.texts[0]!;

  it("suggests a name for this device, and pairs under it", async () => {
    await fresh();
    const { plugin } = await load();
    Platform.isMacOS = true;
    try {
      plugin.ribbonIcons[0]!.callback();
      // In the field, not behind it as a placeholder. A placeholder is not a
      // value: the field was empty and so was what got used.
      const suggested = nameField().getValue();
      expect(suggested).toMatch(/^mac-[0-9a-f]{4}$/);

      built.find((s) => s.name === "Setup string")!.texts[0]!.type(server.setup);
      await built
        .find((s) => s.buttons.some((b) => b.label === "Start a new vault"))!
        .buttons[0]!.click();
      await synced(plugin);

      // Used, and used where it is read: the row in the device list, which is
      // what somebody looks at before revoking one.
      expect(plugin.deviceName).toBe(suggested);
      const { devices } = await plugin.devices();
      expect(devices.map((d) => d.name)).toEqual([suggested]);
    } finally {
      Platform.isMacOS = false;
    }
  }, 300_000);

  it("does not call an iPad a Mac", async () => {
    await fresh();
    const { plugin } = await load();
    // obsidian.d.ts: isMacOS is true on "a device that pretends to be one
    // (like iPhones and iPads)". Checked in the wrong order, every iPad in
    // the device list is a Mac.
    Platform.isIosApp = true;
    Platform.isTablet = true;
    Platform.isMacOS = true;
    try {
      plugin.ribbonIcons[0]!.callback();
      expect(nameField().getValue()).toMatch(/^ipad-[0-9a-f]{4}$/);
    } finally {
      Platform.isIosApp = false;
      Platform.isTablet = false;
      Platform.isMacOS = false;
    }
  }, 300_000);

  it("says what it is connected to, with the protocol and the server's build", async () => {
    await fresh();
    const { plugin } = await load();
    await startVault(plugin, "laptop");
    await synced(plugin);

    plugin.ribbonIcons[0]!.callback();
    const shown = modals.at(-1)!.contentEl.allText();
    const to = plugin.connection()!;
    // The address this device actually holds, rather than the one this test
    // knows: a panel that agreed with the test and not with the config would
    // be the bug.
    expect(to.url).toBe(server.wsUrl);
    expect(shown).toContain(`Connected to ${server.wsUrl}`);
    // From `ready` and nowhere else, and both of them present: an absent
    // build is what a server that never answered looks like.
    expect(to.server!.proto).toBe(4);
    // Not "unknown", which is what `readReady` puts there when the server did
    // not say. A panel showing the fallback as a build is the failure this
    // line exists for, and it reads exactly like a build.
    expect(to.server!.version, "the build is the fallback, not what ready said").not.toBe(
      "unknown",
    );
    expect(shown).toContain(`Protocol 4, basaltd ${to.server!.version}.`);
    expect(shown).not.toContain("Not connected");
    // A test server has nothing in front of it. What that costs is on the
    // line's `?` rather than in the line, because it is the same two clauses
    // on every open and the sentence is read on every open.
    expect(tooltips()).toMatch(/No TLS in front of this hop/);
    expect(tooltips()).toMatch(/credential and the note sizes are not/);
  }, 300_000);

  it("says the protocol and the build are unknown rather than leaving a gap", () => {
    // Rule 2 at the width of a sentence: a build missing because nothing is
    // connected reads exactly like a server that did not say, and they are
    // different states.
    const off = describeConnection({ url: "wss://homelab.tailnet.ts.net" });
    expect(off).toContain("Not connected to wss://homelab.tailnet.ts.net");
    expect(off).not.toMatch(/basaltd/);
    expect(off).not.toMatch(/Protocol/);

    const on = describeConnection({
      url: "wss://homelab.tailnet.ts.net",
      server: { proto: 4, version: "0.3.4" },
    });
    expect(on).toContain("Protocol 4, basaltd 0.3.4.");
    // The scheme is the whole of what is known about the hop, and wss is the
    // only thing that says something terminated TLS in front. It is the `?`
    // that says so now, because which server answered is what the line is for.
    expect(connectionDetail({ url: "wss://homelab.tailnet.ts.net" })).toContain("TLS in front");
    expect(connectionDetail({ url: "ws://192.168.1.20:3003" })).toContain("No TLS in front");
  });
});

/**
 * The device list in the panel, which is the only device management a plugin
 * device has.
 */
describe("the device list in the panel", () => {
  /**
   * Emptying the vault is the recovery key's, and no device holds one, so the
   * panel does not offer a button that could only ever be refused.
   *
   * The last row is always this device: reading the list at all means this
   * device connected. What it offers instead is the two things that do work,
   * the command that would do it and the local unlink that leaves the row
   * alone, because a refusal a person cannot act on sends them looking for a
   * worse route, and the worse route here is replacing the vault's secret and
   * pairing everything again.
   */
  it("offers no way to empty the vault, and says whose job that is", async () => {
    await fresh();
    const { plugin } = await load();
    await startVault(plugin, "laptop");
    await synced(plugin);

    built.length = 0;
    plugin.ribbonIcons[0]!.callback();
    await built.find((s) => s.name === "Devices")!.buttons[0]!.click();

    const row = built.find((s) => s.name.startsWith("laptop"))!;
    expect(row, "the panel did not list this device").toBeDefined();
    expect(
      row.buttons.map((b) => b.label),
      "the last row offered a button that cannot work",
    ).toEqual([]);

    const said = modals.at(-1)!.contentEl.allText();
    expect(said).toMatch(/last device/);
    expect(said).toMatch(/--allow-last --recovery-key/);
    expect(said).toMatch(/Unlink this vault/);
    // And the row is still there, because nothing was pressed and nothing was
    // sent: a panel that said this while the vault emptied itself would be
    // worse than one that said nothing.
    expect((await plugin.devices()).devices).toHaveLength(1);
  }, 300_000);

  /**
   * An invite that has not been redeemed is on screen beside the rows, and can
   * be cancelled from there.
   *
   * It was the one authority on a vault nothing could see. What the panel must
   * never show is the invite string itself, and it cannot: the server never
   * had the invite key, so what comes back is an identifier that redeems
   * nothing and says which invite to cancel.
   */
  it("puts the device rows under the Devices row, not above it", async () => {
    // Twice now the panel has grown a list that rendered above the setting
    // that fills it, so the rows read as belonging to whatever sat above.
    // Both times a screenshot found it and no test did, which is why this
    // one exists.
    await fresh();
    const { plugin } = await load();
    await startVault(plugin, "laptop");
    await synced(plugin);

    built.length = 0;
    plugin.ribbonIcons[0]!.callback();
    const heading = built.find((s) => s.name === "Devices")!;
    await heading.buttons[0]!.click();
    await until("the list to arrive", () => built.some((s) => s.name.includes("laptop")));

    // The stub does not render a setting's name into the DOM, so position is
    // the thing to assert: the container the rows are built into must come
    // after the row that offers them. Both are inside the one disclosure the
    // panel has now, so the children to look at are its children.
    const manage = modals.at(-1)!.contentEl.children.find((el) => el.tag === "details");
    expect(manage, "the panel has no disclosure to manage the vault from").toBeDefined();
    const kids = manage!.children;
    const row = built.find((b) => b.name.includes("laptop"))!;
    const at = kids.indexOf(heading.settingEl);
    const listAt = kids.findIndex((el) => el.children.includes(row.settingEl));
    expect(at, "the Devices row is not in the panel").toBeGreaterThanOrEqual(0);
    expect(listAt, "no container held the device rows").toBeGreaterThanOrEqual(0);
    expect(listAt, "the device rows rendered above the row that lists them").toBeGreaterThan(at);
  }, 300_000);

  it("shows outstanding invites beside the devices, and cancels one", async () => {
    await fresh();
    const first = await load();
    await startVault(first.plugin, "laptop");
    await synced(first.plugin);
    const issued = await first.plugin.createInvite();

    built.length = 0;
    first.plugin.ribbonIcons[0]!.callback();
    await built.find((s) => s.name === "Devices")!.buttons[0]!.click();
    await until("the list to arrive", () => built.some((s) => s.name === "Outstanding invite"));

    const row = built.find((s) => s.name === "Outstanding invite")!;
    expect(row.desc).toMatch(/adds one device/);
    expect(row.desc).toMatch(/expires/);
    // Never the string, which is the only thing that could redeem it.
    expect(modals.at(-1)!.contentEl.allText()).not.toContain(issued.invite);
    expect(modals.at(-1)!.contentEl.allText()).toMatch(/1 outstanding invite/);

    await row.buttons.find((b) => b.label === "Cancel")!.click();
    expect(notices.map((n) => n.message).join(" ")).toMatch(/no longer adds a device/);
    expect((await first.plugin.devices()).invites).toHaveLength(0);

    // And the string it cancelled no longer pairs anything.
    const second = await load();
    await expect(second.plugin.pair(issued.invite, "phone")).rejects.toThrow(/auth/i);
    expect(second.plugin.savedData, "a cancelled invite left a pairing on disk").toBe(null);
  }, 300_000);

  /**
   * A row nothing ever connected under is flagged, because it is the
   * reclaimable one.
   *
   * A redemption registers the row before the new device saves anything, so a
   * crash in that window strands a row rather than a device that believes it
   * is paired: the right way round, and the reason the rows that fill the cap
   * are the ones nothing signed in under. The panel says so rather than
   * leaving it to be inferred from a missing date.
   */
  it("flags a row nothing has ever connected under", async () => {
    await fresh();
    const first = await load();
    await startVault(first.plugin, "laptop");
    await synced(first.plugin);

    // A pairing that reached the server and then crashed.
    const issued = await first.plugin.createInvite();
    await redeemInvite(parseInvite(issued.invite), "the-one-that-crashed");

    built.length = 0;
    first.plugin.ribbonIcons[0]!.callback();
    await built.find((s) => s.name === "Devices")!.buttons[0]!.click();
    await until("the list to arrive", () => built.some((s) => s.desc.includes("added ")));

    const stranded = built.find((s) => s.name === "the-one-that-crashed")!;
    expect(stranded, "the panel did not list the stranded row").toBeDefined();
    expect(stranded.desc).toMatch(/never connected/);
    // And this device, which has connected, is not flagged: a marker on every
    // row says nothing.
    expect(built.find((s) => s.name.startsWith("laptop"))!.desc).toMatch(/last seen/);

    const said = modals.at(-1)!.contentEl.allText();
    expect(said).toMatch(/1 has never connected/);
    expect(said).toMatch(/holds a slot/);
  }, 300_000);

  /**
   * The ordinary case, which stays a device's to do: a phone cuts off a stolen
   * laptop without anybody finding the recovery key. Two presses, and the
   * second one means it.
   */
  it("revokes another device, behind a second press", async () => {
    await fresh();
    const first = await load();
    await startVault(first.plugin, "laptop");
    await synced(first.plugin);
    const invite = (await first.plugin.createInvite()).invite;
    const second = await load();
    await second.plugin.pair(invite, "phone");
    await synced(second.plugin);

    built.length = 0;
    first.plugin.ribbonIcons[0]!.callback();
    await built.find((s) => s.name === "Devices")!.buttons[0]!.click();
    const row = built.find((s) => s.name === "phone")!;
    const button = row.buttons[0]!;
    expect(button.label).toBe("Revoke");

    // One press asks, and changes nothing.
    await button.click();
    expect(button.label).toBe("Yes, revoke");
    expect((await first.plugin.devices()).devices).toHaveLength(2);
    expect(modals.at(-1)!.contentEl.allText()).toMatch(/will stop syncing at once/);

    // The second does it, and the revoked device finds out by being stopped.
    await button.click();
    expect((await first.plugin.devices()).devices.map((d) => d.name)).toEqual(["laptop"]);
    expect(notices.map((n) => n.message).join(" ")).toMatch(/still holds the vault's key/);
    await until(
      "the revoked device to be stopped",
      () => second.plugin.currentState.kind === "stopped",
    );
  }, 300_000);
});

/**
 * A server restored from an older backup, and the way a plugin device gets
 * back onto it (I10, improvements.md §5).
 *
 * The documented path for a plugin device was to unlink and pair again, which
 * works and costs the merge base: every note returns as an ancestor-less new
 * version, so the next edit made on two devices at once cannot merge and makes
 * conflict copies instead. The headless client has had `basalt rebase` for
 * this since I10; the plugin had the blunt tool on the devices least able to
 * clear up after it.
 *
 * What is asserted here is not that the two ends agree (rule 10). It is that
 * the note only this device holds is on another device afterwards, and that
 * the note the backup did hold is still there too.
 */
describe("rejoining a server that lost history (I10, plugin)", () => {
  /** A copy of the server's data directory, taken with the server stopped. */
  async function backupServer(): Promise<string> {
    const { cp } = await import("node:fs/promises");
    const { mkdtemp } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = await mkdtemp(join(tmpdir(), "basalt-plugin-backup-"));
    await server.whileStopped(async () => {
      await cp(server.dataDir, dir, { recursive: true });
    });
    return dir;
  }

  async function restoreServer(from: string): Promise<void> {
    const { cp, rm } = await import("node:fs/promises");
    await server.whileStopped(async () => {
      await rm(server.dataDir, { recursive: true, force: true });
      await cp(from, server.dataDir, { recursive: true });
    });
  }

  it("names the recovery, offers it behind two presses, and loses nothing", async () => {
    await fresh();
    const first = await load();
    first.app.vault.adapter.seed("before.md", "in the backup\n");
    await startVault(first.plugin, "laptop");
    await synced(first.plugin);
    await until("before.md to reach the server", () => (first.plugin.cursors()?.local ?? 0) > 0);

    const backup = await backupServer();

    // Written after the backup, so it is the note only this device holds.
    first.app.vault.adapter.seed("after.md", "written after the backup\n");
    await first.plugin.syncNow();
    await until("after.md to reach the server", () => (first.plugin.cursors()?.local ?? 0) > 1);
    const ahead = first.plugin.cursors()!.local;

    await restoreServer(backup);

    // The server is behind this device now, and refuses it for good.
    await until(
      "the cursor refusal",
      () => first.plugin.currentState.kind === "stopped",
      60_000,
    ).catch((err: Error) => {
      throw new Error(`${err.message}; the state is ${JSON.stringify(first.plugin.currentState)}`);
    });
    const stopped = first.plugin.currentState;
    expect(stopped.kind === "stopped" && stopped.recovery).toBe("rejoin");
    // The reason names the way out, rather than a documentation path (I10).
    expect(status(first.plugin)).toMatch(/basalt rebase --backup-taken/);
    expect(status(first.plugin)).toMatch(/Rejoin this server/);
    expect(status(first.plugin)).toMatch(/conflict copies instead of merging/);
    expect(notices.map((n) => n.message).join("\n")).toMatch(/basalt rebase --backup-taken/);

    // The panel offers it, and the first press is a question rather than an
    // answer: nothing has been touched by it.
    built.length = 0;
    first.plugin.ribbonIcons[0]!.callback();
    const row = built.find((s) => s.name === "Rejoin this server")!;
    expect(row, "the panel offered no way back").toBeDefined();
    expect(tooltips()).toMatch(/Nothing is deleted/);
    // On the panel itself, never behind the disclosure: a device the server
    // has refused has to say so, and offer the way out, on open.
    expect(
      modals.at(-1)!.contentEl.children,
      "the way back off a refused device is behind a disclosure",
    ).toContain(row.settingEl);
    const button = row.buttons[0]!;
    expect(button.warning, "a destructive action with no warning on it").toBe(true);
    await button.click();
    expect(modals.at(-1)!.contentEl.allText()).toContain(
      `This device is at version ${ahead} and the server is at`,
    );
    expect(button.label).toBe("Yes, rejoin");
    expect(first.plugin.paired, "the first press unpaired the vault").toBe(true);

    await button.click();
    await synced(first.plugin);

    // What only this device held is on the server again, as a second device
    // joining from scratch shows, and so is what the backup already had.
    const second = await load();
    await second.plugin.pair(keyOf(first.plugin), "phone");
    await synced(second.plugin);
    await until(
      "both notes to arrive",
      () =>
        second.app.vault.adapter.text("before.md") !== undefined &&
        second.app.vault.adapter.text("after.md") !== undefined,
    );
    expect(second.app.vault.adapter.text("after.md")).toBe("written after the backup\n");
    expect(second.app.vault.adapter.text("before.md")).toBe("in the backup\n");
  }, 300_000);

  it("refuses a rejoin on a device that is not ahead, and keeps syncing", async () => {
    await fresh();
    const { plugin, app } = await load();
    app.vault.adapter.seed("note.md", "one\n");
    await startVault(plugin, "laptop");
    await synced(plugin);

    await expect(plugin.rebase()).rejects.toThrow(/nothing to rebase/);

    // Refused before anything was touched: the index is still there, so the
    // next pass has nothing to re-upload.
    app.vault.adapter.seed("second.md", "two\n");
    await plugin.syncNow();
    const report = plugin.currentState;
    expect(report.kind).toBe("synced");
    expect(plugin.paired).toBe(true);
  }, 300_000);
});
