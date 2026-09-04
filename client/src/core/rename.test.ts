/**
 * A rename the host reported, and everything the engine has to do with it.
 *
 * Obsidian is the only vault that can report a rename, and until the plugin
 * wired it up nothing exercised this path at all. P24 and P27 in TODO-NEW.md.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { Client, type ClientOptions } from "./client.ts";
import { testWrapped } from "./test-keys.ts";
import { TestServer, cleanupBinary, serverBinary } from "./test-server.ts";
import { MemoryIndexStore, MemoryVault } from "./vault.ts";

const SECRET = new Uint8Array(32).fill(33);
let wrapped: string;
beforeAll(async () => {
  await serverBinary();
  wrapped = await testWrapped(SECRET);
}, 180_000);
afterAll(async () => {
  await cleanupBinary();
});

let server: TestServer;
const open: Client[] = [];
afterEach(async () => {
  while (open.length) await open.pop()!.close();
  if (server) await server.cleanup();
});

async function options(
  name: string,
  vault: MemoryVault,
  extra: Partial<ClientOptions> = {},
): Promise<ClientOptions> {
  return {
    vault,
    store: new MemoryIndexStore(),
    url: server.wsUrl,
    ...(await server.deviceCredentials(SECRET, wrapped)),
    vaultId: "default",
    device: name,
    timeoutMs: 20_000,
    coalesceWrites: false,
    ...extra,
  };
}

async function connected(name: string, vault = new MemoryVault()): Promise<Client> {
  const c = new Client(await options(name, vault));
  open.push(c);
  await c.connect();
  return c;
}

/** The engine's per-path state, for asserting on where a rename left it. */
function stateOf(client: Client) {
  const e = client.engine as unknown as {
    entries: Map<string, unknown>;
    remote: Map<string, unknown>;
    pending: Set<string>;
    retries: Map<string, unknown>;
    skipped: Map<string, unknown>;
  };
  return {
    entries: [...e.entries.keys()].sort(),
    remote: [...e.remote.keys()].sort(),
    pending: [...e.pending].sort(),
    retries: [...e.retries.keys()].sort(),
    skipped: [...e.skipped.keys()].sort(),
    raw: e,
  };
}

/** A vault whose reads wait until the test says go. */
class SlowReadVault extends MemoryVault {
  gate: Promise<void> = Promise.resolve();
  override async read(path: string): Promise<Uint8Array> {
    await this.gate;
    return super.read(path);
  }
}

describe("what a rename moves (P27)", () => {
  it("moves the retry clock and the write-off with the entry, and leaves the server's word where it is", async () => {
    server = new TestServer();
    await server.start();
    const av = new MemoryVault();
    const a = await connected("a", av);
    await av.edit("A.md", "from a\n");
    await a.settle();
    stateOf(a).raw.retries.set("A.md", { at: 0, why: "x", attempts: 1 });
    stateOf(a).raw.skipped.set("A.md", { why: "x", fingerprint: "f" });

    a.engine.noteRename("A.md", "B.md");
    const after = stateOf(a);
    expect(after.entries).toContain("B.md");
    expect(after.retries).toEqual(["B.md"]);
    expect(after.skipped).toEqual(["B.md"]);
    // The server still holds A.md until the next pass tells it otherwise,
    // and the remote index says so. Moving it made the new name look synced
    // and the rename was never sent.
    expect(after.remote).toEqual(["A.md"]);
  }, 120_000);

  it("refuses a destination that never syncs", async () => {
    server = new TestServer();
    await server.start();
    const av = new MemoryVault();
    const a = await connected("a", av);
    await av.edit("A.md", "from a\n");
    await a.settle();
    const before = stateOf(a);
    expect(before.entries).toContain("A.md");

    a.engine.noteRename("A.md", ".trash/A.md");
    const after = stateOf(a);
    expect(after.entries).toEqual(before.entries);
    expect(after.entries).not.toContain(".trash/A.md");
  }, 120_000);

  it("moves a folder's children with it, bookkeeping included", async () => {
    server = new TestServer();
    await server.start();
    const av = new MemoryVault();
    const a = await connected("a", av);
    await av.edit("docs/one.md", "1\n");
    await av.edit("docs/two.md", "2\n");
    await a.settle();
    stateOf(a).raw.skipped.set("docs/two.md", { why: "x", fingerprint: "f" });
    a.engine.noteRename("docs", "moved");
    expect(stateOf(a).entries).toEqual(
      expect.arrayContaining(["moved", "moved/one.md", "moved/two.md"]),
    );
    expect(stateOf(a).skipped).toEqual(["moved/two.md"]);
  }, 120_000);
});

describe("a rename reported while a pass is running (P24)", () => {
  it("lands between passes, not between one pass's awaits", async () => {
    server = new TestServer();
    await server.start();
    const vault = new SlowReadVault();
    await vault.edit("A.md", "content\n");
    const c = new Client(await options("c", vault));
    open.push(c);
    await c.connect();

    let release!: () => void;
    vault.gate = new Promise((r) => {
      release = r;
    });
    // The pass starts, lists A.md, and blocks reading it.
    const pass = c.sync();
    await new Promise((r) => setTimeout(r, 100));
    const renamed = c.noteRename("A.md", "B.md");
    await new Promise((r) => setTimeout(r, 100));
    // Not yet: the pass has A.md in hand.
    expect(stateOf(c).entries).not.toContain("B.md");

    release();
    await pass;
    await renamed;
    expect(stateOf(c).entries).toContain("B.md");
  }, 120_000);
});
