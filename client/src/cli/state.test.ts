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
  server = new TestServer();
  await server.start();
  const dir = await vaultDir(name);
  const init = await cli("init", server.setup, "--dir", dir, "--device", name, "--json");
  expect(init.code, init.all).toBe(0);
  return dir;
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
    await expect(readFile(configPath(dir), "utf8")).resolves.toMatch(/"secret"/);
    expect((await cli("init", server!.setup, "--dir", dir)).code).toBe(1);

    await rm(indexPath(dir), { recursive: true });
    const done = await cli("unlink", "--dir", dir, "--json");
    expect(done.code, done.all).toBe(0);
    await expect(stat(configPath(dir))).rejects.toThrow();
    await expect(stat(indexPath(dir))).rejects.toThrow();
  }, 120_000);

  it("refuses to pair over an index left by an unfinished unlink", async () => {
    const dir = await paired("orphan");
    expect((await cli("sync", "--dir", dir)).code).toBe(0);
    const pairing = (await cli("recovery-key", "--dir", dir, "--json")).json()[
      "recoveryKey"
    ] as string;
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
    await expect(readFile(configPath(dir), "utf8")).resolves.toMatch(/"secret"/);
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
 * review finding C15. The claim and the removal of the spent bootstrap are two
 * writes, and the second can fail. Left as it was, the next run offered the
 * spent bootstrap first, was refused with `auth`, and gave up: a vault this
 * device had claimed, refusing this device for ever.
 */
describe("a bootstrap that was spent but not forgotten (C15)", () => {
  async function bootstrapBack(dir: string): Promise<void> {
    const config = (await loadConfig(dir))!;
    await saveConfig(dir, { ...config, bootstrap: server!.token });
  }

  it("recovers when the claim committed and its reply was lost", async () => {
    const dir = await paired("lost");
    expect((await loadConfig(dir))!.bootstrap).toBeUndefined();
    // As a lost reply leaves it: claimed on the server, bootstrap on disk.
    await bootstrapBack(dir);

    const sync = await cli("sync", "--dir", dir, "--json");
    expect(sync.code, sync.all).toBe(0);
    expect((await loadConfig(dir))!.bootstrap, "the spent bootstrap was kept").toBeUndefined();
  }, 120_000);

  it("closes the connection and keeps the bootstrap when forgetting it fails, then recovers", async () => {
    const dir = await paired("failsave");
    await bootstrapBack(dir);

    failSavesAfter = saves; // the very next save fails
    const attempt = await cli("sync", "--dir", dir);
    expect(attempt.code).toBe(1);
    expect(attempt.all).toMatch(/claimed but .* could not be brought up to date/);
    expect((await loadConfig(dir))!.bootstrap).toBe(server!.token);

    failSavesAfter = Infinity;
    const again = await cli("sync", "--dir", dir, "--json");
    expect(again.code, again.all).toBe(0);
    expect((await loadConfig(dir))!.bootstrap).toBeUndefined();
  }, 120_000);

  it("fails init honestly when the claim succeeds and the second write does not", async () => {
    server = new TestServer();
    await server.start();
    const dir = await vaultDir("init");
    failSavesAfter = 1; // the first save, with the bootstrap, succeeds; the one after the claim fails
    const init = await cli("init", server.setup, "--dir", dir, "--device", "init");
    expect(init.code).toBe(1);
    expect(init.all).toMatch(/could not be brought up to date/);
    expect((await loadConfig(dir))!.bootstrap).toBe(server.token);

    failSavesAfter = Infinity;
    const sync = await cli("sync", "--dir", dir, "--json");
    expect(sync.code, sync.all).toBe(0);
    expect((await loadConfig(dir))!.bootstrap).toBeUndefined();
  }, 120_000);

  it("does not drop a bootstrap the derived key cannot vouch for", async () => {
    // A vault claimed by somebody else's secret: the bootstrap is refused and
    // so is this device's key, so nothing is proven and nothing is rewritten.
    const dir = await paired("other");
    const stranger = await vaultDir("stranger");
    const { generateSecret } = await import("../core/crypto.ts");
    await saveConfig(stranger, {
      url: server!.wsUrl,
      vaultId: "default",
      device: "stranger",
      secret: generateSecret(),
      bootstrap: server!.token,
    });
    const sync = await cli("sync", "--dir", stranger);
    expect(sync.code).toBe(1);
    expect((await loadConfig(stranger))!.bootstrap).toBe(server!.token);
    expect(dir).toBeTruthy();
  }, 120_000);
});
