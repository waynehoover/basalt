/**
 * The headless client, end to end.
 *
 * Two directories on a real disk, a real Go server, and the CLI driven the way a
 * person drives it: init, pair, sync. Nothing is in memory here and nothing is
 * stubbed, so what this covers is the whole client except the terminal.
 *
 * The engine tests use in-memory vaults, which is what makes them fast enough to
 * run a mutation pass over. This is the other half: it is the one that would
 * notice if the filesystem adapter, the config on disk, the pairing string or
 * the argument parsing were wrong, none of which those tests touch.
 */

import { mkdtemp, readFile, readdir, rm, stat, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { cleanupBinary, removeTree, serverBinary, TestServer } from "../core/test-server.ts";
import { PAIRING_PREFIX, parseInvite } from "../core/pairing.ts";
import { redeemInvite } from "../core/client.ts";
import type { SyncReport } from "../core/engine.ts";
import { run, exitCodeFor, normaliseUrl, parseArgs, renderReport, type Console } from "./cli.ts";
import { NodeVault } from "./vault.ts";

beforeAll(async () => {
  await serverBinary();
}, 180_000);

afterAll(async () => {
  await cleanupBinary();
});

/** Captures what the CLI printed, and what it exited with. */
class Run {
  readonly out: string[] = [];
  readonly err: string[] = [];
  code = -1;

  get stdout(): string {
    return this.out.join("\n");
  }
  get stderr(): string {
    return this.err.join("\n");
  }
  get all(): string {
    return this.stdout + "\n" + this.stderr;
  }
  json(): Record<string, unknown> {
    return JSON.parse(this.stdout) as Record<string, unknown>;
  }
}

async function cli(...argv: string[]): Promise<Run> {
  const r = new Run();
  const io: Console = { out: (l) => r.out.push(l), err: (l) => r.err.push(l) };
  r.code = await run(argv, io);
  return r;
}

let server: TestServer;
const dirs: string[] = [];

async function vaultDir(name: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `basalt-${name}-`));
  dirs.push(dir);
  return dir;
}

async function fresh(): Promise<void> {
  server = new TestServer();
  await server.start();
}

afterEach(async () => {
  // Retried, because `rm` lists a directory and then removes it, and with
  // twenty-one test files running at once against the same /tmp it can find
  // the directory repopulated in between and throw ENOTEMPTY. Node retries
  // that error specifically when asked to. It showed up once in twelve full
  // runs, on `.basalt`.
  //
  // This is not covering for a write that outlived the command, which was the
  // first suspicion and would have been a real bug. save() is awaited, the
  // sync is awaited before close(), close() is synchronous, and neither the
  // CLI nor the engine leaves anything running. Nothing of ours is still
  // writing by the time this runs.
  while (dirs.length) await removeTree(dirs.pop()!);
  if (server) await server.cleanup();
});

/** Pairs two directories against the running server and returns them. */
async function twoDevices(): Promise<{ a: string; b: string; recoveryKey: string }> {
  const a = await vaultDir("a");
  const b = await vaultDir("b");

  const init = await cli(
    "init",
    "--dir",
    a,
    "--server",
    server.wsUrl,
    "--token",
    server.token,
    "--device",
    "a",
    "--json",
  );
  expect(init.code, init.all).toBe(0);
  const pairing = init.json()["recoveryKey"] as string;

  const paired = await cli("pair", pairing, "--dir", b, "--device", "b", "--json");
  expect(paired.code, paired.all).toBe(0);
  return { a, b, recoveryKey: pairing };
}

/**
 * Starts a vault and returns the directory and the recovery key.
 *
 * The key comes from `init`, because that is the only time it exists: a
 * paired device holds its own credential and not the vault's root, so
 * nothing reprints it. Tests that need a second device keep it the way a
 * person is told to, by writing it down.
 */
async function startedWithKey(name = "a"): Promise<{ dir: string; recoveryKey: string }> {
  const dir = await vaultDir(name);
  const init = await cli(
    "init",
    "--dir",
    dir,
    "--server",
    server.wsUrl,
    "--token",
    server.token,
    "--device",
    name,
    "--json",
  );
  expect(init.code, init.all).toBe(0);
  return { dir, recoveryKey: init.json()["recoveryKey"] as string };
}

const read = (dir: string, path: string) => readFile(join(dir, path), "utf8");
const write = async (dir: string, path: string, text: string) => {
  await mkdir(join(dir, path, ".."), { recursive: true });
  await writeFile(join(dir, path), text);
};

describe("pairing a vault", () => {
  it("prints a pairing string the other device can use", async () => {
    await fresh();
    const { a, b } = await twoDevices();

    // Both ends agree about the vault, and only one of them was told.
    const configA = JSON.parse(await read(a, ".basalt/config.json")) as Record<string, string>;
    const configB = JSON.parse(await read(b, ".basalt/config.json")) as Record<string, string>;
    expect(configB["secret"]).toBe(configA["secret"]);
    expect(configB["url"]).toBe(configA["url"]);
    expect(configB["device"]).toBe("b");
    expect(configA["device"]).toBe("a");
  }, 240_000);

  it("takes the one line the server printed, as printed", async () => {
    // The server prints `host:port#TOKEN`. It used to have to be split into
    // --server and --token by hand, which the README did not say and the
    // plugin's two fields did not make obvious. One paste, on every device.
    await fresh();
    const a = await vaultDir("a");
    const init = await cli("init", server.setup, "--dir", a, "--device", "a", "--json");
    expect(init.code, init.all).toBe(0);
    const config = JSON.parse(await read(a, ".basalt/config.json")) as Record<string, string>;
    expect(config["url"]).toBe(server.wsUrl);

    const b = await vaultDir("b");
    const paired = await cli("pair", init.json()["recoveryKey"] as string, "--dir", b, "--json");
    expect(paired.code, paired.all).toBe(0);
  }, 240_000);

  it("says what a setup line looks like when handed something else", async () => {
    await fresh();
    const a = await vaultDir("a");
    const noHash = await cli("init", "homelab:3003", "--dir", a);
    expect(noHash.code).toBe(1);
    expect(noHash.stderr).toMatch(/host:3003#TOKEN/);

    const both = await cli("init", server.setup, "--server", server.wsUrl, "--dir", a);
    expect(both.code).toBe(1);
    expect(both.stderr).toMatch(/not both/);
  });

  it("keeps the secret out of everybody else's reach", async () => {
    // It is the whole vault. A config that lands world-readable in a shared
    // home directory is the quiet way to lose one.
    await fresh();
    const { a } = await twoDevices();
    const mode = (await stat(join(a, ".basalt", "config.json"))).mode & 0o777;
    expect(mode.toString(8)).toBe("600");
  }, 240_000);

  /**
   * The recovery key is shown once and no device keeps it. That is not a
   * missing feature: a device holding the root could re-derive the vault's
   * credential and register itself again after being revoked, so revoking it
   * would stop nothing. The refusal says that rather than saying "no such
   * command", because somebody typing it is looking for the key.
   */
  it("cannot reprint the recovery key, and says why", async () => {
    await fresh();
    const { dir } = await startedWithKey();
    const asked = await cli("recovery-key", "--dir", dir);
    expect(asked.code).toBe(1);
    expect(asked.all).toMatch(/does not hold the vault's recovery key/);
    expect(asked.all).toMatch(/shown once/);
    // And it is not on disk either, which is the fact the sentence rests on.
    const config = JSON.parse(await read(dir, ".basalt/config.json")) as Record<string, string>;
    expect(config["secret"], "the root secret is still on this device").toBeUndefined();
    expect(config["deviceId"]).toMatch(/^[A-Za-z0-9_-]+$/);
  }, 240_000);

  /**
   * Re-pairing over a paired vault would replace the root secret, and every
   * note already on the server would stop being decryptable here. The vault
   * would look empty, and syncing would then upload the local copies under new
   * keys. There is no coming back from that, so it is refused.
   */
  it("refuses to pair a vault that is already paired", async () => {
    await fresh();
    const { a, b } = await twoDevices();
    const again = await cli("init", "--dir", a, "--server", server.wsUrl, "--token", server.token);
    expect(again.code).toBe(1);
    expect(again.all).toMatch(/already paired/);

    const repair = await cli("pair", "basalt3_anything", "--dir", b);
    expect(repair.code).toBe(1);
    expect(repair.all).toMatch(/already paired/);
  }, 240_000);

  it("refuses a pairing string that was mangled on the way", async () => {
    await fresh();
    const { recoveryKey: pairing } = await startedWithKey();
    const c = await vaultDir("c");

    const truncated = await cli("pair", pairing.slice(0, -4), "--dir", c);
    expect(truncated.code).toBe(1);
    expect(truncated.all).toMatch(/damaged|too short/);

    const nonsense = await cli("pair", "have-a-nice-day", "--dir", c);
    expect(nonsense.code).toBe(1);
    expect(nonsense.all).toMatch(/basalt3_/);

    // And nothing was written, so a failed pair leaves no half-configured vault.
    await expect(read(c, ".basalt/config.json")).rejects.toThrow();
  }, 240_000);
});

describe("syncing real files on a real disk", () => {
  it("carries a vault from one directory to another", async () => {
    await fresh();
    const { a, b } = await twoDevices();

    await write(a, "note.md", "# Hello\n\nFrom device a.\n");
    await write(a, "folder/deep/nested.md", "Nested.\n");
    await writeFile(join(a, "picture.bin"), Buffer.from([0, 1, 2, 253, 254, 255]));

    const up = await cli("sync", "--dir", a, "--json");
    expect(up.code, up.all).toBe(0);
    // Three files and the two folders above them. Folders are entries of
    // their own, which is what lets an empty one exist on both devices.
    expect(up.json()["uploaded"], up.all).toBe(5);

    const down = await cli("sync", "--dir", b, "--json");
    expect(down.code, down.all).toBe(0);
    expect(down.json()["downloaded"], down.all).toBe(3);
    expect(down.json()["foldersCreated"], down.all).toBe(2);

    expect(await read(b, "note.md")).toBe("# Hello\n\nFrom device a.\n");
    expect(await read(b, "folder/deep/nested.md")).toBe("Nested.\n");
    expect([...(await readFile(join(b, "picture.bin")))]).toEqual([0, 1, 2, 253, 254, 255]);
  }, 300_000);

  it("says there is nothing to do when there is nothing to do", async () => {
    await fresh();
    const { a, b } = await twoDevices();
    await write(a, "note.md", "one\n");
    await cli("sync", "--dir", a);
    await cli("sync", "--dir", b);

    const again = await cli("sync", "--dir", b);
    expect(again.code).toBe(0);
    expect(again.stdout).toMatch(/Nothing to do/);
  }, 300_000);

  /**
   * The debounce holds back a file written moments ago, which is right for a
   * client that stays running and wrong for one that exits: there is no next
   * pass, so "unchanged" would mean "silently skipped the file you just saved".
   */
  it("syncs a file saved a second ago rather than deferring it", async () => {
    await fresh();
    const { a, b } = await twoDevices();
    await write(a, "just-typed.md", "written right now\n");

    const up = await cli("sync", "--dir", a, "--json");
    expect(up.json()["uploaded"], up.all).toBe(1);
    expect(up.json()["waiting"]).toBe(0);

    await cli("sync", "--dir", b);
    expect(await read(b, "just-typed.md")).toBe("written right now\n");
  }, 300_000);

  it("carries an edit back the other way", async () => {
    await fresh();
    const { a, b } = await twoDevices();
    await write(a, "note.md", "first\n");
    await cli("sync", "--dir", a);
    await cli("sync", "--dir", b);

    await write(b, "note.md", "second\n");
    await cli("sync", "--dir", b);
    const back = await cli("sync", "--dir", a, "--json");
    expect(back.json()["downloaded"], back.all).toBe(1);
    expect(await read(a, "note.md")).toBe("second\n");
  }, 300_000);

  it("carries a deletion", async () => {
    await fresh();
    const { a, b } = await twoDevices();
    await write(a, "doomed.md", "here for now\n");
    await cli("sync", "--dir", a);
    await cli("sync", "--dir", b);
    expect(await read(b, "doomed.md")).toBe("here for now\n");

    await rm(join(a, "doomed.md"));
    await cli("sync", "--dir", a);
    const gone = await cli("sync", "--dir", b, "--json");
    expect(gone.json()["deletedLocally"], gone.all).toBe(1);
    await expect(read(b, "doomed.md")).rejects.toThrow();
  }, 300_000);

  it("cuts the deleted list to --limit and says there is more", async () => {
    // --limit was passed through only above 20, so `--limit 1` showed every
    // deletion and the "older deletions" line never appeared.
    await fresh();
    const { a } = await twoDevices();
    for (const name of ["one.md", "two.md", "three.md"]) await write(a, name, `${name}\n`);
    await cli("sync", "--dir", a);
    for (const name of ["one.md", "two.md", "three.md"]) await rm(join(a, name));
    await cli("sync", "--dir", a);

    const all = await cli("deleted", "--dir", a, "--json");
    expect((all.json()["deleted"] as unknown[]).length, all.all).toBe(3);
    expect(all.json()["more"]).toBe(false);

    const one = await cli("deleted", "--dir", a, "--limit", "1", "--json");
    expect((one.json()["deleted"] as unknown[]).length, one.all).toBe(1);
    expect(one.json()["more"]).toBe(true);

    const plain = await cli("deleted", "--dir", a, "--limit", "1");
    expect(plain.stdout).toMatch(/older deletions/);
  }, 300_000);

  /**
   * Rule 10 of docs/design.md: the property is not that the devices agree,
   * it is that neither edit was lost. Both are asserted by name.
   */
  it("keeps both versions when two devices rewrite the same line", async () => {
    await fresh();
    const { a, b } = await twoDevices();
    await write(a, "note.md", "# Note\n\nThe original sentence.\n");
    await cli("sync", "--dir", a);
    await cli("sync", "--dir", b);

    await write(a, "note.md", "# Note\n\nA's completely different sentence.\n");
    await write(b, "note.md", "# Note\n\nB's entirely other sentence.\n");
    await cli("sync", "--dir", a);
    const conflict = await cli("sync", "--dir", b, "--json");
    expect(conflict.json()["conflicted"], conflict.all).toBe(1);
    await cli("sync", "--dir", a);
    await cli("sync", "--dir", b);

    const { readdir } = await import("node:fs/promises");
    for (const dir of [a, b]) {
      const names = await readdir(dir);
      const texts = await Promise.all(
        names.filter((n) => n.endsWith(".md")).map((n) => read(dir, n)),
      );
      const all = texts.join("\n---\n");
      expect(all, `${dir} lost A's version`).toContain("A's completely different sentence");
      expect(all, `${dir} lost B's version`).toContain("B's entirely other sentence");
      expect(
        names.some((n) => n.includes("Conflicted copy")),
        `${dir} has no conflict copy`,
      ).toBe(true);
    }
  }, 300_000);

  it("merges edits to different parts of one note", async () => {
    await fresh();
    const { a, b } = await twoDevices();
    const base = [
      "# Note",
      "",
      "First paragraph.",
      "",
      "Second paragraph.",
      "",
      "Third paragraph.",
    ].join("\n");
    await write(a, "note.md", base);
    await cli("sync", "--dir", a);
    await cli("sync", "--dir", b);

    await write(a, "note.md", base.replace("First paragraph.", "First paragraph, edited on A."));
    await write(b, "note.md", base.replace("Third paragraph.", "Third paragraph, edited on B."));
    await cli("sync", "--dir", a);
    await cli("sync", "--dir", b);
    await cli("sync", "--dir", a);

    for (const dir of [a, b]) {
      const text = await read(dir, "note.md");
      expect(text, `${dir} lost A's edit`).toContain("edited on A");
      expect(text, `${dir} lost B's edit`).toContain("edited on B");
    }
  }, 300_000);

  it("leaves its own state folder out of the vault it syncs", async () => {
    // .basalt holds the root secret. Syncing it would put the key to the
    // vault in the vault, which is the one place it must never be.
    await fresh();
    const { a, b } = await twoDevices();
    await write(a, "note.md", "x\n");
    await cli("sync", "--dir", a);
    await cli("sync", "--dir", b);

    const configB = JSON.parse(await read(b, ".basalt/config.json")) as Record<string, string>;
    expect(configB["device"]).toBe("b");
    const { readdir } = await import("node:fs/promises");
    expect(await readdir(join(b, ".basalt"))).not.toContain("config.json.tmp");
  }, 300_000);
});

describe("status", () => {
  it("says where things stand, and admits when it cannot tell", async () => {
    await fresh();
    const { a } = await twoDevices();
    await write(a, "one.md", "1\n");
    await write(a, "two.md", "2\n");
    await cli("sync", "--dir", a);

    const ok = await cli("status", "--dir", a, "--json");
    expect(ok.code, ok.all).toBe(0);
    const s = ok.json();
    expect(s["tracked"]).toBe(2);
    expect(s["device"]).toBe("a");
    expect((s["server"] as Record<string, unknown>)["reachable"]).toBe(true);
    expect((s["server"] as Record<string, unknown>)["behind"]).toBe(0);

    // And with the server gone it says so rather than reporting up to date,
    // which is rule 7: a status that cannot tell must not pretend.
    await server.cleanup();
    const down = await cli("status", "--dir", a, "--json");
    expect(down.code).toBe(1);
    expect((down.json()["server"] as Record<string, unknown>)["reachable"]).toBe(false);

    const human = await cli("status", "--dir", a);
    expect(human.stdout).toMatch(/cannot reach the server/);
    expect(human.stdout).not.toMatch(/up to date/);
  }, 300_000);

  /**
   * R1. Status asks for one number and closes, so it connects only as far as
   * the handshake. The number has to stay the server's own: a device that has
   * never synced has the whole vault as backlog, and reading the cursor off
   * its own index instead would print zero and call it up to date.
   */
  it("reports the server's cursor from a device that has not caught up (R1)", async () => {
    await fresh();
    const { a, b } = await twoDevices();
    await write(a, "one.md", "1\n");
    await write(a, "two.md", "2\n");
    await write(a, "three.md", "3\n");
    await cli("sync", "--dir", a);

    const s = await cli("status", "--dir", b, "--json");
    expect(s.code, s.all).toBe(0);
    const server_ = s.json()["server"] as Record<string, unknown>;
    expect(server_["reachable"]).toBe(true);
    expect(server_["cursor"]).toBe(3);
    expect(s.json()["cursor"]).toBe(0);
    expect(server_["behind"]).toBe(3);
    // And it stayed a question: nothing of the backlog was written here.
    expect((await readdir(b)).sort()).toEqual([".basalt"]);
  }, 300_000);

  /**
   * The cursor says what has been seen, not what has been applied.
   *
   * A path that is a file here and a folder on the other device is applied by
   * nobody and never will be, and the cursor moves past it regardless. Status
   * printed "1 files with work outstanding" and "up to date with the server"
   * on the same screen, and the second line is the one people read. Rule 7:
   * "everything is here" and "everything I chose to look at is here" have to
   * read differently.
   */
  it("does not call a vault up to date while work is outstanding", async () => {
    await fresh();
    const { a, b } = await twoDevices();
    await write(a, "thing.md", "a file on a\n");
    await cli("sync", "--dir", a);
    await cli("sync", "--dir", b);

    // The same name, a folder on a. b can never apply it: it holds the file.
    await rm(join(a, "thing.md"));
    await mkdir(join(a, "thing.md"), { recursive: true });
    await write(a, "thing.md/inner.md", "inside\n");
    for (let i = 0; i < 3; i++) await cli("sync", "--dir", a);
    for (let i = 0; i < 3; i++) await cli("sync", "--dir", b);

    const s = await cli("status", "--dir", b, "--json");
    expect((s.json()["server"] as Record<string, unknown>)["behind"]).toBe(0);
    expect(s.json()["pending"]).toBeGreaterThan(0);

    const human = await cli("status", "--dir", b);
    expect(human.stdout, human.all).toMatch(/work outstanding/);
    expect(human.stdout, human.all).not.toMatch(/up to date/);
  }, 300_000);

  /**
   * N3. A server that answers and will not have this device is not a server
   * that is down, and the two used to land in the same field. After a restore
   * from an older backup that is the difference between "the box is off" and
   * "the box is up and has lost history", and a cron job keying on
   * `reachable` read the second as the first.
   */
  /**
   * Rule 7, and the third state this field has to keep apart from the other
   * two. A device with no credential has asked nothing of the server, so it is
   * neither reachable nor refused, and reporting either would be a status
   * about a connection that was never made. "Not authorised" in particular
   * sends somebody hunting a server problem that is not there.
   */
  it("says a device never registered itself, rather than blaming the server", async () => {
    await fresh();
    const { dir, recoveryKey } = await startedWithKey();
    // What a vault started here and never joined leaves: the root, and no row
    // of its own.
    const { parsePairing } = await import("../core/pairing.ts");
    const { saveConfig, loadConfig } = await import("./config.ts");
    const held = (await loadConfig(dir))!;
    await saveConfig(dir, {
      url: held.url,
      vaultId: held.vaultId,
      device: held.device,
      secret: parsePairing(recoveryKey).secret,
    });

    const s = await cli("status", "--dir", dir, "--json");
    expect(s.code, s.all).toBe(1);
    const answer = s.json()["server"] as Record<string, unknown>;
    expect(answer["reachable"], s.all).toBe(false);
    expect(answer["refused"], s.all).toBe(false);
    expect(String(answer["error"])).toMatch(/never registered itself/);
    expect(String(answer["error"]), "the refusal did not hand the key back").toContain(recoveryKey);

    // And it says the same thing in words, with the way out named.
    const human = await cli("status", "--dir", dir);
    expect(human.all).toMatch(/unlink this vault and pair again/);
    expect(human.all, "an unregistered device was reported as an outage").not.toMatch(
      /cannot reach the server/,
    );
  }, 60_000);

  /**
   * The other half, and the one the words have to get right: a config with
   * neither a root nor a credential is nothing this client can finish, so it
   * says how to pair rather than how to retry.
   */
  it("tells a device with no credential at all to pair again", async () => {
    await fresh();
    const { dir } = await startedWithKey();
    const { saveConfig, loadConfig } = await import("./config.ts");
    const held = (await loadConfig(dir))!;
    // A credential half written: an id and nothing to prove it with. Nothing
    // writes this, and a config that predates this version can hold it.
    await saveConfig(dir, {
      url: held.url,
      vaultId: held.vaultId,
      device: held.device,
      deviceId: held.deviceId!,
    });

    const sync = await cli("sync", "--dir", dir);
    expect(sync.code, sync.all).toBe(1);
    expect(sync.all).toMatch(/no credential for the vault/);
    expect(sync.all).toMatch(/a device secret, the vault's data key/);
    expect(sync.all).toMatch(/invite from another device/);
  }, 60_000);

  it("tells a refusal apart from an outage (N3)", async () => {
    await fresh();
    const { a } = await twoDevices();
    await write(a, "one.md", "1\n");
    await cli("sync", "--dir", a);

    // This device has applied more than the server ever issued, which is what
    // a server restored from an older backup looks like from here.
    const index = join(a, ".basalt", "index.json");
    const stored = JSON.parse(await readFile(index, "utf8")) as Record<string, unknown>;
    await writeFile(index, JSON.stringify({ ...stored, cursor: 9_999 }));

    const s = await cli("status", "--dir", a, "--json");
    expect(s.code, s.all).toBe(1);
    const answer = s.json()["server"] as Record<string, unknown>;
    expect(answer["refused"], s.all).toBe(true);
    expect(answer["reachable"], s.all).toBe(true);

    const human = await cli("status", "--dir", a);
    expect(human.stdout, human.all).toMatch(/refused this device/);
    expect(human.stdout, human.all).not.toMatch(/cannot reach the server/);
  }, 300_000);
});

describe("unlinking", () => {
  it("names the row it leaves behind, and what removes it", async () => {
    // Unlinking is local on purpose: it has to work when the server does not.
    // The cost is a row nothing here can remove afterwards, because the
    // credential for it is what was just forgotten.
    await fresh();
    const { a, b } = await twoDevices();
    const listed = await cli("devices", "--dir", b, "--json");
    const mine = listed.json()["thisDevice"] as string;

    const gone = await cli("unlink", "--dir", b);
    expect(gone.code, gone.all).toBe(0);
    expect(gone.stdout).toContain(mine);
    expect(gone.stdout).toMatch(new RegExp(`basalt revoke ${mine}`));

    // And it is true: the row is still there, and that command removes it.
    const still = await cli("devices", "--dir", a, "--json");
    expect((still.json()["devices"] as Record<string, unknown>[]).map((d) => d["id"])).toContain(
      mine,
    );
    expect((await cli("revoke", mine, "--dir", a)).code).toBe(0);
  }, 60_000);

  it("forgets the pairing and keeps every note", async () => {
    await fresh();
    const { a, b, recoveryKey } = await twoDevices();
    await write(a, "keep.md", "still here\n");
    await cli("sync", "--dir", a);
    await cli("sync", "--dir", b);

    const gone = await cli("unlink", "--dir", b, "--json");
    expect(gone.code).toBe(0);
    expect(await read(b, "keep.md")).toBe("still here\n");
    await expect(read(b, ".basalt/config.json")).rejects.toThrow();

    // And the server still has it, because unlinking is a local decision.
    const c = await vaultDir("c");
    await cli("pair", recoveryKey, "--dir", c, "--device", "c");
    await cli("sync", "--dir", c);
    expect(await read(c, "keep.md")).toBe("still here\n");
  }, 300_000);
});

describe("saying no clearly", () => {
  it("refuses to sync a vault nobody paired", async () => {
    const dir = await vaultDir("lonely");
    const r = await cli("sync", "--dir", dir);
    expect(r.code).toBe(1);
    expect(r.all).toMatch(/not paired/);
  });

  it("refuses a config it cannot trust rather than starting over", async () => {
    // Rule 2. A config read as absent because it could not be parsed would
    // look like an unpaired vault, and the next pair would replace the root
    // secret with a new one.
    const dir = await vaultDir("broken");
    await mkdir(join(dir, ".basalt"), { recursive: true });
    await writeFile(join(dir, ".basalt", "config.json"), "{ not json");
    const r = await cli("status", "--dir", dir);
    expect(r.code).toBe(1);
    expect(r.all).toMatch(/not valid JSON/);
  });

  it("refuses a config whose secret is the wrong size", async () => {
    // A short secret derives keys perfectly happily. They are the wrong keys,
    // and the vault would sync and decrypt nothing.
    const dir = await vaultDir("shortsecret");
    await mkdir(join(dir, ".basalt"), { recursive: true });
    await writeFile(
      join(dir, ".basalt", "config.json"),
      JSON.stringify({
        url: "ws://x",
        token: "t",
        vaultId: "default",
        device: "d",
        secret: "AAAA",
      }),
    );
    const r = await cli("status", "--dir", dir);
    expect(r.code).toBe(1);
    expect(r.all).toMatch(/root secret is 32 bytes/);
  });

  it("refuses init without somewhere to init against", async () => {
    const dir = await vaultDir("noserver");
    const r = await cli("init", "--dir", dir);
    expect(r.code).toBe(1);
    expect(r.all).toMatch(/host:3003#TOKEN/);
  });

  it("prints usage for no command and for a wrong one", async () => {
    const none = await cli();
    expect(none.code).toBe(2);
    expect(none.stdout).toMatch(/basalt sync/);

    const wrong = await cli("frobnicate");
    expect(wrong.code).toBe(2);
    expect(wrong.all).toMatch(/no such command: frobnicate/);
  });
});

describe("arguments", () => {
  it("refuses an option that swallowed the next option", () => {
    // --dir --json would otherwise point the vault at a directory called
    // "--json", create it, and sync the wrong thing.
    expect(() => parseArgs(["sync", "--dir", "--json"])).toThrow(/--dir needs a value/);
    expect(() => parseArgs(["sync", "--dir"])).toThrow(/--dir needs a value/);
  });

  it("refuses an option it does not know", () => {
    expect(() => parseArgs(["sync", "--force"])).toThrow(/no such option: --force/);
  });

  it("refuses a timeout that is not a number", () => {
    expect(() => parseArgs(["sync", "--timeout", "soon"])).toThrow(/milliseconds/);
    expect(() => parseArgs(["sync", "--timeout", "0"])).toThrow(/milliseconds/);
  });

  /**
   * N4. The list is matched against one part of a path at a time, so a value
   * with a slash in it can never match anything. Accepted in silence, it read
   * as a folder kept out of this device and kept nothing out.
   */
  it("refuses an ignore that could never match a path segment (N4)", () => {
    expect(() => parseArgs(["sync", "--ignore", "a/b"])).toThrow(/one folder or file name/);
    expect(() => parseArgs(["sync", "--ignore", ""])).toThrow(/one folder or file name/);
    expect(() => parseArgs(["sync", "--ignore", "."])).toThrow(/one folder or file name/);
    expect(() => parseArgs(["sync", "--ignore", ".."])).toThrow(/one folder or file name/);
    expect(parseArgs(["sync", "--ignore", "Drafts"]).ignore).toEqual(["Drafts"]);
    expect(parseArgs(["sync", "--ignore", "..."]).ignore).toEqual(["..."]);
  });
});

describe("server addresses", () => {
  it("accepts what a person is likely to type", () => {
    expect(normaliseUrl("ws://host:8384")).toBe("ws://host:8384");
    expect(normaliseUrl("wss://host")).toBe("wss://host");
    expect(normaliseUrl("http://host:8384")).toBe("ws://host:8384");
    expect(normaliseUrl("https://host/")).toBe("wss://host");
    // A bare host gets TLS, because TLS is terminated in front of the server
    // and the plain case is the one worth being explicit about.
    expect(normaliseUrl("laptop.tail1234.ts.net")).toBe("wss://laptop.tail1234.ts.net");
    expect(normaliseUrl("  host:8384  ")).toBe("wss://host:8384");
  });

  it("refuses one it would have to guess at", () => {
    expect(() => normaliseUrl("ftp://host")).toThrow(/ws:\/\/ or wss:\/\//);
    expect(() => normaliseUrl("   ")).toThrow(/not a server address/);
  });
});

describe("one secret", () => {
  /**
   * A vault used to have two: a root secret the devices shared, and a server
   * token that had nothing to do with it. The auth key is now another branch
   * of the same HKDF schedule that produces the content and path keys, so
   * holding the root secret is what it means to have the vault.
   */
  it("spends the server's first-run token and then forgets it", async () => {
    await fresh();
    const a = await vaultDir("a");
    await cli(
      "init",
      "--dir",
      a,
      "--server",
      server.wsUrl,
      "--token",
      server.token,
      "--device",
      "a",
      "--json",
    );

    // Spent during init, because init is what claims the vault. It used to
    // survive until the first sync, which meant the vault was unclaimed
    // until then and a second device paired in between was refused.
    await write(a, "note.md", "claimed\n");
    expect((await cli("sync", "--dir", a, "--json")).code).toBe(0);

    // Keeping it is keeping a second secret that opens nothing, and so is
    // keeping the root: init registers this device and drops both, so what is
    // left is a credential for one row and the data key it reads with.
    const after = JSON.parse(await read(a, ".basalt/config.json")) as Record<string, string>;
    expect(after["bootstrap"]).toBeUndefined();
    expect(Object.keys(after).sort()).toEqual([
      "dataKey",
      "device",
      "deviceId",
      "deviceSecret",
      "url",
      "vaultId",
    ]);

    // And the vault still syncs, on a credential derived from the secret.
    await write(a, "again.md", "still working\n");
    expect((await cli("sync", "--dir", a, "--json")).json()["uploaded"]).toBe(1);
  }, 300_000);

  it("has no token in the pairing string at all", async () => {
    await fresh();
    const { dir: a, recoveryKey: pairing } = await startedWithKey();
    await write(a, "note.md", "x\n");
    await cli("sync", "--dir", a);

    // The bootstrap is not in it, and neither is anything else that a
    // second device would need beyond the secret and the address.
    expect(pairing).not.toContain(server.token);
    expect(
      Buffer.from(pairing.slice(PAIRING_PREFIX.length), "base64url").toString("latin1"),
    ).not.toContain(server.token);

    const b = await vaultDir("b");
    await cli("pair", pairing, "--dir", b, "--device", "b");
    const config = JSON.parse(await read(b, ".basalt/config.json")) as Record<string, string>;
    expect(
      config["bootstrap"],
      "a second device was handed a bootstrap it must not have",
    ).toBeUndefined();

    // And it syncs, because the secret it was given derives the credential.
    await cli("sync", "--dir", b);
    expect(await read(b, "note.md")).toBe("x\n");
  }, 300_000);

  /**
   * Once a vault is claimed the printed token opens nothing. Otherwise it
   * would stay a working credential for the life of the server, which is
   * exactly the second secret this removes.
   */
  it("stops accepting the first-run token once the vault is claimed", async () => {
    await fresh();
    const a = await vaultDir("a");
    await cli(
      "init",
      "--dir",
      a,
      "--server",
      server.wsUrl,
      "--token",
      server.token,
      "--device",
      "a",
      "--json",
    );
    await cli("sync", "--dir", a);

    // Somebody else with the printed token and a secret of their own. The
    // claim is where it is refused now, because init claims and registers
    // before it reports anything, rather than writing a config and finding
    // out later.
    const intruder = await vaultDir("intruder");
    const claim = await cli(
      "init",
      "--dir",
      intruder,
      "--server",
      server.wsUrl,
      "--token",
      server.token,
      "--device",
      "intruder",
    );
    expect(claim.code, `the spent bootstrap still worked: ${claim.all}`).toBe(1);
    expect(claim.all).toMatch(/auth|not authorised/i);
    // And nothing it left behind syncs either: a secret the vault was never
    // bound to is not a credential, whatever else is on this disk.
    const attempt = await cli("sync", "--dir", intruder);
    expect(attempt.code, attempt.all).toBe(1);
    expect(attempt.all).toMatch(/never registered itself/);
  }, 300_000);
});

describe("what counts as a successful run", () => {
  /**
   * A sync that ends with files still failing has not finished. It reported
   * zero once, because the settle loop stops when a pass produces no work and
   * a pass where everything failed produces none: the connection had died
   * half way through a large sync and the client said it was done.
   */
  it("exits non-zero when files are still failing", async () => {
    await fresh();
    const dir = await vaultDir("a");
    await cli(
      "init",
      "--dir",
      dir,
      "--server",
      server.wsUrl,
      "--token",
      server.token,
      "--device",
      "a",
      "--json",
    );
    await write(dir, "fine.md", "this one is ok\n");
    await write(dir, "locked.md", "this one cannot be read\n");
    await cli("sync", "--dir", dir);

    // A file that cannot be read is the ordinary version of this: a
    // permission, a file open exclusively by something else, a disk that
    // answered once and not twice.
    const { chmod } = await import("node:fs/promises");
    await write(dir, "locked.md", "changed, and now unreadable\n");
    await chmod(join(dir, "locked.md"), 0o000);
    try {
      const r = await cli("sync", "--dir", dir, "--json");
      expect(r.json()["retrying"], `report was ${r.stdout}`).toBe(1);
      expect(r.code, "a sync that could not read a file reported success").toBe(1);
    } finally {
      await chmod(join(dir, "locked.md"), 0o644);
    }
  }, 300_000);

  /**
   * C-D10 in the 0.3.0 review. `sync` and `rebase` return `exitCodeFor` and
   * `restore` returned 0 whatever the sync after it found. The note is on this
   * device either way; whether the vault is in the state the command claims is
   * the other half, and a cron job reading the exit code was told yes.
   */
  it("exits non-zero from a restore whose sync could not finish", async () => {
    await fresh();
    const dir = await vaultDir("a");
    await cli("init", server.setup, "--dir", dir, "--device", "a", "--json");
    await write(dir, "note.md", "the first version\n");
    expect((await cli("sync", "--dir", dir)).code).toBe(0);
    await write(dir, "note.md", "the second version\n");
    expect((await cli("sync", "--dir", dir)).code).toBe(0);

    const { chmod } = await import("node:fs/promises");
    await write(dir, "locked.md", "cannot be read\n");
    await chmod(join(dir, "locked.md"), 0o000);
    try {
      const r = await cli("restore", "note.md", "--dir", dir, "--json");
      // The restore itself worked, and says so.
      expect(r.json()["ok"], r.all).toBe(true);
      expect((r.json()["sync"] as Record<string, number>)["retrying"]).toBe(1);
      expect(r.code, "a restore over a vault that cannot sync reported success").toBe(1);
    } finally {
      await chmod(join(dir, "locked.md"), 0o644);
    }
  }, 300_000);

  it("still exits zero when there is simply nothing to do", async () => {
    await fresh();
    const dir = await vaultDir("a");
    await cli(
      "init",
      "--dir",
      dir,
      "--server",
      server.wsUrl,
      "--token",
      server.token,
      "--device",
      "a",
      "--json",
    );
    await write(dir, "note.md", "x\n");
    await cli("sync", "--dir", dir);
    const again = await cli("sync", "--dir", dir);
    expect(again.code).toBe(0);
  }, 300_000);
});

/**
 * A second device must work the moment it is paired.
 *
 * `init` wrote a config and never contacted the server, so the vault stayed
 * unclaimed until the first device happened to sync. A second device paired
 * with the printed string and syncing first was refused with "not authorised
 * for this vault": true, unhelpful, and the remedy is not in the message. It
 * looks exactly like a bad key.
 *
 * Nothing caught it because every test, and every demo, syncs the first device
 * before the second exists.
 */
describe("a vault is claimed when init says it is", () => {
  it("lets a second device sync before the first ever has", async () => {
    await fresh();
    const a = await vaultDir("a");
    const b = await vaultDir("b");

    const init = await cli(
      "init",
      "--dir",
      a,
      "--server",
      server.wsUrl,
      "--token",
      server.token,
      "--device",
      "a",
      "--json",
    );
    expect(init.code, init.all).toBe(0);
    const pairing = init.json()["recoveryKey"] as string;

    // Device a has still never synced. Device b is the first to try.
    const paired = await cli("pair", pairing, "--dir", b, "--device", "b", "--json");
    expect(paired.code, paired.all).toBe(0);

    const first = await cli("sync", "--dir", b, "--json");
    expect(first.code, first.all).toBe(0);
  }, 300_000);

  it("spends the first-run token during init, not later", async () => {
    await fresh();
    const a = await vaultDir("a");
    const init = await cli(
      "init",
      "--dir",
      a,
      "--server",
      server.wsUrl,
      "--token",
      server.token,
      "--device",
      "a",
      "--json",
    );
    expect(init.code, init.all).toBe(0);

    const config = JSON.parse(await readFile(join(a, ".basalt", "config.json"), "utf8")) as Record<
      string,
      unknown
    >;
    expect(config["bootstrap"], "the token is spent once the vault is claimed").toBeUndefined();
  }, 300_000);
});

/**
 * Adding a device: an invite from a device that has the vault, and the
 * recovery key only when there is no such device left.
 *
 * The invite is the ordinary path and it has to stay the ordinary path. The
 * recovery key is written down and offline, and requiring it to add a phone
 * would mean fetching it, typing it into the phone, and having it on two more
 * surfaces than it should ever be on. What an invite carries is the vault's
 * data key, which is what a device holds anyway, and the redemption registers
 * the new device's own row.
 */
describe("adding a device", () => {
  it("adds a device with an invite, which carries no root", async () => {
    await fresh();
    const { dir: a } = await startedWithKey();
    await write(a, "note.md", "from a\n");
    expect((await cli("sync", "--dir", a)).code).toBe(0);

    const issued = await cli("invite", "--dir", a, "--json");
    expect(issued.code, issued.all).toBe(0);
    const invite = issued.json()["invite"] as string;
    expect(invite).toMatch(/^basalt3i_/);
    expect(issued.json()["expiresAt"] as number).toBeGreaterThan(Date.now());

    const b = await vaultDir("b");
    const paired = await cli("pair", invite, "--dir", b, "--device", "b", "--json");
    expect(paired.code, paired.all).toBe(0);
    expect(paired.json()["deviceId"]).toMatch(/^[A-Za-z0-9_-]+$/);

    // What the new device holds: its own credential and the data key, and no
    // root. That is the whole point of an invite carrying the data key. With
    // the root here, this device could register itself again after a revoke.
    const config = JSON.parse(await read(b, ".basalt/config.json")) as Record<string, string>;
    expect(config["secret"], "an invite handed over the vault's root").toBeUndefined();
    expect(config["deviceId"]).toBe(paired.json()["deviceId"]);
    expect(config["deviceSecret"]).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(config["dataKey"]).toMatch(/^[A-Za-z0-9_-]+$/);

    // And it is a device: it syncs, and it appears in the list as its own row.
    expect((await cli("sync", "--dir", b)).code).toBe(0);
    expect(await read(b, "note.md")).toBe("from a\n");
    const listed = await cli("devices", "--dir", a, "--json");
    const devices = listed.json()["devices"] as Record<string, unknown>[];
    expect(devices.map((d) => d["name"]).sort()).toEqual(["a", "b"]);
  }, 120_000);

  it("spends an invite once, and says so the second time", async () => {
    await fresh();
    const { dir: a } = await startedWithKey();
    const invite = (await cli("invite", "--dir", a, "--json")).json()["invite"] as string;

    const b = await vaultDir("b");
    expect((await cli("pair", invite, "--dir", b, "--device", "b")).code).toBe(0);

    const c = await vaultDir("c");
    const again = await cli("pair", invite, "--dir", c, "--device", "c");
    expect(again.code).toBe(1);
    expect(again.all).toMatch(/not authorised/);
    // Nothing kept, so the next attempt with a fresh invite is the ordinary
    // path rather than an unlink first (C39).
    await expect(stat(join(c, ".basalt", "config.json"))).rejects.toMatchObject({ code: "ENOENT" });
    // And the vault gained one device, not two.
    const devices = (await cli("devices", "--dir", a, "--json")).json()["devices"] as unknown[];
    expect(devices).toHaveLength(2);
  }, 120_000);

  it("refuses a damaged invite before it reaches the server", async () => {
    await fresh();
    await startedWithKey();
    const b = await vaultDir("b");
    const given = await cli("pair", "basalt3i_notreallyaninvite", "--dir", b);
    expect(given.code).toBe(1);
    expect(given.all).toMatch(/this invite is damaged/);
    await expect(stat(join(b, ".basalt", "config.json"))).rejects.toMatchObject({ code: "ENOENT" });
  }, 60_000);

  it("has nothing to print for the recovery key, and says to use an invite", async () => {
    // No device holds the root, which is what makes revoking one mean
    // something. Somebody running this is usually trying to add a device, so
    // the refusal names the command that does that.
    await fresh();
    const { dir } = await startedWithKey();
    const asked = await cli("recovery-key", "--dir", dir);
    expect(asked.code).toBe(1);
    expect(asked.all).toMatch(/does not hold the vault's recovery key/);
    expect(asked.all).toMatch(/basalt invite/);
  }, 60_000);

  it("pairs with the recovery key, registers a row, and then forgets the key", async () => {
    await fresh();
    const { dir: a, recoveryKey } = await startedWithKey();
    await write(a, "note.md", "from a\n");
    expect((await cli("sync", "--dir", a)).code).toBe(0);

    const b = await vaultDir("b");
    const paired = await cli("pair", recoveryKey, "--dir", b, "--device", "b", "--json");
    expect(paired.code, paired.all).toBe(0);
    expect(paired.json()["deviceId"]).toMatch(/^[A-Za-z0-9_-]+$/);

    // The key is used once and dropped. This is the assertion the whole
    // feature rests on: with the root on disk, this device could re-derive
    // the vault's credential and register itself again, so revoking it would
    // stop nothing.
    const config = JSON.parse(await read(b, ".basalt/config.json")) as Record<string, string>;
    expect(config["secret"], "the root secret is still on the new device").toBeUndefined();
    expect(config["deviceId"]).toBe(paired.json()["deviceId"]);
    expect(config["deviceSecret"]).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(config["dataKey"]).toMatch(/^[A-Za-z0-9_-]+$/);

    expect((await cli("sync", "--dir", b)).code).toBe(0);
    expect(await read(b, "note.md")).toBe("from a\n");
  }, 60_000);

  it("reaches the server before it says paired (C39)", async () => {
    await fresh();
    const { recoveryKey } = await startedWithKey();
    const b = await vaultDir("b");
    await server.cleanup();
    const paired = await cli("pair", recoveryKey, "--dir", b, "--device", "b", "--timeout", "3000");
    expect(paired.code).toBe(1);
    expect(paired.all).not.toMatch(/Paired/);
  }, 60_000);

  it("refuses a recovery key the vault does not know", async () => {
    await fresh();
    const { recoveryKey } = await startedWithKey();
    // A well-formed key for another vault's root: the same address and vault
    // id, a different secret.
    const { parsePairing, formatPairing } = await import("../core/pairing.ts");
    const stranger = formatPairing({
      ...parsePairing(recoveryKey),
      secret: new Uint8Array(32).fill(9),
    });
    const b = await vaultDir("b");
    const paired = await cli("pair", stranger, "--dir", b, "--device", "b");
    expect(paired.code).toBe(1);
    expect(paired.all).toMatch(/not authorised/);
    // And nothing is left behind. A key the server does not know has to leave
    // the vault exactly as unpaired as it found it (C39), or the next attempt
    // is refused for being already paired and the person has to unlink first.
    await expect(stat(join(b, ".basalt", "config.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  }, 60_000);
});

/**
 * The device list, and revoking one.
 *
 * The point of per-device credentials, and the only place the honesty
 * requirement can be checked: revoking stops a device connecting and does not
 * un-read what it already read.
 */
describe("the device list", () => {
  it("lists every device with its id, name and last seen", async () => {
    await fresh();
    const { a, b } = await twoDevices();
    expect((await cli("sync", "--dir", a)).code).toBe(0);
    expect((await cli("sync", "--dir", b)).code).toBe(0);

    const listed = await cli("devices", "--dir", a, "--json");
    expect(listed.code, listed.all).toBe(0);
    const devices = listed.json()["devices"] as Record<string, unknown>[];
    expect(devices).toHaveLength(2);
    expect(devices.map((d) => d["name"]).sort()).toEqual(["a", "b"]);
    for (const d of devices) {
      expect(d["id"], "a device with no id").toMatch(/^[A-Za-z0-9_-]+$/);
      expect(d["createdAt"] as number).toBeGreaterThan(0);
      // Both have connected, so both have been seen. Zero would mean the
      // server never stamped one, which is a device that cannot be told from
      // one that has never been used.
      expect(d["lastSeen"] as number, `${String(d["name"])} was never seen`).toBeGreaterThan(0);
    }
    expect(listed.json()["thisDevice"]).toBe(devices.find((d) => d["name"] === "a")!["id"]);
    expect(listed.json()["maxDevices"]).toBe(8);
  }, 60_000);

  it("says, in the listing, that revoking does not un-read anything", async () => {
    // Not decoration. Somebody who reads "revoked" as "the vault is safe
    // again" skips the rotation, which is the one thing that actually helps
    // after a theft, and this feature is then worse than not having it.
    await fresh();
    const { a } = await twoDevices();
    const listed = await cli("devices", "--dir", a);
    expect(listed.stdout).toMatch(/does not un-read/);
    expect(listed.stdout).toMatch(/basalt rotate/);
  }, 60_000);

  it("stops a revoked device connecting, and says why in words to act on", async () => {
    await fresh();
    const { a, b } = await twoDevices();
    await write(a, "note.md", "one\n");
    expect((await cli("sync", "--dir", a)).code).toBe(0);
    expect((await cli("sync", "--dir", b)).code).toBe(0);

    const list = await cli("devices", "--dir", a, "--json");
    const bId = (list.json()["devices"] as Record<string, unknown>[]).find(
      (d) => d["name"] === "b",
    )!["id"] as string;

    const revoked = await cli("revoke", bId, "--dir", a);
    expect(revoked.code, revoked.all).toBe(0);
    expect(revoked.stdout).toMatch(/cannot connect again/);
    expect(revoked.stdout).toMatch(/still holds the vault's key/);

    const refused = await cli("sync", "--dir", b);
    expect(refused.code).toBe(1);
    expect(refused.all).toMatch(/not authorised/);

    // And the other device is untouched.
    await write(a, "after.md", "two\n");
    expect((await cli("sync", "--dir", a)).code, "revoking one disturbed another").toBe(0);
  }, 60_000);

  /**
   * Base64url's alphabet includes `-`, so an id can begin with one and be read
   * as an option. Ids made here no longer do, and `--` says "the next word is
   * a word" for the ones that arrive from anywhere else.
   */
  it("takes a device id that looks like an option, after --", async () => {
    await fresh();
    const { a } = await twoDevices();
    // `--` means every word after it is a word, options included, so the
    // options come first. That is what `--` means everywhere else too.
    const refused = await cli("revoke", "--dir", a, "--", "-not-a-real-id");
    expect(refused.code).toBe(1);
    expect(refused.all, refused.all).toMatch(/no device with id -not-a-real-id/);
    // And every id this client makes is safe without it.
    const listed = await cli("devices", "--dir", a, "--json");
    for (const d of listed.json()["devices"] as Record<string, unknown>[]) {
      expect(String(d["id"]).startsWith("-"), `${String(d["id"])} reads as an option`).toBe(false);
    }
  }, 60_000);

  it("refuses an id the vault does not have, and says the list is stale", async () => {
    await fresh();
    const { a } = await twoDevices();
    const missing = await cli("revoke", "no-such-device", "--dir", a);
    expect(missing.code).toBe(1);
    expect(missing.all).toMatch(/no device with id no-such-device/);
    expect(missing.all).toMatch(/basalt devices again/);
  }, 60_000);

  /**
   * Emptying the vault is the recovery key's, and only that one revocation is.
   *
   * A device revoking another device is the whole reason revocation exists
   * instead of rotation, and it stays a device's to do. The last row is the
   * exception, because it is the only revocation nothing on a device can undo:
   * what it leaves is a vault only the recovery key opens. It costs nothing in
   * the case it is aimed at, since a device stolen when it was the only one
   * wants a rotation as well and rotating already needs the key.
   */
  it("refuses to empty the vault from a device, and says whose job it is", async () => {
    await fresh();
    const { dir: a, recoveryKey } = await startedWithKey();
    const list = await cli("devices", "--dir", a, "--json");
    const only = (list.json()["devices"] as Record<string, unknown>[])[0]!["id"] as string;

    // Without the flag: told what it would cost and who can.
    const refused = await cli("revoke", only, "--dir", a);
    expect(refused.code).toBe(1);
    expect(refused.all).toMatch(/last device/);
    expect(refused.all).toMatch(/--recovery-key/);

    // With it and no key: refused before anything is sent, with the whole
    // command to run rather than a hint.
    const bare = await cli("revoke", only, "--dir", a, "--allow-last");
    expect(bare.code).toBe(1);
    expect(bare.all).toMatch(/--allow-last --recovery-key/);
    // Still there, and still syncing.
    expect((await cli("sync", "--dir", a)).code, (await cli("sync", "--dir", a)).all).toBe(0);

    // The recovery key still has to say the word: the confirmation is asked
    // of the credential that can undo the answer.
    const unsaid = await cli("revoke", only, "--dir", a, "--recovery-key", recoveryKey);
    expect(unsaid.code).toBe(1);
    expect(unsaid.all).toMatch(/--allow-last/);

    const done = await cli(
      "revoke",
      only,
      "--dir",
      a,
      "--allow-last",
      "--recovery-key",
      recoveryKey,
      "--json",
    );
    expect(done.code, done.all).toBe(0);
    // Not self: the recovery key is not a device, so there is no row of its
    // own for this to have been.
    expect(done.json()["self"]).toBe(false);
    // And the vault is now reachable only by the recovery key, which is what
    // the confirmation was about.
    expect((await cli("sync", "--dir", a)).all).toMatch(/not authorised/);
  }, 60_000);

  /**
   * An invite that has not been redeemed is visible beside the rows, and can
   * be cancelled.
   *
   * It was the one authority on a vault that nothing could see: a string
   * issued on a stolen laptop stayed invisible until somebody redeemed it, for
   * up to an hour. What the list must never carry is anything that would let a
   * reader redeem one, which the identifier alone is not: redeeming also takes
   * the invite key, which never reaches the server and lives only in the
   * string somebody is holding.
   */
  it("shows outstanding invites beside the devices, and cancels one", async () => {
    await fresh();
    const { a } = await twoDevices();

    const empty = await cli("devices", "--dir", a);
    expect(empty.stdout).toMatch(/No outstanding invites/);

    const issued = await cli("invite", "--dir", a, "--json");
    expect(issued.code, issued.all).toBe(0);
    const string = issued.json()["invite"] as string;

    const listed = await cli("devices", "--dir", a, "--json");
    const invites = listed.json()["invites"] as Record<string, unknown>[];
    expect(invites).toHaveLength(1);
    expect(invites[0]!["expiresAt"]).toBe(issued.json()["expiresAt"]);
    // The identifier and the expiry, and nothing that redeems: the invite
    // string itself is never on the server, so it cannot come back from it.
    expect(Object.keys(invites[0]!).sort()).toEqual(["expiresAt", "id"]);
    expect(listed.stdout).not.toContain(string);

    const shown = await cli("devices", "--dir", a);
    expect(shown.stdout).toMatch(/1 outstanding invite/);
    expect(shown.stdout).toMatch(/basalt uninvite ID/);

    // Cancelled, and the string stops working, which is the point of seeing
    // it in the first place.
    const id = invites[0]!["id"] as string;
    const cancelled = await cli("uninvite", id, "--dir", a);
    expect(cancelled.code, cancelled.all).toBe(0);
    expect(cancelled.stdout).toMatch(/no longer adds a device/);

    const c = await vaultDir("c");
    const refused = await cli("pair", string, "--dir", c, "--device", "c");
    expect(refused.code).toBe(1);
    expect(refused.all).toMatch(/not authorised/);
    expect((await cli("devices", "--dir", a, "--json")).json()["invites"]).toHaveLength(0);
    expect((await cli("devices", "--dir", a, "--json")).json()["devices"]).toHaveLength(2);

    // And cancelling it twice says there is nothing to cancel, in one answer
    // that an unknown identifier also gets: telling them apart would tell
    // somebody guessing that they had found a real one.
    const again = await cli("uninvite", id, "--dir", a);
    expect(again.code).toBe(1);
    expect(again.all).toMatch(/no outstanding invite/);
    expect(again.all).toMatch(/basalt devices/);
  }, 60_000);

  /**
   * A row nothing has ever connected under is flagged, because it is the one
   * that can be reclaimed.
   *
   * A redemption registers the row before the device redeeming it saves
   * anything, so a crash in that window leaves a row on the server rather than
   * a device that believes it is paired. That ordering is the right way round
   * and does not change; what it costs is a row against the cap, and the list
   * has to say which rows those are or the advice to revoke one is advice
   * nobody can follow.
   */
  it("flags a row nothing has ever connected under", async () => {
    await fresh();
    const { a } = await twoDevices();

    // A pairing that reached the server and then crashed: the invite is
    // redeemed, the row is written, and nothing ever connects under it.
    const issued = await cli("invite", "--dir", a, "--json");
    expect(issued.code, issued.all).toBe(0);
    await redeemInvite(parseInvite(issued.json()["invite"] as string), "the-one-that-crashed");

    const listed = await cli("devices", "--dir", a);
    expect(listed.code, listed.all).toBe(0);
    expect(listed.stdout).toMatch(/never connected/);
    expect(listed.stdout).toMatch(/1 of them has never connected/);
    expect(listed.stdout).toMatch(/holds one of the 8 slots/);

    // The two working devices are not flagged, which is the half that makes
    // the flag worth reading.
    const rows = (await cli("devices", "--dir", a, "--json")).json()["devices"] as Record<
      string,
      unknown
    >[];
    expect(rows.filter((d) => d["lastSeen"] === 0)).toHaveLength(1);
    expect(rows.filter((d) => d["lastSeen"] !== 0)).toHaveLength(2);
  }, 60_000);

  it("refuses --recovery-key where it would have been ignored", async () => {
    // A flag that is quietly ignored is how somebody comes to believe they ran
    // a command as the recovery key when they ran it as this device.
    await fresh();
    const { dir: a, recoveryKey } = await startedWithKey();
    const refused = await cli("sync", "--dir", a, "--recovery-key", recoveryKey);
    // 1 rather than 2, the same as the refusal of a stray positional: the
    // argument parsed, and it is the command that will not take it.
    expect(refused.code).toBe(1);
    expect(refused.all).toMatch(/does not take --recovery-key/);
    expect(refused.all).toMatch(/basalt rotate takes the key as its argument/);
  }, 60_000);

  /**
   * The way out of a vault whose eight rows are all pairings that crashed.
   *
   * A redemption saves nothing locally until the server has answered, so a
   * crash in that window strands a server row rather than a device: the right
   * way round, and it means the rows that fill the cap are the ones nothing
   * ever connected under. Filling it refuses every registration, so the
   * recovery key has to be able to read the list and prune it, or the only
   * way back into such a vault would be editing the server's database.
   */
  it("lists and revokes with the recovery key, for a vault with no device to ask", async () => {
    await fresh();
    const { a, b, recoveryKey } = await twoDevices();
    const mine = (await cli("devices", "--dir", b, "--json")).json()["thisDevice"] as string;

    const listed = await cli("devices", "--recovery-key", recoveryKey, "--dir", a, "--json");
    expect(listed.code, listed.all).toBe(0);
    const rows = listed.json()["devices"] as Record<string, unknown>[];
    expect(rows.map((d) => d["name"]).sort()).toEqual(["a", "b"]);
    // No "(this device)" over the recovery key, because it is not one and a
    // guess would put the mark against somebody else's row.
    expect(listed.json()["thisDevice"]).toBeUndefined();

    const gone = await cli("revoke", mine, "--recovery-key", recoveryKey, "--dir", a, "--json");
    expect(gone.code, gone.all).toBe(0);
    expect((await cli("sync", "--dir", b)).all).toMatch(/not authorised/);
    // The other device is untouched, which is the guarantee a revocation
    // makes whoever asked for it.
    expect((await cli("sync", "--dir", a)).code).toBe(0);
  }, 60_000);
});

/**
 * review finding I5, and the half of it protocol 4 changed.
 *
 * A vault's content is sealed under a data key the root only wraps, so the root
 * can be replaced without the history going with it. What is new is that no
 * device row is touched either, so every device keeps syncing across a
 * rotation: under protocol 3 the vault's hash was the credential every device
 * held, and a rotation evicted the lot.
 */
describe("rotating the secret (I5)", () => {
  it("keeps the history and every device, and retires the old key", async () => {
    await fresh();
    const { a, b, recoveryKey: oldKey } = await twoDevices();
    await write(a, "kept.md", "written before the rotation\n");
    expect((await cli("sync", "--dir", a)).code).toBe(0);
    expect((await cli("sync", "--dir", b)).code).toBe(0);

    const rotated = await cli("rotate", oldKey, "--dir", a);
    expect(rotated.code, rotated.all).toBe(0);
    expect(rotated.stdout).toMatch(/new recovery key/);
    const newKey = rotated.out.find((l) => l.trim().startsWith("basalt3_"))!.trim();
    expect(newKey).not.toBe(oldKey);

    // The expensive half of what per-device credentials removed: both devices
    // go on syncing, with no pairing and no interruption.
    await write(b, "after.md", "after\n");
    expect((await cli("sync", "--dir", b)).code, "a rotation evicted a device").toBe(0);
    expect((await cli("sync", "--dir", a)).code).toBe(0);
    expect(await read(a, "after.md")).toBe("after\n");

    // The old string opens nothing, and the new one adds a device whose
    // history reads back: the data key did not change.
    const c = await vaultDir("c");
    expect((await cli("pair", oldKey, "--dir", c, "--device", "c")).all).toMatch(/not authorised/);
    expect((await cli("pair", newKey, "--dir", c, "--device", "c")).code).toBe(0);
    expect((await cli("sync", "--dir", c)).code).toBe(0);
    expect(await read(c, "kept.md")).toBe("written before the rotation\n");
    const history = await cli("history", "kept.md", "--dir", c, "--json");
    expect((history.json()["versions"] as unknown[]).length).toBe(1);
  }, 90_000);

  it("prints the new key before it sends the request", async () => {
    // There is nowhere on a device to stage a root any more: not holding one
    // is the point. So the durable copy is the one on paper, and it has to be
    // there before the server can possibly have committed.
    await fresh();
    const { dir: a, recoveryKey } = await startedWithKey();
    const rotated = await cli("rotate", recoveryKey, "--dir", a);
    expect(rotated.stderr).toMatch(/Write it down before pressing on/);
    expect(rotated.err.some((l) => l.trim().startsWith("basalt3_"))).toBe(true);
  }, 60_000);

  it("refuses a recovery key for another vault rather than rotating this one", async () => {
    await fresh();
    const { dir: a, recoveryKey } = await startedWithKey();
    const { parsePairing, formatPairing } = await import("../core/pairing.ts");
    const elsewhere = formatPairing({ ...parsePairing(recoveryKey), vaultId: "another" });
    const refused = await cli("rotate", elsewhere, "--dir", a);
    expect(refused.code).toBe(1);
    expect(refused.all).toMatch(/is paired with/);
  }, 60_000);

  it("needs the recovery key, because no device holds one", async () => {
    await fresh();
    const { dir: a } = await startedWithKey();
    const bare = await cli("rotate", "--dir", a);
    expect(bare.code).toBe(1);
    expect(bare.all).toMatch(/needs the vault's current recovery key/);
  }, 60_000);

  /**
   * Every claim carries a data key, so there is no such thing as a vault that
   * cannot be rotated, and no connection the server has to refuse.
   *
   * It used to be conditional on this device still holding the bootstrap
   * token: the first device offered a data key and every device after it
   * offered a claim with none. That left a vault that could be bound without
   * one, whose content was then sealed under the root itself: unrotatable,
   * and readable only by a device that guessed the same schedule (C40).
   */
  it("offers a data key with every claim, from the first device and the second", async () => {
    await fresh();
    const { dir: a, recoveryKey } = await startedWithKey();
    await write(a, "note.md", "one\n");
    expect((await cli("sync", "--dir", a)).code).toBe(0);

    const b = await vaultDir("b");
    expect((await cli("pair", recoveryKey, "--dir", b, "--device", "b")).code).toBe(0);
    expect((await cli("sync", "--dir", b)).code).toBe(0);
    expect(await read(b, "note.md")).toBe("one\n");

    // And the vault can be rotated, which is only true of a vault with a
    // data key.
    expect((await cli("rotate", recoveryKey, "--dir", a)).code).toBe(0);
  }, 60_000);
});

/**
 * R2. A folder one device syncs and another is told to ignore is an ordinary
 * arrangement: the laptop keeps `Drafts`, the server-side client does not
 * want it. The refusal used to be filed as a permanent skip, and a skip
 * exits 1, so from the first pass onwards every sync of that vault failed
 * for ever. The path is still refused, still counted and still printed; what
 * changed is that obeying the configuration is not a failure.
 */
describe("a folder this device ignores and another device syncs (R2)", () => {
  it("counts it as ignored, keeps it out of the exit code, and stays that way", async () => {
    await fresh();
    const { a, b } = await twoDevices();
    await write(a, "Drafts/plan.md", "not for the other one\n");
    await write(a, "keep.md", "for everybody\n");
    expect((await cli("sync", "--dir", a)).code).toBe(0);

    for (const pass of [1, 2, 3]) {
      const r = await cli("sync", "--dir", b, "--ignore", "Drafts", "--json");
      expect(r.code, `pass ${pass}: ${r.all}`).toBe(0);
      const report = r.json();
      expect(report["ignored"], `pass ${pass}`).toBeGreaterThan(0);
      expect(report["skipped"], `pass ${pass}`).toBe(0);
      expect(report["retrying"], `pass ${pass}`).toBe(0);
    }

    // Refused, not written: the ignore list still means what it says.
    await expect(stat(join(b, "Drafts", "plan.md"))).rejects.toThrow(/ENOENT/);
    // And the rest of the vault syncs, which is the other half of it.
    expect(await read(b, "keep.md")).toBe("for everybody\n");

    // Printed rather than swallowed. A count that disappears is how somebody
    // loses track of a folder they stopped syncing years ago.
    const human = await cli("sync", "--dir", b, "--ignore", "Drafts");
    expect(human.code, human.all).toBe(0);
    expect(human.stdout).toMatch(/ignored here, and synced by another device/);
  }, 300_000);

  /**
   * N4. An ignored path was left on the inbound work list for ever, so
   * `basalt status` said "N files with work outstanding" about a folder
   * whose owner had decided it would never arrive. Rule 7: the ignored
   * counter is where that belongs, and nothing is outstanding.
   */
  it("does not leave an ignored path on the work list (N4)", async () => {
    await fresh();
    const { a, b } = await twoDevices();
    await write(a, "Drafts/plan.md", "not for the other one\n");
    await write(a, "keep.md", "for everybody\n");
    expect((await cli("sync", "--dir", a)).code).toBe(0);
    expect((await cli("sync", "--dir", b, "--ignore", "Drafts", "--json")).code).toBe(0);

    const s = await cli("status", "--dir", b, "--ignore", "Drafts", "--json");
    expect(s.code, s.all).toBe(0);
    expect(s.json()["pending"], s.all).toBe(0);
    const human = await cli("status", "--dir", b, "--ignore", "Drafts");
    expect(human.stdout, human.all).not.toMatch(/work outstanding/);
  }, 300_000);

  it("still fails for a path that cannot work here, ignore list or not (R2)", async () => {
    await fresh();
    const { a, b } = await twoDevices();
    // `notes` is a folder on a and a file on b: nobody can apply that, and it
    // is nothing the person configured.
    await write(a, "notes/inside.md", "in the folder\n");
    expect((await cli("sync", "--dir", a)).code).toBe(0);
    await writeFile(join(b, "notes"), "a file\n");

    const r = await cli("sync", "--dir", b, "--ignore", "Drafts", "--json");
    expect(r.code, r.all).toBe(1);
    expect(r.json()["ignored"]).toBe(0);
  }, 300_000);
});

/**
 * I11, I14, I15, I24 and review finding C33: the smaller CLI contracts.
 */
describe("what the CLI says about itself and the vault", () => {
  it("prints both cursors on their own lines, and the ignore list (I11, I14)", async () => {
    await fresh();
    const { a } = await twoDevices();
    await write(a, "note.md", "x\n");
    await cli("sync", "--dir", a);
    const r = await cli("status", "--dir", a, "--ignore", "Drafts", "--ignore", "scratch");
    expect(r.code, r.all).toBe(0);
    expect(r.out).toContainEqual(expect.stringMatching(/^local cursor\s+1$/));
    expect(r.out).toContainEqual(expect.stringMatching(/^server cursor\s+1$/));
    expect(r.out).toContainEqual(
      expect.stringMatching(/^ignore\s+Drafts, scratch \(this device only\)$/),
    );
    const plain = await cli("status", "--dir", a, "--json");
    expect(plain.json()["ignore"]).toEqual([]);
    const bare = await cli("status", "--dir", a);
    expect(bare.out).toContainEqual(expect.stringMatching(/^ignore\s+nothing beyond the dot rule/));
  });

  it("gives a default device name a tail, so two laptops with one hostname differ (I15)", async () => {
    await fresh();
    const a = await vaultDir("a");
    const init = await cli("init", server.setup, "--dir", a, "--json");
    expect(init.code, init.all).toBe(0);
    const b = await vaultDir("b");
    const paired = await cli("pair", init.json()["recoveryKey"] as string, "--dir", b, "--json");
    expect(paired.code, paired.all).toBe(0);
    const nameA = init.json()["device"] as string;
    const nameB = paired.json()["device"] as string;
    const { hostname } = await import("node:os");
    const host = hostname().split(".")[0] || "device";
    expect(nameA).toMatch(
      new RegExp(`^${host.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-[0-9a-f]{4}$`),
    );
    expect(nameB).toMatch(/-[0-9a-f]{4}$/);
    expect(nameA).not.toBe(nameB);
    // A name that was typed is used as typed.
    const c = await vaultDir("c");
    const typed = await cli(
      "pair",
      init.json()["recoveryKey"] as string,
      "--dir",
      c,
      "--device",
      "exactly",
      "--json",
    );
    expect(typed.json()["device"]).toBe("exactly");
  });

  it("prints its version (I24)", async () => {
    const r = await cli("--version");
    expect(r.code).toBe(0);
    expect(r.out).toEqual(["development"]);
    const j = await cli("--version", "--json");
    expect(j.json()["version"]).toBe("development");
  });

  it("exits non-zero for a report with only blocked paths (C33)", async () => {
    const { exitCodeFor } = await import("./cli.ts");
    const clean = {
      uploaded: 0,
      downloaded: 0,
      merged: 0,
      conflicted: 0,
      deletedLocally: 0,
      deletedRemotely: 0,
      restored: 0,
      foldersCreated: 0,
      unchanged: 3,
      waiting: 0,
      retrying: 0,
      skipped: 0,
      skippedPaths: [],
      ignored: 0,
      blocked: 0,
      inTheWay: [],
      needsAttention: [],
      chunksSent: 0,
      bytesSent: 0,
    };
    expect(exitCodeFor(clean)).toBe(0);
    expect(exitCodeFor({ ...clean, uploaded: 2, waiting: 1 })).toBe(0);
    expect(exitCodeFor({ ...clean, blocked: 1, inTheWay: [{ path: "a/b", blockedBy: "a" }] })).toBe(
      1,
    );
    expect(exitCodeFor({ ...clean, skipped: 1 })).toBe(1);
    expect(exitCodeFor({ ...clean, retrying: 1 })).toBe(1);
    // A path this device is set to ignore is the configuration working, and
    // a run is not a failure for having obeyed it (R2).
    expect(exitCodeFor({ ...clean, ignored: 4 })).toBe(0);
  });

  it("exits non-zero when a path is blocked by a name that is a file here and a folder elsewhere (C33)", async () => {
    await fresh();
    const { a, b } = await twoDevices();
    // A folder called `notes` on a, a file called `notes` on b.
    await write(a, "notes/inside.md", "in the folder\n");
    expect((await cli("sync", "--dir", a)).code).toBe(0);
    await writeFile(join(b, "notes"), "a file\n");
    const r = await cli("sync", "--dir", b, "--json");
    const report = r.json();
    expect((report["blocked"] as number) + (report["skipped"] as number), r.all).toBeGreaterThan(0);
    expect(r.code, "a sync that left a path unwritten exited zero").toBe(1);
  });
});

/**
 * review finding I10. A server restored from an older backup is behind a device
 * that applied what it lost. The refusal is right, and this is the one safe
 * way past it: forget what this device believed was synced and rejoin from
 * the server's cursor, sending what only this device holds as new versions.
 */
describe("rebasing onto a server that lost history (I10)", () => {
  it("refuses without --backup-taken, then replays local-only content as new versions", async () => {
    await fresh();
    const { a, b } = await twoDevices();
    await write(a, "first.md", "first\n");
    expect((await cli("sync", "--dir", a)).code).toBe(0);

    // The operator's backup is taken here, before the second note.
    const backup = await vaultDir("backup");
    const { cp } = await import("node:fs/promises");
    await server.whileStopped(async () => {
      await cp(server.dataDir, backup, { recursive: true });
    });
    await write(a, "second.md", "second\n");
    expect((await cli("sync", "--dir", a)).code).toBe(0);
    const status = await cli("status", "--dir", a, "--json");
    const localCursor = status.json()["cursor"] as number;

    // The server is restored from that backup, so it has forgotten second.md.
    await server.whileStopped(async () => {
      await rm(server.dataDir, { recursive: true, force: true });
      await cp(backup, server.dataDir, { recursive: true });
    });
    const refused = await cli("sync", "--dir", a);
    expect(refused.code).toBe(1);
    expect(refused.all).toMatch(/cursor|ahead|behind/);
    // The refusal is the server's, and the server has never heard of the
    // command that fixes it. It used to stop at the diagnosis, so the only
    // place the way out existed was docs/server.md. Error strings are UI.
    expect(refused.all, "the refusal named no recovery").toMatch(/basalt rebase --backup-taken/);

    const withoutFlag = await cli("rebase", "--dir", a);
    expect(withoutFlag.code).toBe(1);
    expect(withoutFlag.all).toMatch(/--backup-taken/);
    expect(withoutFlag.out).toContainEqual(
      expect.stringMatching(new RegExp(`^local cursor\\s+${localCursor}$`)),
    );
    expect(withoutFlag.out).toContainEqual(expect.stringMatching(/^server cursor\s+\d+$/));
    // Nothing was touched.
    expect((await cli("sync", "--dir", a)).code).toBe(1);

    const rebased = await cli("rebase", "--backup-taken", "--dir", a);
    expect(rebased.code, rebased.all).toBe(0);
    expect(rebased.stdout).toMatch(/uploaded/);
    expect(rebased.stdout).toMatch(/Nothing was deleted/);
    // Both notes are on the server again, as a plain sync on b shows.
    expect((await cli("sync", "--dir", b)).code).toBe(0);
    expect(await read(b, "first.md")).toBe("first\n");
    expect(await read(b, "second.md")).toBe("second\n");
    // And a is an ordinary device again.
    expect((await cli("sync", "--dir", a)).code).toBe(0);
  }, 120_000);
});

/**
 * C-D2 in the 0.3.0 review. `NodeVault` has a case probe: it writes a name into
 * the state folder and looks for it under the other spelling, so `canonical`
 * answers for this disk rather than for the worst one. Nothing in the CLI ever
 * called it. Until it runs the answer is "yes, this disk folds case", which is
 * the safe default and the wrong answer on Linux: two notes that differ only in
 * case are then one file to the alias check, both are refused, and every sync
 * exits 1 over a pair the disk is perfectly happy with.
 */
describe("what the disk says about case (C-D2)", () => {
  it("is asked, and is what the vault then goes by", async () => {
    await fresh();
    const { a } = await twoDevices();

    // What this disk actually does, found the way the vault has to find it.
    await writeFile(join(a, "probe-case.md"), "x");
    const folds = await stat(join(a, "PROBE-CASE.md")).then(
      () => true,
      () => false,
    );
    await rm(join(a, "probe-case.md"));

    const probed: string[] = [];
    let asked = 0;
    const real = NodeVault.prototype.probeCase;
    NodeVault.prototype.probeCase = function (this: NodeVault): Promise<void> {
      probed.push("asked");
      return real.call(this);
    };
    let vault: NodeVault;
    try {
      await write(a, "note.md", "one\n");
      // Two files on a case-sensitive disk, one file on a folding one. Either
      // way the sync has to agree with the disk about which it is.
      if (!folds) await write(a, "NOTE.md", "two\n");
      const synced = await cli("sync", "--dir", a);
      expect(synced.code, synced.all).toBe(0);
      expect(synced.all).not.toMatch(/in the way|blocked/i);
      // Counted before this test asks for itself, or the spy would be
      // satisfied by the line below it.
      asked = probed.length;
      vault = new NodeVault(a, {});
      await vault.probeCase();
    } finally {
      NodeVault.prototype.probeCase = real;
    }

    expect(
      asked,
      "nothing asked the disk, so canonical folds case whatever the disk does",
    ).toBeGreaterThan(0);
    // And the probe agrees with the disk it just probed.
    expect(vault.canonical("NOTE.md")).toBe(folds ? "note.md" : "NOTE.md");
  }, 240_000);
});

/**
 * C-D15 in the 0.3.0 review. `parseArgs` collects everything that is not an
 * option into `rest`, and the commands that take no positional never looked.
 * `basalt sync ~/notes` synced the current directory and reported that it had
 * synced, which is a wrong vault reported as a right one.
 */
describe("an argument the command does not take", () => {
  it("is refused, rather than ignored", async () => {
    const dir = await vaultDir("a");
    const r = await cli("sync", "/somewhere/else", "--dir", dir);
    expect(r.code).toBe(1);
    expect(r.all).toMatch(/takes no arguments/);
    // And says how the vault is actually chosen, because that is the mistake.
    expect(r.all).toMatch(/--dir/);
  });

  it("is refused past the one a command does take", async () => {
    const dir = await vaultDir("a");
    const r = await cli("restore", "note.md", "also-note.md", "--dir", dir);
    expect(r.code).toBe(1);
    expect(r.all).toMatch(/takes one argument/);
  });

  it("leaves the commands that take one alone", async () => {
    // Not paired, so this gets as far as the argument check and no further:
    // what matters is which complaint comes back.
    const dir = await vaultDir("a");
    const r = await cli("history", "note.md", "--dir", dir);
    expect(r.all).toMatch(/not paired/);
  });
});

/**
 * What the CLI actually prints when something needs a person, which nothing
 * asserted.
 *
 * Two things are being pinned here and they arrived together. The first is the
 * shape: one "need attention" list with a reason against each name, where
 * there used to be three counters and two lists under them. The second is the
 * content of the reason for the one refusal that had no test at all, two
 * spellings that normalize to one name, whose sentence has to spell both names
 * out because they are identical on a terminal. The whole reason `spellOut`
 * exists is that "rename one of them" printed the same string twice and nobody
 * could act on it.
 *
 * The two blocked kinds still ask for different things and still say so, which
 * is what the one list must not lose: two spellings of one name are both on
 * this device so the rename is here, while a file here and a folder elsewhere
 * waits on whichever device meant the other thing. Rule 7 asked for one list,
 * not for one sentence.
 *
 * A unit test on the renderer rather than a real sync, for the reason
 * `vault-spelling.test.ts` gives about the mechanism underneath it: a disk that
 * keeps NFC and NFD apart cannot be mounted on the machine this is written on,
 * so an end-to-end version would self-skip locally and a green run that is not
 * evidence is worse than no run (R9). The engine's side, including that it
 * builds these sentences at all, is covered over a real server in
 * `core/engine.test.ts`; this is the half that turns a report into lines, and
 * it is exported for the same reason `exitCodeFor` is.
 */
describe("what needs attention looks like on the way out", () => {
  const clean: SyncReport = {
    uploaded: 0,
    downloaded: 0,
    merged: 0,
    conflicted: 0,
    deletedLocally: 0,
    deletedRemotely: 0,
    restored: 0,
    foldersCreated: 0,
    unchanged: 3,
    waiting: 0,
    retrying: 0,
    skipped: 0,
    skippedPaths: [],
    ignored: 0,
    blocked: 0,
    inTheWay: [],
    needsAttention: [],
    chunksSent: 0,
    bytesSent: 0,
  };

  /** What `renderReport` writes, given a report. */
  const printed = (r: SyncReport, json = false): string => {
    const out: string[] = [];
    const err: string[] = [];
    const io: Console = { out: (l) => out.push(l), err: (l) => err.push(l) };
    renderReport(r, { json } as Parameters<typeof renderReport>[1], io, 7);
    return out.join("\n") + "\n" + err.join("\n");
  };

  /** The sentences the engine builds, as it builds them. */
  const CLASH =
    '"cafe\\u{301}.md" and "caf\\u{e9}.md" are one name here, and only one of them can sync. ' +
    "Rename one of them here; nothing syncs under that name until you do.";
  const FOLDER =
    '"notes" is a file here and a folder on another device. ' +
    "Rename one of them, on whichever device meant the other thing.";

  it("spells both names out, and says the rename is here", () => {
    const text = printed({
      ...clean,
      blocked: 1,
      inTheWay: [{ path: "café.md", blockedBy: "café.md", why: CLASH }],
      needsAttention: [{ path: "café.md", why: CLASH }],
    });
    expect(text).toMatch(/1 {2}need attention/);
    // The two names are distinguishable on a terminal, which is the property.
    expect(text).toContain("cafe\\u{301}.md");
    expect(text).toContain("caf\\u{e9}.md");
    expect(text).toMatch(/Rename one of them here/);
    // And not the other refusal's advice, which would send somebody to the
    // wrong device.
    expect(text).not.toMatch(/whichever device meant the other thing/);
  });

  it("says the other thing for a file here and a folder elsewhere", () => {
    const text = printed({
      ...clean,
      blocked: 1,
      inTheWay: [{ path: "notes/a.md", blockedBy: "notes" }],
      needsAttention: [{ path: "notes/a.md", why: FOLDER }],
    });
    expect(text).toMatch(/notes\/a\.md: "notes" is a file here and a folder on another device\./);
    expect(text).toMatch(/whichever device meant the other thing/);
    expect(text).not.toMatch(/Rename one of them here/);
  });

  it("keeps the two reasons apart in one list", () => {
    // One list, and still two answers. Collapsing the sentences as well as the
    // counters would tell somebody to do the wrong thing to half of it.
    const text = printed({
      ...clean,
      blocked: 2,
      inTheWay: [
        { path: "notes/a.md", blockedBy: "notes" },
        { path: "café.md", blockedBy: "café.md", why: CLASH },
      ],
      needsAttention: [
        { path: "notes/a.md", why: FOLDER },
        { path: "café.md", why: CLASH },
      ],
    });
    expect(text).toMatch(/2 {2}need attention/);
    expect(text).toMatch(/Rename one of them here/);
    expect(text).toMatch(/whichever device meant the other thing/);
  });

  it("puts every path sharing one reason on one line", () => {
    // One file where a folder belongs blocks a subtree, and four hundred
    // copies of one sentence is a wall rather than a message.
    const text = printed({
      ...clean,
      blocked: 3,
      needsAttention: [
        { path: "notes/b.md", why: FOLDER },
        { path: "notes/a.md", why: FOLDER },
        { path: "notes/c.md", why: FOLDER },
      ],
    });
    expect(text).toContain("notes/a.md, notes/b.md, notes/c.md: ");
    expect(text.match(/is a file here and a folder/g)).toHaveLength(1);
  });

  it("says how many are not shown, because the list is bounded and the count is not", () => {
    const text = printed({
      ...clean,
      blocked: 40,
      needsAttention: [{ path: "notes/a.md", why: FOLDER }],
    });
    expect(text).toMatch(/40 {2}need attention/);
    expect(text).toMatch(/and 39 more\./);
  });

  it("keeps ignored out of it, and still prints it", () => {
    // R2. A path this device is set to ignore is the configuration working, so
    // it is not something to attend to and not in the exit code, and it still
    // has to be visible or somebody loses track of a folder they stopped
    // syncing years ago.
    const text = printed({ ...clean, ignored: 4 });
    expect(text).toMatch(/4 {2}ignored here, and synced by another device/);
    expect(text).not.toMatch(/need attention/);
    expect(exitCodeFor({ ...clean, ignored: 4 })).toBe(0);
  });

  it("says nothing about names when nothing needs a person", () => {
    const text = printed({ ...clean, uploaded: 2 });
    expect(text).not.toMatch(/need attention|Rename/i);
  });

  it("puts the whole report in --json, the reasons included", () => {
    const text = printed(
      { ...clean, blocked: 1, needsAttention: [{ path: "café.md", why: CLASH }] },
      true,
    );
    const parsed = JSON.parse(text.trim()) as { needsAttention: { why: string }[] };
    expect(parsed.needsAttention[0]!.why).toBe(CLASH);
  });
});
