/**
 * What a vault refuses to be told to write.
 *
 * The never-sync set was an upload filter and nothing else: `list` consulted it,
 * `watch` consulted it, and the write path did not. So a path this client would
 * never upload was a path it would happily accept, and both shells would write
 * into the config folder if a peer named one.
 *
 * That is not a small gap. `.obsidian/plugins/<any>/main.js` is executed by
 * Obsidian on the next reload, in a renderer with Node integration, so an
 * arbitrary write there is arbitrary code execution as the user. `.basalt/`
 * holds this client's own pairing secret and server URL, and `.git/hooks/` runs
 * on the next checkout.
 *
 * It needs the vault key, so the attacker is a leaked pairing string or one
 * compromised device rather than a hostile server. It is also reachable with no
 * attacker at all: a client told its config folder is somewhere else uploads the
 * ordinary `.obsidian` it still has, and every other device would have applied
 * it.
 *
 * The invariant, asserted here for both vaults because the bug was that they
 * disagreed: a path this client will never upload is a path it must never
 * accept.
 */

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { NodeVault } from "./cli/vault.ts";
import { FakeAdapter, FakeVaultIndex, asVault } from "./plugin/fake.ts";
import { ObsidianVault } from "./plugin/vault.ts";
import { removeTree } from "./core/test-server.ts";

const made: string[] = [];
afterEach(async () => {
  for (const d of made.splice(0)) await removeTree(d);
});

async function nodeVault(): Promise<NodeVault> {
  const root = await mkdtemp(join(tmpdir(), "basalt-inbound-"));
  made.push(root);
  return new NodeVault(root);
}

const body = new TextEncoder().encode("written by a peer\n");
const times = { mtime: 1_700_000_000_000, ctime: 1_700_000_000_000 };

/** Paths no vault should ever be talked into touching. */
const forbidden = [
  ".obsidian/plugins/dataview/main.js",
  ".obsidian/plugins/basalt-sync/data.json",
  ".obsidian/app.json",
  ".basalt/config.json",
  ".basalt/index.json",
  ".git/hooks/post-checkout",
  ".trash/something.md",
];

describe("the headless client refuses to write where it would never read", () => {
  it("refuses every never-sync path", async () => {
    const vault = await nodeVault();
    for (const path of forbidden) {
      await expect(vault.write(path, body, times), `accepted ${path}`).rejects.toThrow();
    }
  });

  it("refuses to make a directory inside one either", async () => {
    const vault = await nodeVault();
    await expect(vault.mkdir(".obsidian/plugins/evil")).rejects.toThrow();
  });

  it("still writes ordinary notes, including ones that look close", async () => {
    const vault = await nodeVault();
    for (const path of ["note.md", "Projects/deep/note.md", "obsidian/n.md"]) {
      await vault.write(path, body, times);
      expect(await vault.read(path)).toEqual(body);
    }
  });

  /**
   * T4 in TODO.md: the contract is that any dot-prefixed segment never syncs,
   * in either direction, in both clients. Obsidian's own index never lists
   * one, so a headless client that accepted `.obsidian-notes/n.md` from a
   * peer would hold a file it could never report, and report it deleted.
   */
  it("refuses a dot-prefixed folder even when it is not the config folder", async () => {
    const vault = await nodeVault();
    await expect(vault.write(".obsidian-notes/n.md", body, times)).rejects.toThrow(/never synced/);
  });
});

describe("the plugin refuses the same paths", () => {
  const pluginVault = () =>
    new ObsidianVault(asVault(new FakeVaultIndex(new FakeAdapter())), ".obsidian");

  it("refuses every never-sync path", async () => {
    const vault = pluginVault();
    for (const path of forbidden) {
      await expect(vault.write(path, body, times), `accepted ${path}`).rejects.toThrow();
    }
  });

  it("refuses to make a directory inside one either", async () => {
    await expect(pluginVault().mkdir(".obsidian/plugins/evil")).rejects.toThrow();
  });

  it("still writes ordinary notes", async () => {
    const vault = pluginVault();
    await vault.write("Projects/note.md", body, times);
    expect(await vault.read("Projects/note.md")).toEqual(body);
  });
});

/**
 * A name beginning with two dots is not an escape, and containment must not
 * call it one: the refusal it gets is the dot rule's, which is a different
 * reason with a different message, and the distinction is what tells a person
 * whether a peer is misbehaving or a file simply does not sync (T4).
 */
describe("what containment should and should not refuse", () => {
  it("refuses real escapes", async () => {
    const vault = await nodeVault();
    for (const path of ["../escape.md", "a/../../escape.md", "/tmp/escape.md"]) {
      await expect(vault.write(path, body, times), `accepted ${path}`).rejects.toThrow(
        /outside the vault/,
      );
    }
  });

  it("refuses a note that starts with two dots as never synced, not as an escape", async () => {
    const vault = await nodeVault();
    const attempt = vault.write("..hidden.md", body, times);
    await expect(attempt).rejects.toThrow(/never synced/);
    await expect(attempt).rejects.not.toThrow(/outside the vault/);
  });
});
