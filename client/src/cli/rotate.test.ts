/**
 * Rotation across a process boundary, against a real server.
 *
 * The case this file exists for is the one an ordinary lost packet produces.
 * The server commits the new credential, closes every other registrar, and
 * only then answers; a connection that goes in between leaves the person with
 * a vault whose new root may exist nowhere but in this process.
 *
 * Protocol 4 changed where the durability lives. Rotation used to stage its new
 * secret in the device's own config and promote it on the next connection, and
 * there is nowhere to stage a root any more: a device does not hold one, which
 * is what makes revoking a single device mean anything. So the new key is
 * printed *before* the request goes out, and when the reply is lost the CLI
 * asks the server which secret it has rather than guessing.
 *
 * Both halves are here: the reply lost after the rotation committed, where the
 * answer is "the key above is the vault's", and lost before it, where the
 * answer is "cross it out".
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
        // vault's, because somebody rotated first.
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
  get stderr(): string {
    return this.err.join("\n");
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

/** Every recovery key a run printed, wherever it printed it. */
function keysIn(r: Run): string[] {
  return [...r.out, ...r.err].filter((l) => l.trim().startsWith("basalt3_")).map((l) => l.trim());
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
  /**
   * Committed, reply lost. The CLI cannot tell that from a rotation that never
   * landed, so it asks: the new root opens a registrar session if and only if
   * the server took it. That is a better answer than the staged secret used to
   * give, because it settles the question rather than deferring it to the next
   * connection.
   */
  it("finds out that it committed, and says the printed key is the vault's", async () => {
    const { dir, key: oldKey } = await started("committed");

    lose = "after-commit";
    const rotated = await cli("rotate", oldKey, "--dir", dir);
    lose = undefined;
    expect(rotated.code, rotated.all).toBe(0);
    expect(rotated.all).toMatch(/the rotation did commit/);
    const newKey = keysIn(rotated).find((k) => k !== oldKey)!;
    expect(newKey).toBeDefined();

    // And it is the vault: it adds a device, and the one printed at init does
    // not. The history written before the rotation reads back, because the
    // data key did not change.
    const other = await vaultDir("other");
    expect((await cli("pair", oldKey, "--dir", other, "--device", "other")).all).toMatch(
      /not authorised/,
    );
    const paired = await cli("pair", newKey, "--dir", other, "--device", "other");
    expect(paired.code, paired.all).toBe(0);
    expect((await cli("sync", "--dir", other)).code).toBe(0);
    expect(await readFile(join(other, "kept.md"), "utf8")).toBe("written before the rotation\n");

    // The rotating device never held either key and goes on syncing across the
    // whole thing, which is the point of rotation touching no device row.
    await writeFile(join(dir, "after.md"), "after\n");
    expect((await cli("sync", "--dir", dir)).code, "the rotation evicted this device").toBe(0);
  }, 120_000);

  it("finds out that it did not commit, and says to cross the printed key out", async () => {
    const { dir, key: oldKey } = await started("uncommitted");

    lose = "before-commit";
    const rotated = await cli("rotate", oldKey, "--dir", dir);
    lose = undefined;
    expect(rotated.code, rotated.all).toBe(1);
    expect(rotated.all).toMatch(/did not commit/);
    expect(rotated.all).toMatch(/cross out/);
    const neverUsed = keysIn(rotated).find((k) => k !== oldKey)!;

    // The old key is still the vault's, and the one that was printed opens
    // nothing, which is what the run said.
    const other = await vaultDir("other");
    expect((await cli("pair", neverUsed, "--dir", other, "--device", "other")).all).toMatch(
      /not authorised/,
    );
    expect((await cli("pair", oldKey, "--dir", other, "--device", "other")).code).toBe(0);
  }, 120_000);

  it("says so plainly when somebody rotated first, and does not offer a key", async () => {
    const { dir, key } = await started("raced");
    lose = "refused";
    const rotated = await cli("rotate", key, "--dir", dir);
    lose = undefined;
    expect(rotated.code, rotated.all).toBe(1);
    expect(rotated.all).toMatch(/rotated by somebody else first/);
    expect(rotated.all).toMatch(/Cross it out/);
    // Nothing committed, so the key it printed before sending is not the
    // vault's, and the run says which. It must not read as "this may have
    // worked": a key that opens nothing, written down in place of one that
    // does, is worse than either.
    expect(rotated.all).not.toMatch(/did commit/);
  }, 120_000);

  /**
   * The one thing that has to be true before the request goes out, now that
   * there is nowhere on a device to stage a root: the key is on the screen, so
   * a person can write it down, before the server can possibly have taken it.
   */
  it("prints the new key before sending, not after hearing back", async () => {
    const { dir, key } = await started("printed");
    lose = "before-commit";
    const rotated = await cli("rotate", key, "--dir", dir);
    lose = undefined;
    // The rotate threw, so nothing after the request ran, and the key is still
    // here: it was printed on the way in.
    expect(rotated.err.some((l) => l.trim().startsWith("basalt3_"))).toBe(true);
    expect(rotated.stderr).toMatch(/Write it down before pressing on/);
  }, 120_000);
});

/**
 * What a device keeps across a rotation, which since protocol 4 is everything
 * it had: rotation replaces the vault's secret and the wrapping of the data
 * key, and touches no device row.
 */
describe("what a rotation leaves on a device", () => {
  it("leaves this device's own credential exactly as it was", async () => {
    const { dir, key } = await started("pin");
    const before = (await loadConfig(dir))!;
    expect(before.secret, "a paired device is holding the root").toBeUndefined();
    expect(before.deviceId).toBeDefined();

    expect((await cli("rotate", key, "--dir", dir)).code).toBe(0);

    const after = (await loadConfig(dir))!;
    expect(after.deviceId).toBe(before.deviceId);
    expect([...after.deviceSecret!]).toEqual([...before.deviceSecret!]);
    // The data key above all: a rotation that changed it would make every
    // note already on the server unreadable.
    expect([...after.dataKey!]).toEqual([...before.dataKey!]);

    await writeFile(join(dir, "after.md"), "after\n");
    const sync = await cli("sync", "--dir", dir, "--json");
    expect(sync.code, sync.all).toBe(0);
    expect(sync.json()["uploaded"]).toBe(1);
  }, 120_000);

  it("leaves a second device syncing too, which is the point", async () => {
    const { dir, key } = await started("first");
    const second = await vaultDir("second");
    expect((await cli("pair", key, "--dir", second, "--device", "second")).code).toBe(0);
    expect((await cli("sync", "--dir", second)).code).toBe(0);

    expect((await cli("rotate", key, "--dir", dir)).code).toBe(0);

    // Under protocol 3 this device would have been evicted by the rotation and
    // would have had to be paired again from the new string, which for a
    // laptop, a phone, a desktop and a NAS is a weekend.
    await writeFile(join(second, "still.md"), "still here\n");
    const sync = await cli("sync", "--dir", second, "--json");
    expect(sync.code, sync.all).toBe(0);
    expect(sync.json()["uploaded"]).toBe(1);
    expect(await readFile(join(second, "kept.md"), "utf8")).toBe("written before the rotation\n");
  }, 120_000);
});
