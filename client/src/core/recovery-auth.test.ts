/**
 * review finding C32. Recovery read entries the server handed back and acted on
 * them: a `history` list was shown, a `deleted` list was offered for restore,
 * and a `get` answered with a chunk list that was assembled and written into
 * the vault. None of it was checked against the vault's key. The ordinary
 * sync path checks every batch entry's authenticator; the path somebody
 * takes on the worst afternoon did not.
 */

import { describe, expect, it } from "vitest";

import { Client } from "./client.ts";
import { macEntry, sealChunks, sealPath, type Schedule } from "./crypto.ts";
import { TEST_DATA_KEY, testKeys } from "./test-keys.ts";
import { FakeSocket, RIG_SECRET, ready, settle } from "./fake-socket.ts";
import { MemoryIndexStore, MemoryVault } from "./vault.ts";

const enc = new TextEncoder();

async function rig() {
  const socket = new FakeSocket();
  const keys = await testKeys(RIG_SECRET);
  const vault = new MemoryVault();
  const client = new Client({
    vault,
    store: new MemoryIndexStore(),
    dataKey: TEST_DATA_KEY,
    url: "ws://test",
    deviceId: "rig-device",
    token: "t",
    vaultId: "v",
    device: "d",
    timeoutMs: 2000,
    socketFactory: () => socket,
  });
  const connecting = client.connect();
  await settle();
  socket.open();
  for (let i = 0; i < 50 && !socket.sentText.some((m) => m["op"] === "hello"); i++) await settle();
  socket.reply(ready({ cursor: 0, perFileMax: 1 << 28, chunkMax: 1 << 20, maxChunks: 100 }));
  await settle();
  socket.raw({ op: "caught-up", cursor: 0 });
  await connecting;
  return { socket, keys, client, vault };
}

async function version(
  keys: Schedule,
  uid: number,
  path: string,
  text: string,
  over: { mac?: string; deleted?: boolean } = {},
) {
  const plain = enc.encode(text);
  const [chunk] = await sealChunks(keys, [plain]);
  const facts = {
    path: await sealPath(keys, path),
    size: over.deleted ? 0 : plain.length,
    ctime: 1000,
    mtime: 1000,
    folder: false,
    deleted: over.deleted ?? false,
    chunks: over.deleted ? [] : [chunk!.name],
    parent: "",
  };
  return {
    entry: { uid, ...facts, device: "other", mac: over.mac ?? (await macEntry(keys, facts)) },
    body: chunk!,
  };
}

/**
 * Waits until the request is actually on the wire before the fake server
 * answers it.
 *
 * A single `settle` is not enough: sealing the path goes through WebCrypto,
 * which resolves on its own task, so how many ticks pass between calling
 * `history` and the frame being sent is not fixed. Answering early filled in
 * the id of the previous request and the client refused its own reply.
 */
async function sent(socket: FakeSocket, op: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (socket.sentText.some((m) => m["op"] === op)) return;
    await settle();
  }
  throw new Error(`no ${op} was sent`);
}

describe("recovery against a server that answers with entries nobody wrote (C32)", () => {
  it("refuses a history list holding a version this vault's key did not sign", async () => {
    const { socket, keys, client } = await rig();
    const good = await version(keys, 3, "note.md", "three");
    const forged = await version(keys, 2, "note.md", "two", { mac: "0".repeat(64) });
    const asking = client.history("note.md");
    await sent(socket, "history");
    socket.reply({ res: "history", path: good.entry.path, entries: [good.entry, forged.entry] });
    await expect(asking).rejects.toThrow(/version 2 .*not authenticated/);
  });

  it("refuses a deleted list the same way", async () => {
    const { socket, keys, client } = await rig();
    const forged = await version(keys, 5, "gone.md", "", { deleted: true, mac: "f".repeat(64) });
    const asking = client.deleted();
    await sent(socket, "deleted");
    socket.reply({ res: "deleted", entries: [{ ...forged.entry, restorable: 4 }], more: false });
    await expect(asking).rejects.toThrow(/not authenticated/);
  });

  it("refuses to restore when get answers with chunks the signed version did not name", async () => {
    const { socket, keys, client, vault } = await rig();
    const real = await version(keys, 7, "note.md", "what was written");
    const other = await version(keys, 8, "other.md", "something else entirely");
    const asking = client.history("note.md");
    await sent(socket, "history");
    socket.reply({ res: "history", path: real.entry.path, entries: [real.entry] });
    const [v] = await asking;

    // The server answers the get with another file's chunk list. It would
    // decrypt, being real content under the vault's key, and be written
    // under this note's name.
    const restoring = client.restore(v!);
    await sent(socket, "get");
    socket.reply({
      res: "chunks",
      uid: 7,
      size: other.body.bytes.length,
      chunks: [other.body.name],
    });
    await expect(restoring).rejects.toThrow(/not the version it is being offered as/);
    expect(vault.paths()).toEqual([]);
  });

  it("refuses a history entry whose chunk names are not chunk names", async () => {
    const { socket, keys, client } = await rig();
    const good = await version(keys, 3, "note.md", "three");
    const asking = client.history("note.md");
    await sent(socket, "history");
    socket.reply({
      res: "history",
      path: good.entry.path,
      entries: [{ ...good.entry, chunks: ["not-a-chunk-name"] }],
    });
    await expect(asking).rejects.toThrow(/not a chunk name|not authenticated/);
  });

  it("still restores a version that checks out", async () => {
    const { socket, keys, client, vault } = await rig();
    const real = await version(keys, 7, "note.md", "what was written");
    const asking = client.history("note.md");
    await sent(socket, "history");
    socket.reply({ res: "history", path: real.entry.path, entries: [real.entry] });
    const [v] = await asking;
    socket.autoReply = (frame, s) => {
      if (frame["op"] === "get") {
        // The size the real server answers with is the entry's own, which is
        // the plaintext length, not the sealed body's.
        s.reply({ res: "chunks", uid: 7, size: real.entry.size, chunks: [real.body.name] });
      } else if (frame["op"] === "fetch") s.bodies(real.body.bytes);
    };
    const done = await client.restore(v!);
    expect(done.path).toBe("note.md");
    expect(vault.text("note.md")).toBe("what was written");
  });
});

/**
 * C-D4 and C-D5 in the 0.3.0 review. `land` checks an assembly against the size
 * its entry declares, and refuses an entry whose shape contradicts itself. The
 * recovery path, which is the one somebody takes on the worst afternoon, made
 * neither check: it verified the chunk list against the signed one and then
 * wrote whatever came back.
 */
describe("recovery against a server that answers with the right names (C-D4, C-D5)", () => {
  it("refuses to restore a version that assembles to a length it does not declare", async () => {
    const { socket, keys, client, vault } = await rig();
    const short = await version(keys, 7, "note.md", "short");
    // Signed, and self-contradictory: 500 bytes made of one chunk holding
    // five. Everything the recovery path checked passed, and the note came
    // back five bytes long with nothing saying so.
    const facts = {
      path: short.entry.path,
      size: 500,
      ctime: 1000,
      mtime: 1000,
      folder: false,
      deleted: false,
      chunks: [short.body.name],
      parent: "",
    };
    const entry = { uid: 7, ...facts, device: "other", mac: await macEntry(keys, facts) };
    const asking = client.history("note.md");
    await sent(socket, "history");
    socket.reply({ res: "history", path: facts.path, entries: [entry] });
    const [v] = await asking;

    socket.autoReply = (frame, s) => {
      if (frame["op"] === "get") {
        s.reply({ res: "chunks", uid: 7, size: 500, chunks: [short.body.name] });
      } else if (frame["op"] === "fetch") s.bodies(short.body.bytes);
    };
    await expect(client.restore(v!)).rejects.toThrow(/assembled to 5 bytes, not the 500/);
    expect(vault.paths(), "a truncated note was written as the restore").toEqual([]);
  });

  it("refuses to restore a version whose declared size is not the server's", async () => {
    const { socket, keys, client, vault } = await rig();
    const real = await version(keys, 7, "note.md", "what was written");
    const asking = client.history("note.md");
    await sent(socket, "history");
    socket.reply({ res: "history", path: real.entry.path, entries: [real.entry] });
    const [v] = await asking;

    socket.autoReply = (frame, s) => {
      if (frame["op"] === "get") {
        s.reply({ res: "chunks", uid: 7, size: 4, chunks: [real.body.name] });
      } else if (frame["op"] === "fetch") s.bodies(real.body.bytes);
    };
    await expect(client.restore(v!)).rejects.toThrow(/signed as 16 bytes/);
    expect(vault.paths()).toEqual([]);
  });

  it("refuses a signed history entry that declares bytes and names no chunks", async () => {
    const { socket, keys, client } = await rig();
    const facts = {
      path: await sealPath(keys, "note.md"),
      size: 500,
      ctime: 1000,
      mtime: 1000,
      folder: false,
      deleted: false,
      chunks: [] as string[],
      parent: "",
    };
    // Signed by this vault's key, so `mustBeOurs` is happy with it, and it
    // still cannot be true: restoring it wrote a 500 byte note as 0 bytes.
    const entry = { uid: 9, ...facts, device: "other", mac: await macEntry(keys, facts) };
    const asking = client.history("note.md");
    await sent(socket, "history");
    socket.reply({ res: "history", path: facts.path, entries: [entry] });
    await expect(asking).rejects.toThrow(/declares 500 bytes and names no chunks/);
  });
});
