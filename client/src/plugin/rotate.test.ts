/**
 * Rotation from the plugin, against a real server.
 *
 * Rotation was a headless-client command, and the runbook for a lost device
 * therefore assumed a machine with the CLI was to hand. The device somebody
 * loses is a phone, and so, often, is the only other device in their pocket
 * (improvements.md §1 and §5). This file is what makes the row safe to offer,
 * and it is deliberately the same shape as `cli/rotate.test.ts`: the case that
 * matters is not the happy one, it is the ordinary lost packet.
 *
 * Protocol 4 moved two things. The panel asks for the current recovery key,
 * because no device holds one: a device that could rotate could also register
 * itself again after being revoked, which is the whole thing per-device
 * credentials removed. And every device keeps syncing across a rotation,
 * including this one, because no device row is touched.
 *
 * The server commits the new credential, closes every other registrar, and
 * only then answers. A connection that goes in between leaves a vault whose new
 * root may exist nowhere but in this process, and there is nowhere on a device
 * to stage a root any more. So the panel shows the new key and `settled` says
 * whether the server was heard from; when it was not, the plugin asks the
 * server which secret it has rather than guessing.
 */

import type { App as ObsidianApp, PluginManifest } from "obsidian";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { TestServer, cleanupBinary, serverBinary } from "../core/test-server.ts";
import {
  App,
  type FakeEl,
  Plugin as StubPlugin,
  built,
  modals,
  notices,
  resetStub,
} from "./stub.ts";
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

/**
 * Every `?` tooltip in the panel that is open, joined.
 *
 * The panel's descriptions are one line each, and the detail they used to
 * carry is on an `aria-label` beside the section it belongs to, which is what
 * Obsidian draws as a hover tooltip.
 */
const tooltips = (): string => {
  const found: string[] = [];
  const walk = (el: FakeEl): void => {
    const label = el.attributes.get("aria-label");
    if (label !== undefined) found.push(label);
    for (const child of el.children) walk(child);
  };
  const modal = modals.at(-1);
  if (modal) walk(modal.contentEl as unknown as FakeEl);
  return found.join("\n");
};

/** What `data.json` says, which is the only thing a restart is worth. */
const saved = (p: Testable) => p.savedData as Record<string, string> | null;

describe("replacing the vault's secret from the panel", () => {
  it("keeps the history and every device, and shows the new key to write down", async () => {
    const { plugin, key: oldKey } = await started();
    const before = { ...saved(plugin)! };

    built.length = 0;
    plugin.ribbonIcons[0]!.callback();
    const row = built.find((s) => s.name === "Replace the vault's secret")!;
    expect(row, "the panel offers no way to retire a leaked secret").toBeDefined();
    // The copy has to say the two things a person would otherwise get wrong:
    // that this needs the key they wrote down, and that every device keeps
    // syncing, which is the opposite of what protocol 3 did. The first is
    // short enough for the row's one line. The other two followed the cut on
    // to the `?` beside the disclosure this row sits in, which is where the
    // panel keeps the detail a line cannot carry.
    expect(row.desc).toMatch(/Paste the vault's current recovery key/);
    expect(tooltips()).toMatch(/keeps every device syncing/i);
    expect(tooltips()).toMatch(/cannot un-read/i);
    // The field, and the button that reads it, are separate rows.
    const field = row.texts[0]!;
    const button = built.find((s) => s.buttons.some((b) => b.label === "Replace the secret"))!
      .buttons[0]!;
    expect(button.warning, "the vault's credential behind a button with no warning").toBe(true);

    // Nothing happens without the key, and nothing is said that sounds like
    // it did.
    await button.click();
    expect(notices.map((n) => n.message).join("\n")).not.toMatch(/new secret/);

    field.setValue(oldKey);
    await button.click();
    await until("the new key to be shown", () =>
      modals.at(-1)!.contentEl.allText().includes("Write this down"),
    );
    const shown = modals
      .at(-1)!
      .contentEl.allText()
      .split(/\s+/)
      .find((w) => w.startsWith("basalt3_") && w !== oldKey)!;
    expect(shown, "no new recovery key was put on screen").toBeDefined();

    // This device's own credential is untouched, which is why it keeps
    // syncing: a rotation replaces the vault's secret and no device row.
    const after = saved(plugin)!;
    expect(after["deviceId"]).toBe(before["deviceId"]);
    expect(after["deviceSecret"]).toBe(before["deviceSecret"]);
    expect(after["dataKey"]).toBe(before["dataKey"]);
    expect(after["secret"], "a device is holding the vault's root").toBeUndefined();
    await synced(plugin);

    // The new key adds a device and the old one does not.
    const stale = await load();
    await expect(stale.plugin.pair(oldKey, "stale")).rejects.toThrow(/auth/i);
    const other = await load();
    await other.plugin.pair(shown, "other");
    await synced(other.plugin);
    await until(
      "the note to arrive under the new secret",
      () => other.app.vault.adapter.text("kept.md") !== undefined,
    );
    expect(other.app.vault.adapter.text("kept.md")).toBe("written before the rotation\n");
  }, 300_000);

  it("finds out that a lost reply committed, and says the key is the vault's", async () => {
    const { plugin, key: oldKey } = await started();

    lose = "after-commit";
    const { recoveryKey: newKey, settled } = await plugin.rotate(oldKey);
    lose = undefined;
    // The reply was lost and the probe found the new root does open the
    // vault, so this is settled: better than the staged secret it replaced,
    // which deferred the question to the next connection.
    expect(settled, "a rotation the server had taken was left unresolved").toBe(true);
    expect(newKey).not.toBe(oldKey);

    // This device never held either key and goes on syncing regardless.
    await synced(plugin);

    const stale = await load();
    await expect(stale.plugin.pair(oldKey, "stale")).rejects.toThrow(/auth/i);
    const other = await load();
    await other.plugin.pair(newKey, "other");
    await synced(other.plugin);
    await until("the note to arrive", () => other.app.vault.adapter.text("kept.md") !== undefined);
  }, 300_000);

  it("says the vault's secret was not replaced when the request never went out", async () => {
    const { plugin, key: oldKey } = await started();

    lose = "before-commit";
    await expect(plugin.rotate(oldKey)).rejects.toThrow(/was not replaced/);
    lose = undefined;

    // The old key is still the vault's, and nothing put a key that opens
    // nothing in front of somebody to write down.
    const other = await load();
    await other.plugin.pair(oldKey, "other");
    await synced(other.plugin);
  }, 300_000);

  it("says so plainly when somebody rotated first, and offers no key", async () => {
    const { plugin, key } = await started();

    lose = "refused";
    await expect(plugin.rotate(key)).rejects.toThrow(/replaced by somebody else first/);
    lose = undefined;

    // Nothing committed, so there is no key to show: one shown as the vault's
    // here would be a key that opens nothing, written down by somebody who now
    // believes they have one.
    expect(notices.map((n) => n.message).join("\n")).not.toMatch(/Write down/);
  }, 300_000);

  it("refuses a recovery key for another vault rather than rotating this one", async () => {
    const { plugin, key } = await started();
    const { parsePairing, formatPairing } = await import("../core/pairing.ts");
    const elsewhere = formatPairing({ ...parsePairing(key), vaultId: "another" });
    await expect(plugin.rotate(elsewhere)).rejects.toThrow(/is paired with/);
  }, 300_000);
});
