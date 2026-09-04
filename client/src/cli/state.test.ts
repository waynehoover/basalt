/**
 * The vault's state directory under contention and under failure.
 *
 * C12 and review finding C13. Two processes on one vault each loaded the index,
 * decided from it, and wrote notes, config and index over each other from
 * state the other never saw; and an unlink removed the config before the
 * index, so a failure in between left a vault that read as unpaired while an
 * index from the old pairing waited to be loaded by the next one.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { cleanupBinary, removeTree, serverBinary, TestServer, until } from "../core/test-server.ts";
import { run, type Console } from "./cli.ts";
import { configPath, indexPath, loadConfig, saveConfig } from "./config.ts";
import { alive, lockPath, lockVault } from "./lock.ts";

/**
 * `saveConfig`, failing when a test says so. The CLI imports the same module,
 * so a failure injected here is a failure it meets exactly where it would.
 */
let failSavesAfter = Infinity;
let saves = 0;
vi.mock("./config.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./config.ts")>();
  return {
    ...actual,
    saveConfig: async (vault: string, config: Parameters<typeof actual.saveConfig>[1]) => {
      saves++;
      if (saves > failSavesAfter) throw new Error("the disk is full, as it were");
      return actual.saveConfig(vault, config);
    },
  };
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

beforeAll(async () => {
  await serverBinary();
}, 180_000);
afterAll(async () => {
  await cleanupBinary();
});

let server: TestServer | undefined;
const dirs: string[] = [];
const children: ChildProcess[] = [];

afterEach(async () => {
  failSavesAfter = Infinity;
  saves = 0;
  for (const c of children.splice(0)) {
    // A child killed by a signal has no exit code, only a signal.
    if (c.exitCode === null && c.signalCode === null) {
      const ended = new Promise((r) => c.once("exit", r));
      c.kill("SIGKILL");
      await ended;
    }
  }
  while (dirs.length) await removeTree(dirs.pop()!);
  if (server) await server.cleanup();
  server = undefined;
});

async function vaultDir(name: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `basalt-state-${name}-`));
  dirs.push(dir);
  return dir;
}

async function paired(name = "a"): Promise<string> {
  return (await pairedWithKey(name)).dir;
}

/**
 * The same, and the recovery key `init` printed.
 *
 * Kept by the caller because nothing reprints it: a paired device holds its
 * own credential and not the vault's root, which is what makes revoking one
 * device mean anything.
 */
async function pairedWithKey(name = "a"): Promise<{ dir: string; recoveryKey: string }> {
  server = new TestServer();
  await server.start();
  const dir = await vaultDir(name);
  const init = await cli("init", server.setup, "--dir", dir, "--device", name, "--json");
  expect(init.code, init.all).toBe(0);
  return { dir, recoveryKey: init.json()["recoveryKey"] as string };
}

/** The CLI as a separate process, which is the only way two of them contend. */
function basalt(...argv: string[]): ChildProcess & { stderrText: () => string } {
  const child = spawn("bun", ["src/cli/bin.ts", ...argv], {
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
  }) as ChildProcess & { stderrText: () => string };
  const err: string[] = [];
  child.stderr!.on("data", (b: Buffer) => err.push(b.toString()));
  child.stdout!.on("data", () => {});
  child.stderrText = () => err.join("");
  children.push(child);
  return child;
}

const exited = (child: ChildProcess) =>
  new Promise<number>((r) => {
    if (child.exitCode !== null) r(child.exitCode);
    else child.once("exit", (code) => r(code ?? -1));
  });

describe("the vault lock (C12)", () => {
  it("refuses a second holder and names the first", async () => {
    const dir = await vaultDir("lock");
    const release = await lockVault(dir, "basalt sync");
    await expect(lockVault(dir, "basalt restore")).rejects.toThrow(
      new RegExp(`basalt sync \\(pid ${process.pid} on `),
    );
    await release();
    // Released, so the next holder gets it, and the file is gone in between.
    await expect(stat(lockPath(dir))).rejects.toThrow();
    await (
      await lockVault(dir, "basalt restore")
    )();
  });

  it("takes over a lock whose holder on this host is dead", async () => {
    const dir = await vaultDir("stale");
    await mkdir(join(dir, ".basalt"), { recursive: true });
    // A pid nothing is running under. Found by asking, not assumed.
    let dead = 2 ** 22 - 7;
    while (alive(dead)) dead--;
    await writeFile(
      lockPath(dir),
      JSON.stringify({
        pid: dead,
        host: (await import("node:os")).hostname(),
        command: "basalt sync",
        since: 1,
      }),
    );
    const release = await lockVault(dir, "basalt sync");
    expect(JSON.parse(await readFile(lockPath(dir), "utf8"))).toMatchObject({ pid: process.pid });
    await release();
  });

  it("believes a holder on another host, which it cannot check", async () => {
    const dir = await vaultDir("remote");
    await mkdir(join(dir, ".basalt"), { recursive: true });
    await writeFile(
      lockPath(dir),
      JSON.stringify({
        pid: 1,
        host: "some-other-machine",
        command: "basalt sync --watch",
        since: 1,
      }),
    );
    await expect(lockVault(dir, "basalt sync")).rejects.toThrow(/some-other-machine/);
  });

  it("keeps two real processes from syncing one vault at once", async () => {
    const dir = await paired("two");
    await writeFile(join(dir, "note.md"), "a note\n");

    const watcher = basalt("sync", "--watch", "--dir", dir);
    await until(
      "the watcher to be running",
      () => /Watching for changes/.test(watcher.stderrText()),
      30_000,
    );

    const second = basalt("sync", "--dir", dir);
    expect(await exited(second)).toBe(1);
    expect(second.stderrText()).toMatch(/another basalt is using this vault: basalt sync/);
    expect(second.stderrText()).toMatch(new RegExp(`pid ${watcher.pid} on`));

    // Stopped without cleaning up, as a kill or a crash would leave it.
    const ended = exited(watcher);
    watcher.kill("SIGKILL");
    await ended;
    expect(JSON.parse(await readFile(lockPath(dir), "utf8"))).toMatchObject({ pid: watcher.pid });

    // The next one recognises a dead holder and gets on with it.
    const third = await cli("sync", "--dir", dir, "--json");
    expect(third.code, third.all).toBe(0);
    await expect(stat(lockPath(dir))).rejects.toThrow();
  }, 120_000);

  it("lets a reading command through while a watcher holds the vault", async () => {
    const dir = await paired("read");
    const watcher = basalt("sync", "--watch", "--dir", dir);
    await until(
      "the watcher to be running",
      () => /Watching for changes/.test(watcher.stderrText()),
      30_000,
    );
    const status = await cli("status", "--dir", dir, "--json");
    expect(status.code, status.all).toBe(0);
  }, 120_000);
});

describe("unlinking as one transition (C13)", () => {
  it("removes the index before the config, and leaves the vault paired if it cannot", async () => {
    const dir = await paired("unlink");
    await writeFile(join(dir, "note.md"), "a note\n");
    expect((await cli("sync", "--dir", dir)).code).toBe(0);

    // The index cannot be removed: something is in its way.
    await rm(indexPath(dir));
    await mkdir(join(indexPath(dir), "occupied"), { recursive: true });
    const attempt = await cli("unlink", "--dir", dir);
    expect(attempt.code).toBe(1);
    // Still paired, which is the state that refuses to pair again.
    await expect(readFile(configPath(dir), "utf8")).resolves.toMatch(/"deviceSecret"/);
    expect((await cli("init", server!.setup, "--dir", dir)).code).toBe(1);

    await rm(indexPath(dir), { recursive: true });
    const done = await cli("unlink", "--dir", dir, "--json");
    expect(done.code, done.all).toBe(0);
    await expect(stat(configPath(dir))).rejects.toThrow();
    await expect(stat(indexPath(dir))).rejects.toThrow();
  }, 120_000);

  it("refuses to pair over an index left by an unfinished unlink", async () => {
    const { dir, recoveryKey: pairing } = await pairedWithKey("orphan");
    expect((await cli("sync", "--dir", dir)).code).toBe(0);
    // The old order's failure state: config gone, index still there.
    await rm(configPath(dir));

    const init = await cli("init", server!.setup, "--dir", dir);
    expect(init.code).toBe(1);
    expect(init.all).toMatch(/still holds an index/);
    const pair = await cli("pair", pairing, "--dir", dir);
    expect(pair.code).toBe(1);
    expect(pair.all).toMatch(/still holds an index/);

    // Unlink clears it, and then pairing is allowed.
    expect((await cli("unlink", "--dir", dir)).code).toBe(0);
    const again = await cli("pair", pairing, "--dir", dir, "--device", "again", "--json");
    expect(again.code, again.all).toBe(0);
  }, 120_000);

  it("refuses to unlink while another process is syncing the vault", async () => {
    const dir = await paired("busy");
    const watcher = basalt("sync", "--watch", "--dir", dir);
    await until(
      "the watcher to be running",
      () => /Watching for changes/.test(watcher.stderrText()),
      30_000,
    );
    const attempt = await cli("unlink", "--dir", dir);
    expect(attempt.code).toBe(1);
    expect(attempt.all).toMatch(/another basalt is using this vault/);
    await expect(readFile(configPath(dir), "utf8")).resolves.toMatch(/"deviceSecret"/);
  }, 120_000);
});

/**
 * review finding C23, at the CLI. The index on disk is valid JSON and nothing
 * else, and both `sync` and `status` used to read numbers out of it.
 */
describe("an index that is valid JSON and wrong (C23)", () => {
  it("is refused by sync and status alike, with the field named", async () => {
    const dir = await paired("badindex");
    expect((await cli("sync", "--dir", dir)).code).toBe(0);
    const index = JSON.parse(await readFile(indexPath(dir), "utf8")) as Record<string, unknown>;
    await writeFile(indexPath(dir), JSON.stringify({ ...index, pending: "soon" }));

    const sync = await cli("sync", "--dir", dir);
    expect(sync.code).toBe(1);
    expect(sync.all).toMatch(/pending is not a list/);
    expect(sync.all).toMatch(/Remove the index and sync again/);
    const status = await cli("status", "--dir", dir);
    expect(status.code).toBe(1);
    expect(status.all).toMatch(/pending is not a list/);
  }, 120_000);
});

/**
 * review finding C15, at the place protocol 4 leaves it.
 *
 * A vault is claimed by the hello that starts it, and the config holding the
 * root is written and read back before that hello goes out for exactly this
 * reason: the claim commits, its reply is lost, and the only copy of the
 * vault's recovery key is the one on this disk. Protocol 3 answered that by
 * resuming from the config, retrying the spent token and falling back to the
 * key the root derives. Nothing resumes now, and the answer is simpler and has
 * to be just as complete: every command refuses such a config, prints the
 * recovery key back out of it, and pairing again with that key joins the vault
 * that was claimed, with every note still on it.
 *
 * A vault that could be claimed and then not got back into would be the worst
 * failure this project has, so it is tested end to end rather than by the
 * words of the refusal alone.
 */
describe("a vault that was started and never joined (C15)", () => {
  /**
   * Puts a vault back into the state a lost reply leaves: claimed on the
   * server, and a config on disk that still holds the root and has no device
   * row of its own.
   *
   * Written out rather than kept from before, because `init` gets all the way
   * to a registered device now: this is the state it would have been left in
   * had the registration failed after the claim committed.
   */
  async function startedNotJoined(dir: string, recoveryKey: string): Promise<void> {
    const { parsePairing } = await import("../core/pairing.ts");
    const config = (await loadConfig(dir))!;
    await saveConfig(dir, {
      url: config.url,
      vaultId: config.vaultId,
      device: config.device,
      secret: parsePairing(recoveryKey).secret,
    });
  }

  it("refuses, hands the recovery key back, and pairs again with it", async () => {
    const { dir, recoveryKey } = await pairedWithKey("lost");
    await writeFile(join(dir, "note.md"), "kept\n");
    await cli("sync", "--dir", dir);
    await startedNotJoined(dir, recoveryKey);

    const sync = await cli("sync", "--dir", dir);
    expect(sync.code, sync.all).toBe(1);
    expect(sync.all).toMatch(/never registered itself/);
    // The key itself, not advice to find it somewhere: this config is the only
    // place it exists, and a refusal that does not print it is a lost vault.
    expect(sync.all).toContain(recoveryKey);
    expect(sync.all).toMatch(/unlink this vault and pair again/);
    // And nothing was written on the way past. The root is still there to be
    // read out again by the next command that refuses.
    expect((await loadConfig(dir))!.secret, "the root was dropped by a refusal").toBeDefined();

    // The way back the refusal names, all the way to the notes.
    expect((await cli("unlink", "--dir", dir)).code).toBe(0);
    const again = await cli("pair", recoveryKey, "--dir", dir, "--json");
    expect(again.code, again.all).toBe(0);
    const after = (await loadConfig(dir))!;
    expect(after.secret, "the recovery key was kept after pairing").toBeUndefined();
    expect(after.deviceId).toBeDefined();
    expect((await cli("sync", "--dir", dir)).code).toBe(0);
    expect(await readFile(join(dir, "note.md"), "utf8")).toBe("kept\n");
  }, 180_000);

  /**
   * The other half of the same disk failure, on the pairing path rather than
   * the starting one. A registration commits and its credential does not reach
   * the disk, so the vault has a row nothing holds the key to. That is the
   * orphan the invite path already leaves when a reply is lost, and the
   * refusal has to name it: an unnamed row is one of eight slots nobody can
   * account for later.
   */
  it("names the row it left behind when a pairing could not save its credential", async () => {
    const { dir, recoveryKey } = await pairedWithKey("orphan");
    const second = await vaultDir("second");

    failSavesAfter = saves; // the very next save fails, which is the credential
    const attempt = await cli("pair", recoveryKey, "--dir", second);
    expect(attempt.code, attempt.all).toBe(1);
    expect(attempt.all).toMatch(/nothing can connect as/);
    expect(attempt.all).toMatch(/basalt revoke/);
    // Nothing here claims to be paired, because nothing here can connect.
    failSavesAfter = Infinity;
    expect(await loadConfig(second)).toBeUndefined();

    // And the row the refusal names is really there, and really goes.
    const listed = await cli("devices", "--dir", dir, "--json");
    const rows = listed.json()["devices"] as { id: string; lastSeen: number }[];
    const orphan = rows.find((d) => d.lastSeen === 0);
    expect(orphan, listed.all).toBeDefined();
    expect((await cli("revoke", orphan!.id, "--dir", dir)).code).toBe(0);
  }, 180_000);

  it("says the same thing to status, without blaming the server", async () => {
    const { dir, recoveryKey } = await pairedWithKey("status");
    await startedNotJoined(dir, recoveryKey);
    const s = await cli("status", "--dir", dir, "--json");
    expect(s.code, s.all).toBe(1);
    const answer = s.json()["server"] as Record<string, unknown>;
    // Rule 7. Nothing was asked of the server, so it is neither reachable nor
    // refused, and calling it refused sends somebody after an outage that is
    // not happening.
    expect(answer["reachable"], s.all).toBe(false);
    expect(answer["refused"], s.all).toBe(false);
    expect(String(answer["error"])).toMatch(/never registered itself/);
  }, 120_000);

  it("fails init honestly when the claim succeeds and the registration is not saved", async () => {
    server = new TestServer();
    await server.start();
    const dir = await vaultDir("init");
    // The root is saved, the claim goes out and commits, and the save that
    // would record this device's credential fails.
    failSavesAfter = 1;
    const init = await cli("init", server.setup, "--dir", dir, "--device", "init");
    expect(init.code).toBe(1);
    expect(init.all).toMatch(/could not register itself/);
    // The recovery key is printed anyway, because at that moment the secret in
    // this config is the only copy of it on this machine.
    expect(init.all).toMatch(/Write this recovery key down now/);
    const printed = init.err.join("\n").match(/(basalt3_[A-Za-z0-9_-]+)/)![1]!;
    expect((await loadConfig(dir))!.secret, "init threw the root away").toBeDefined();

    failSavesAfter = Infinity;
    expect((await cli("unlink", "--dir", dir)).code).toBe(0);
    const again = await cli("pair", printed, "--dir", dir, "--json");
    expect(again.code, again.all).toBe(0);
    expect((await loadConfig(dir))!.secret).toBeUndefined();
    expect((await cli("sync", "--dir", dir)).code).toBe(0);
  }, 180_000);
});
