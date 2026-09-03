/**
 * Rotation across a process boundary, against a real server.
 *
 * The case this file exists for is the one an ordinary lost packet produces.
 * The server commits the new credential, closes every other session, and only
 * then answers; a connection that goes in between leaves this device with a
 * vault whose new root it may be the only holder of. `rotate` used to throw at
 * that point with nothing saved and nothing printed, so the old root no longer
 * authenticated, the new one died with the process, and the ciphertext on the
 * server was intact and unopenable for ever.
 *
 * Both halves are here: the reply lost after the rotation committed, where the
 * next run has to come up under the new secret, and lost before it, where the
 * next run has to come back to the old one.
 */

import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { cleanupBinary, removeTree, serverBinary, TestServer } from "../core/test-server.ts";
import { run, type Console } from "./cli.ts";
import { loadConfig } from "./config.ts";

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

class Run {
  code = -1;
  out: string[] = [];
  err: string[] = [];
  get all(): string {
    return this.out.join("\n") + "\n" + this.err.join("\n");
  }
  json(): Record<string, unknown> {
    return JSON.parse(this.out.join("\n")) as Record<string, unknown>;
  }
}

async function cli(...argv: string[]): Promise<Run> {
  const r = new Run();
  const io: Console = { out: (l) => r.out.push(l), err: (l) => r.err.push(l) };
  r.code = await run(argv, io);
  return r;
}

/** The one recovery key a run printed, wherever it printed it. */
function keyIn(r: Run): string {
  const line = [...r.out, ...r.err].find((l) => l.trim().startsWith("basalt3_"));
  expect(line, `no recovery key in:\n${r.all}`).toBeDefined();
  return line!.trim();
}

beforeAll(async () => {
  await serverBinary();
}, 180_000);
afterAll(async () => {
  await cleanupBinary();
});

let server: TestServer | undefined;
const dirs: string[] = [];

afterEach(async () => {
  lose = undefined;
  while (dirs.length) await removeTree(dirs.pop()!);
  if (server) await server.cleanup();
  server = undefined;
});

async function vaultDir(name: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `basalt-rotate-${name}-`));
  dirs.push(dir);
  return dir;
}

/** A started vault with one note already on the server. */
async function started(name = "a"): Promise<{ dir: string; key: string }> {
  server = new TestServer();
  await server.start();
  const dir = await vaultDir(name);
  const init = await cli("init", server.setup, "--dir", dir, "--device", name, "--json");
  expect(init.code, init.all).toBe(0);
  await writeFile(join(dir, "kept.md"), "written before the rotation\n");
  expect((await cli("sync", "--dir", dir)).code).toBe(0);
  return { dir, key: init.json()["recoveryKey"] as string };
}

describe("a rotation whose reply never came back", () => {
  it("prints the new key, and the next run comes up under it when it committed", async () => {
    const { dir, key: oldKey } = await started("committed");

    lose = "after-commit";
    const rotated = await cli("rotate", "--dir", dir);
    lose = undefined;
    expect(rotated.code, rotated.all).toBe(1);
    // Said plainly, because at this moment it is the only thing that opens the
    // vault and nothing here can tell whether it committed.
    expect(rotated.all).toMatch(/may have committed/);
    expect(rotated.all).toMatch(/Write this recovery key down now/);
    const newKey = keyIn(rotated);
    expect(newKey).not.toBe(oldKey);

    // On disk while it is unresolved: both secrets, so neither is lost.
    const staged = (await loadConfig(dir))!;
    expect(staged.pending, "the new secret was not written down before it was sent").toBeDefined();

    // A fresh process, which is all a config on disk is worth. The rotation did
    // commit, so the pending secret is the one that opens the vault, and the
    // run promotes it.
    const sync = await cli("sync", "--dir", dir);
    expect(sync.code, sync.all).toBe(0);
    const settled = (await loadConfig(dir))!;
    expect(settled.pending).toBeUndefined();
    expect((await cli("recovery-key", "--dir", dir)).out.join("\n").trim()).toBe(newKey);

    // And the key that was printed is the vault: it pairs a device, and the
    // one printed at init no longer does.
    const other = await vaultDir("other");
    expect((await cli("pair", oldKey, "--dir", other, "--device", "other")).all).toMatch(
      /not authorised/,
    );
    const paired = await cli("pair", newKey, "--dir", other, "--device", "other");
    expect(paired.code, paired.all).toBe(0);
    expect((await cli("sync", "--dir", other)).code).toBe(0);
    expect(await readFile(join(other, "kept.md"), "utf8")).toBe("written before the rotation\n");
  }, 120_000);

  it("comes back to the old secret when the rotation never reached the server", async () => {
    const { dir, key: oldKey } = await started("uncommitted");

    lose = "before-commit";
    const rotated = await cli("rotate", "--dir", dir);
    lose = undefined;
    expect(rotated.code, rotated.all).toBe(1);
    const neverUsed = keyIn(rotated);
    expect((await loadConfig(dir))!.pending).toBeDefined();

    // A fresh process. The pending secret is tried first and refused, the
    // current one works, and the outstanding rotation is dropped.
    const sync = await cli("sync", "--dir", dir);
    expect(sync.code, sync.all).toBe(0);
    expect((await loadConfig(dir))!.pending).toBeUndefined();
    expect((await cli("recovery-key", "--dir", dir)).out.join("\n").trim()).toBe(oldKey);

    // The old key is still the vault's, and the one that was printed opens
    // nothing, which is why both were kept until this was settled.
    const other = await vaultDir("other");
    expect((await cli("pair", neverUsed, "--dir", other, "--device", "other")).all).toMatch(
      /not authorised/,
    );
    expect((await cli("pair", oldKey, "--dir", other, "--device", "other")).code).toBe(0);
  }, 120_000);

  it("says so plainly when another device rotated first, and keeps one secret", async () => {
    const { dir, key } = await started("raced");
    lose = "refused";
    const rotated = await cli("rotate", "--dir", dir);
    lose = undefined;
    expect(rotated.code, rotated.all).toBe(1);
    expect(rotated.all).toMatch(/rotated by another device/);
    expect(rotated.all).toMatch(/pair it again/);
    // Nothing committed, so there is no second secret to keep: the config is
    // the one it started with, and a key it printed as the vault's would be a
    // key that opens nothing.
    expect(rotated.all).not.toMatch(/may have committed/);
    const config = (await loadConfig(dir))!;
    expect(config.pending).toBeUndefined();
    expect((await cli("recovery-key", "--dir", dir)).out.join("\n").trim()).toBe(key);
  }, 120_000);

  it("prints both keys while it is unresolved, rather than guessing at one", async () => {
    const { dir, key: oldKey } = await started("both");
    lose = "after-commit";
    const newKey = keyIn(await cli("rotate", "--dir", dir));
    lose = undefined;

    const reprint = await cli("recovery-key", "--dir", dir, "--json");
    expect(reprint.code, reprint.all).toBe(0);
    expect(reprint.json()["recoveryKey"]).toBe(oldKey);
    expect(reprint.json()["pendingRecoveryKey"]).toBe(newKey);
  }, 120_000);
});

/**
 * The vault's wrapped data key, pinned after the first connection so that a
 * server cannot hand this device a different one later. A rotation is the one
 * legitimate change, and it is the device that rotates which stores the new
 * blob; every other device is evicted and pairs again.
 */
describe("the wrapped data key this device pins", () => {
  it("is written down on the first connection and survives a rotation", async () => {
    const { dir } = await started("pin");
    const first = (await loadConfig(dir))!;
    expect(first.wrapped, "the vault's data key was never pinned").toBeDefined();
    // The candidate offered at claim is gone with the bootstrap that carried
    // it: nothing sends a claim once the vault is known to be claimed.
    expect(first.bootstrap).toBeUndefined();
    expect(first.claimWrapped).toBeUndefined();

    const rotated = await cli("rotate", "--dir", dir);
    expect(rotated.code, rotated.all).toBe(0);
    const after = (await loadConfig(dir))!;
    expect(after.wrapped, "the rotation left the old wrapping pinned").not.toBe(first.wrapped);

    // Which the next connection then agrees with, rather than being refused
    // by its own pin.
    await writeFile(join(dir, "after.md"), "after\n");
    const sync = await cli("sync", "--dir", dir, "--json");
    expect(sync.code, sync.all).toBe(0);
    expect(sync.json()["uploaded"]).toBe(1);
  }, 120_000);

  it("is pinned by a second device that has never claimed anything", async () => {
    const { key } = await started("first");
    const second = await vaultDir("second");
    expect((await cli("pair", key, "--dir", second, "--device", "second")).code).toBe(0);
    expect((await cli("sync", "--dir", second)).code).toBe(0);
    const config = (await loadConfig(second))!;
    expect(config.wrapped).toBeDefined();
    expect(config.claimWrapped, "a device with no bootstrap made a claim key").toBeUndefined();
    expect(await readFile(join(second, "kept.md"), "utf8")).toBe("written before the rotation\n");
  }, 120_000);
});
