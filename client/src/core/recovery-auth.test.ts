/**
 * C32 in TODO.md. Recovery read entries the server handed back and acted on
 * them: a `history` list was shown, a `deleted` list was offered for restore,
 * and a `get` answered with a chunk list that was assembled and written into
 * the vault. None of it was checked against the vault's key. The ordinary
 * sync path checks every batch entry's authenticator; the path somebody
 * takes on the worst afternoon did not.
 */

import { describe, expect, it } from "vitest";

import { Client } from "./client.ts";
import { deriveKeys, macEntry, sealChunks, sealPath, type VaultKeys } from "./crypto.ts";
import { FakeSocket, RIG_SECRET, ready, settle } from "./fake-socket.ts";
import { MemoryIndexStore, MemoryVault } from "./vault.ts";

const enc = new TextEncoder();

async function rig() {
  const socket = new FakeSocket();
  const keys = await deriveKeys(RIG_SECRET);
  const vault = new MemoryVault();
  const client = new Client({
    vault,
    store: new MemoryIndexStore(),
    keys,
    secret: RIG_SECRET,
    url: "ws://test",
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
  keys: VaultKeys,
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

describe("recovery against a server that answers with entries nobody wrote (C32)", () => {
  it("refuses a history list holding a version this vault's key did not sign", async () => {
    const { socket, keys, client } = await rig();
    const good = await version(keys, 3, "note.md", "three");
    const forged = await version(keys, 2, "note.md", "two", { mac: "0".repeat(64) });
    const asking = client.history("note.md");
    await settle();
    socket.reply({ res: "history", path: good.entry.path, entries: [good.entry, forged.entry] });
    await expect(asking).rejects.toThrow(/version 2 .*not authenticated/);
  });

  it("refuses a deleted list the same way", async () => {
    const { socket, keys, client } = await rig();
    const forged = await version(keys, 5, "gone.md", "", { deleted: true, mac: "f".repeat(64) });
    const asking = client.deleted();
    await settle();
    socket.reply({ res: "deleted", entries: [{ ...forged.entry, restorable: 4 }], more: false });
    await expect(asking).rejects.toThrow(/not authenticated/);
  });

  it("refuses to restore when get answers with chunks the signed version did not name", async () => {
    const { socket, keys, client, vault } = await rig();
    const real = await version(keys, 7, "note.md", "what was written");
    const other = await version(keys, 8, "other.md", "something else entirely");
    const asking = client.history("note.md");
    await settle();
    socket.reply({ res: "history", path: real.entry.path, entries: [real.entry] });
    const [v] = await asking;

    // The server answers the get with another file's chunk list. It would
    // decrypt, being real content under the vault's key, and be written
    // under this note's name.
    const restoring = client.restore(v!);
    await settle();
    await settle();
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
    await settle();
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
    await settle();
    socket.reply({ res: "history", path: real.entry.path, entries: [real.entry] });
    const [v] = await asking;
    socket.autoReply = (frame, s) => {
      if (frame["op"] === "get") {
        s.reply({ res: "chunks", uid: 7, size: real.body.bytes.length, chunks: [real.body.name] });
      } else if (frame["op"] === "fetch") s.bodies(real.body.bytes);
    };
    const done = await client.restore(v!);
    expect(done.path).toBe("note.md");
    expect(vault.text("note.md")).toBe("what was written");
  });
});
