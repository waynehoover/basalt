/**
 * SPIKE, not shipped. What the server loses, and whether the replacement is enough.
 *
 * Today the server recomputes `chunks.Name(body)` in five places, and every one
 * of them is a durability check rather than a security one: `place` before a
 * write, `Writer.Add` in a batch, `readBodies` to match a frame to the name it
 * answers, `Get` on every read, and `Check` under `verify -deep`. Backups go
 * through Get and Put, so they are hashed both ways too.
 *
 * Under a name that is an HMAC of the plaintext the server can do none of that:
 * the name is under a key it does not hold. This models three server designs
 * against the four faults those checks exist for, so the report can say which
 * ones actually go away.
 *
 * The designs:
 *
 *   A. today. name = SHA-256(body).
 *   B. the spike, plainly. name = HMAC(plaintext); the server holds a name and
 *      bytes and no way to relate them.
 *   C. the spike with an indirection. the client sends `{name, bodyHash}`, the
 *      server files the body under bodyHash exactly as it does today and keeps
 *      name -> bodyHash beside it.
 */

import { describe, expect, it } from "vitest";
import { chunkName } from "../core/crypto.ts";
import { SUITE_V1, chunkId, sealChunkAs } from "./chunkid.ts";
import { spikeKeys } from "./keys.ts";

const enc = new TextEncoder();

const sha = async (b: Uint8Array) => chunkName(b);

/** What a server can conclude about a body it holds. */
interface Design {
  readonly what: string;
  /** Refuses a body that is not the one this name means. Null means it cannot tell. */
  readonly checkOnWrite: ((name: string, body: Uint8Array) => Promise<boolean>) | null;
  /** Detects a body that changed on disk after it was written. */
  readonly checkOnRead: ((name: string, body: Uint8Array) => Promise<boolean>) | null;
  /** Matches an unlabelled binary frame to the name it answers. */
  readonly matchFrame: ((body: Uint8Array) => Promise<string | null>) | null;
}

describe("the five places the server recomputes the name", () => {
  it("says which checks survive each design", async () => {
    const keys = await spikeKeys();
    const plainA = enc.encode("The note the entry actually names.\n");
    const plainB = enc.encode("A different note entirely, sealed under the same vault key.\n");
    const bodyA = await sealChunkAs(keys, plainA, { suite: SUITE_V1, level: 6 });
    const bodyB = await sealChunkAs(keys, plainB, { suite: SUITE_V1, level: 6 });

    // ---- Design A: what ships today.
    const todayName = await sha(bodyA);
    const A: Design = {
      what: "A. today, name = sha256(body)",
      checkOnWrite: async (n, b) => (await sha(b)) === n,
      checkOnRead: async (n, b) => (await sha(b)) === n,
      matchFrame: async (b) => sha(b),
    };

    // ---- Design B: the spike, with nothing added.
    const spikeName = await chunkId(keys.chunkid, plainA);
    const B: Design = {
      what: "B. spike, name = hmac(plaintext)",
      checkOnWrite: null, // the server cannot compute the name at all
      checkOnRead: null,
      matchFrame: null, // frames must be matched by position instead
    };

    // ---- Design C: the spike plus a client-supplied body digest.
    const table = new Map<string, string>(); // name -> bodyHash
    table.set(spikeName, await sha(bodyA));
    const C: Design = {
      what: "C. spike + client-supplied bodyHash",
      // At write time the server still has an externally supplied reference:
      // the client computed the digest of the very bytes it is sending.
      checkOnWrite: async (n, b) => table.get(n) === (await sha(b)),
      checkOnRead: async (n, b) => table.get(n) === (await sha(b)),
      matchFrame: async (b) => {
        const h = await sha(b);
        for (const [n, bh] of table) if (bh === h) return n;
        return null;
      },
    };

    const rot = Uint8Array.from(bodyA);
    rot[rot.length - 20]! ^= 0x40; // one flipped bit inside the ciphertext

    const rows: string[] = [];
    for (const [d, name] of [
      [A, todayName],
      [B, spikeName],
      [C, spikeName],
    ] as const) {
      // Fault 1: a body that is not the body for this name, offered on a write.
      const wrongOnWrite = d.checkOnWrite ? !(await d.checkOnWrite(name, bodyB)) : false;
      // Fault 2: bit rot on disk after the write.
      const rotOnRead = d.checkOnRead ? !(await d.checkOnRead(name, rot)) : false;
      // Fault 3: a frame arriving out of order, or twice.
      const frames = d.matchFrame ? (await d.matchFrame(bodyA)) === name : false;
      // Fault 4: the server serving body B for name A on the way out. This is
      // the client's job in every design, and every design has it, because the
      // client can always recompute what it asked for.
      const clientCatchesSwap = true;

      rows.push(
        `    ${d.what.padEnd(34)} ` +
          `write:${wrongOnWrite ? "yes" : "no "}  ` +
          `rot:${rotOnRead ? "yes" : "no "}  ` +
          `frames:${frames ? "hash" : "posn"}  ` +
          `client:${clientCatchesSwap ? "yes" : "no "}`,
      );
    }

    console.log("  which server-side faults each design catches");
    for (const r of rows) console.log(r);

    // A catches everything it catches today.
    expect(await A.checkOnWrite!(todayName, bodyB)).toBe(false);
    expect(await A.checkOnRead!(todayName, rot)).toBe(false);
    // B catches nothing server-side, which is the finding.
    expect(B.checkOnWrite).toBeNull();
    expect(B.checkOnRead).toBeNull();
    expect(B.matchFrame).toBeNull();
    // C is back to parity, at the price of a second identifier per chunk.
    expect(await C.checkOnWrite!(spikeName, bodyB)).toBe(false);
    expect(await C.checkOnRead!(spikeName, rot)).toBe(false);
    expect(await C.matchFrame!(bodyA)).toBe(spikeName);
  });

  it("shows what design B's quarantine loop cannot do", async () => {
    const keys = await spikeKeys();
    const plain = enc.encode("A note whose only copy on the server has rotted.\n");
    const name = await chunkId(keys.chunkid, plain);
    const body = await sealChunkAs(keys, plain, { suite: SUITE_V1, level: 6 });

    const rotted = Uint8Array.from(body);
    rotted[rotted.length - 8]! ^= 0x01;

    // Under B the server hands the rotted body over believing it is fine. The
    // client catches it, because AES-GCM refuses, but the failure now surfaces
    // as "this note will not decrypt" on the device rather than as "chunk X of
    // vault Y is corrupt" on the server. That difference is the whole of what
    // `Get` verifying on the way out buys, and `verify -deep` cannot run at all.
    await expect(
      (async () => {
        const { openChunkAny } = await import("./chunkid.ts");
        return openChunkAny(keys, rotted);
      })(),
    ).rejects.toThrow(/failed authentication/);

    // The server, holding no key, has no equivalent of this and nothing to
    // quarantine on: it cannot distinguish a rotted body from a good one.
    console.log("  design B: rot is detected on the device and nowhere on the server");
    console.log("    so no quarantine, no self-heal, and verify -deep degrades to verify");
    expect(name).toMatch(/^[0-9a-f]{64}$/);
  });
});
