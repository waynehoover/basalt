/**
 * Rotation from the plugin, against a real server.
 *
 * Rotation was a headless-client command, and the runbook for a lost device
 * therefore assumed a machine with the CLI was to hand. The device somebody
 * loses is a phone, and so, often, is the only other device in their pocket
 * (improvements.md §1 and §5). This file is what makes the button safe to
 * offer, and it is deliberately the same shape as `cli/rotate.test.ts`: the
 * case that matters is not the happy one, it is the ordinary lost packet.
 *
 * The server commits the new credential, closes every other session, and only
 * then answers. A connection that goes in between leaves this device holding a
 * vault whose new root it may be the only holder of, and on a phone there is no
 * terminal to read a printed key out of. So the new secret is in `data.json`
 * before the request goes out, and the next connection tries it first: both
 * halves are here, the reply lost after the rotation committed and lost before
 * it.
 */

import type { App as ObsidianApp, PluginManifest } from "obsidian";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { TestServer, cleanupBinary, serverBinary } from "../core/test-server.ts";
import { App, Plugin as StubPlugin, built, modals, notices, resetStub } from "./stub.ts";
import BasaltPlugin from "./main.ts";

/**
 * Where the reply is lost, when a test says so.
 *
 * The frame either never goes out, or goes out and is answered and the answer
 * never gets back to the caller. Both are done here rather than by cutting a
 * socket, because a rotation that has committed and one that has not are what
 * the test is about, and a torn socket cannot be told to land on either side.
 */
let lose: "before-commit" | "after-commit" | "refused" | undefined;

vi.mock("../core/transport.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../core/transport.ts")>();
  class Transport extends actual.Transport {
    override async rotate(args: { auth: string; wrapped: string }): Promise<void> {
      if (lose === "before-commit") {
        throw new actual.ConnectionError("the connection went before the rotate was sent");
      }
      if (lose === "refused") {
        // What the server answers a rotate whose credential is no longer the
        // vault's, because another device rotated first.
        throw new actual.ProtocolError(
          "rotated",
          "the vault was rotated by another device, so this rotation was refused; " +
            "reconnect with the new string and try again",
        );
      }
      await super.rotate(args);
      if (lose === "after-commit") {
        throw new actual.ConnectionError("the connection went while `rotated` was being written");
      }
    }
  }
  return { ...actual, Transport };
});

beforeAll(async () => {
  await serverBinary();
}, 180_000);
afterAll(async () => {
  await cleanupBinary();
});

type Testable = BasaltPlugin & StubPlugin;

let server: TestServer;
const loaded: Testable[] = [];

beforeEach(() => {
  resetStub();
});

afterEach(async () => {
  lose = undefined;
  const closing: Promise<void>[] = [];
  while (loaded.length) {
    const p = loaded.pop()!;
    p.onunload();
    if (p.closing) closing.push(p.closing);
  }
  await Promise.all(closing);
  if (server) await server.cleanup();
});

async function fresh(): Promise<void> {
  server = new TestServer();
  await server.start();
}

async function load(saved: unknown = null): Promise<{ plugin: Testable; app: App }> {
  const app = new App();
  const plugin = new BasaltPlugin(
    app as unknown as ObsidianApp,
    {
      id: "basalt",
      dir: ".obsidian/plugins/basalt",
    } as unknown as PluginManifest,
  ) as unknown as Testable;
  plugin.savedData = saved;
  loaded.push(plugin);
  await plugin.onload();
  return { plugin, app };
}

async function until(what: string, cond: () => boolean, ms = 30_000): Promise<void> {
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

/** A started vault with one note already on the server. */
async function started(): Promise<{ plugin: Testable; app: App; key: string }> {
  await fresh();
  const { plugin, app } = await load();
  app.vault.adapter.seed("kept.md", "written before the rotation\n");
  const key = await plugin.pairFirst(server.setup, "laptop");
  await synced(plugin);
  await until("the note to reach the server", () => (plugin.cursors()?.local ?? 0) > 0);
  return { plugin, app, key };
}

/** What `data.json` says, which is the only thing a restart is worth. */
const saved = (p: Testable) => p.savedData as Record<string, string> | null;

describe("replacing the vault's secret from the panel", () => {
  it("keeps the history, retires the old key, and shows the new one to write down", async () => {
    const { plugin, key: oldKey } = await started();
    const before = saved(plugin)!["secret"];

    built.length = 0;
    plugin.ribbonIcons[0]!.callback();
    const row = built.find((s) => s.name === "Replace the vault's secret")!;
    expect(row, "the panel offers no way to retire a leaked secret").toBeDefined();
    expect(row.desc).toMatch(/every other device is disconnected/i);
    const button = row.buttons[0]!;
    expect(button.warning, "the root secret behind a button with no warning on it").toBe(true);

    // One press asks, and changes nothing: this is the whole vault's
    // credential and a thumb is one tap from it.
    await button.click();
    expect(button.label).toBe("Yes, replace it");
    expect(saved(plugin)!["secret"], "one press replaced the secret").toBe(before);

    await button.click();
    await until("the new secret to be saved", () => saved(plugin)!["secret"] !== before);
    const newKey = plugin.recoveryKey()!;
    expect(newKey).not.toBe(oldKey);
    // On screen, in the panel, until it is acknowledged: on a phone there is
    // no terminal it could have been printed to.
    expect(modals.at(-1)!.contentEl.allText()).toContain(newKey);
    expect(modals.at(-1)!.contentEl.allText()).toMatch(/Write this down/);
    // Nothing is left half-written: the staged pair is gone once it committed.
    expect(saved(plugin)!["pendingSecret"]).toBeUndefined();

    // The vault still syncs from here, with its history intact.
    await synced(plugin);

    // The new key opens the vault and the old one does not.
    const stale = await load();
    await expect(stale.plugin.pair(oldKey, "stale")).rejects.toThrow(/auth/i);
    const other = await load();
    await other.plugin.pair(newKey, "other");
    await synced(other.plugin);
    await until(
      "the note to arrive under the new secret",
      () => other.app.vault.adapter.text("kept.md") !== undefined,
    );
    expect(other.app.vault.adapter.text("kept.md")).toBe("written before the rotation\n");
  }, 300_000);

  it("comes up under the new secret when the reply was lost after it committed", async () => {
    const { plugin, key: oldKey } = await started();

    lose = "after-commit";
    const { recoveryKey: newKey, settled } = await plugin.rotate();
    lose = undefined;
    expect(settled, "an unanswered rotation was reported as settled").toBe(false);
    expect(newKey).not.toBe(oldKey);

    // Both secrets are in the file while it is unresolved, so neither is lost.
    const staged = saved(plugin)!;
    expect(
      staged["pendingSecret"],
      "the new secret was not written down before it was sent",
    ).toBeDefined();
    expect(staged["pendingWrapped"]).toBeDefined();

    // The plugin that rotated comes back on its own, without Obsidian being
    // restarted. The rotation did commit, so the pending secret is the only
    // thing that opens the vault; a plugin that had written it to the file and
    // not to itself would sit at "not authorised for this vault" until
    // somebody thought to reload, which on a phone is not an obvious move.
    await synced(plugin);
    await until(
      "the running plugin to settle the rotation",
      () => saved(plugin)!["pendingSecret"] === undefined,
    );
    expect(plugin.recoveryKey()).toBe(newKey);

    // And a fresh load of what was on disk while it was unresolved, which is
    // all a file is worth: the same promotion, from nothing but the file.
    const restarted = await load(staged);
    await synced(restarted.plugin);
    await until(
      "the outstanding rotation to be settled",
      () => saved(restarted.plugin)!["pendingSecret"] === undefined,
    );
    expect(restarted.plugin.recoveryKey()).toBe(newKey);

    // And the key the panel showed is the vault's: it pairs a device, and the
    // one from before the rotation does not.
    const stale = await load();
    await expect(stale.plugin.pair(oldKey, "stale")).rejects.toThrow(/auth/i);
    const other = await load();
    await other.plugin.pair(newKey, "other");
    await synced(other.plugin);
    await until("the note to arrive", () => other.app.vault.adapter.text("kept.md") !== undefined);
  }, 300_000);

  it("comes back to the old secret when the rotation never reached the server", async () => {
    const { plugin, key: oldKey } = await started();

    lose = "before-commit";
    const { recoveryKey: neverUsed, settled } = await plugin.rotate();
    lose = undefined;
    expect(settled).toBe(false);
    expect(saved(plugin)!["pendingSecret"]).toBeDefined();

    // A fresh load. The pending secret is tried first and refused, the current
    // one works, and the outstanding rotation is dropped.
    const restarted = await load(saved(plugin));
    await synced(restarted.plugin);
    await until(
      "the outstanding rotation to be dropped",
      () => saved(restarted.plugin)!["pendingSecret"] === undefined,
    );
    expect(restarted.plugin.recoveryKey()).toBe(oldKey);

    // The old key is still the vault's, and the one that was shown opens
    // nothing, which is why both were kept until this was settled.
    const stale = await load();
    await expect(stale.plugin.pair(neverUsed, "stale")).rejects.toThrow(/auth/i);
    const other = await load();
    await other.plugin.pair(oldKey, "other");
    await synced(other.plugin);
  }, 300_000);

  it("does not offer a key for a rotation that never left this device", async () => {
    const { plugin, key } = await started();
    // The server is gone, so the connection fails before anything is staged.
    // Reporting that as "it may have committed", which is what every other
    // failure after this point is, would have somebody write down a string
    // that opens nothing in place of the one that does.
    await server.stop();

    await expect(plugin.rotate()).rejects.toThrow();
    expect(
      saved(plugin)!["pendingSecret"],
      "a secret was staged for a request never sent",
    ).toBeUndefined();
    expect(plugin.recoveryKey()).toBe(key);
    expect(notices.map((n) => n.message).join("\n")).not.toMatch(/may already have the new secret/);
  }, 300_000);

  it("says so plainly when another device rotated first, and keeps one secret", async () => {
    const { plugin, key } = await started();
    const before = saved(plugin)!["secret"];

    lose = "refused";
    await expect(plugin.rotate()).rejects.toThrow(/rotated by another device/);
    lose = undefined;

    // Nothing committed, so there is no second secret to keep: a key shown as
    // the vault's here would be a key that opens nothing, written down by
    // somebody who now believes they have one.
    expect(saved(plugin)!["pendingSecret"]).toBeUndefined();
    expect(saved(plugin)!["secret"]).toBe(before);
    expect(plugin.recoveryKey()).toBe(key);
    expect(notices.map((n) => n.message).join("\n")).not.toMatch(/Write down/);
  }, 300_000);
});
