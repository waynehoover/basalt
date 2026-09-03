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

import { mkdtemp, readFile, rm, stat, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { cleanupBinary, removeTree, serverBinary, TestServer } from "../core/test-server.ts";
import { PAIRING_PREFIX } from "../core/pairing.ts";
import { run, normaliseUrl, parseArgs, type Console } from "./cli.ts";

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
async function twoDevices(): Promise<{ a: string; b: string }> {
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
  return { a, b };
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

  it("reprints the pairing string for a third device", async () => {
    await fresh();
    const { a } = await twoDevices();
    const invite = await cli("recovery-key", "--dir", a, "--json");
    expect(invite.code).toBe(0);
    expect(invite.json()["recoveryKey"] as string).toMatch(new RegExp(`^${PAIRING_PREFIX}`));
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

    const invite = await cli("recovery-key", "--dir", a, "--json");
    const repair = await cli("pair", invite.json()["recoveryKey"] as string, "--dir", b);
    expect(repair.code).toBe(1);
    expect(repair.all).toMatch(/already paired/);
  }, 240_000);

  it("refuses a pairing string that was mangled on the way", async () => {
    await fresh();
    const { a } = await twoDevices();
    const c = await vaultDir("c");
    const pairing = (await cli("recovery-key", "--dir", a, "--json")).json()[
      "recoveryKey"
    ] as string;

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
});

describe("unlinking", () => {
  it("forgets the pairing and keeps every note", async () => {
    await fresh();
    const { a, b } = await twoDevices();
    await write(a, "keep.md", "still here\n");
    await cli("sync", "--dir", a);
    await cli("sync", "--dir", b);

    const gone = await cli("unlink", "--dir", b, "--json");
    expect(gone.code).toBe(0);
    expect(await read(b, "keep.md")).toBe("still here\n");
    await expect(read(b, ".basalt/config.json")).rejects.toThrow();

    // And the server still has it, because unlinking is a local decision.
    const c = await vaultDir("c");
    const pairing = (await cli("recovery-key", "--dir", a, "--json")).json()[
      "recoveryKey"
    ] as string;
    await cli("pair", pairing, "--dir", c, "--device", "c");
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
    expect(r.all).toMatch(/root secret is 32 bytes, or 20/);
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

    // Keeping it is keeping a second secret that opens nothing.
    const after = JSON.parse(await read(a, ".basalt/config.json")) as Record<string, string>;
    expect(after["bootstrap"]).toBeUndefined();
    expect(Object.keys(after).sort()).toEqual(["device", "secret", "url", "vaultId"]);

    // And the vault still syncs, on a credential derived from the secret.
    await write(a, "again.md", "still working\n");
    expect((await cli("sync", "--dir", a, "--json")).json()["uploaded"]).toBe(1);
  }, 300_000);

  it("has no token in the pairing string at all", async () => {
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
    await write(a, "note.md", "x\n");
    await cli("sync", "--dir", a);

    const pairing = (await cli("recovery-key", "--dir", a, "--json")).json()[
      "recoveryKey"
    ] as string;
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

    // Somebody else with the printed token and a secret of their own.
    const intruder = await vaultDir("intruder");
    await cli(
      "init",
      "--dir",
      intruder,
      "--server",
      server.wsUrl,
      "--token",
      server.token,
      "--device",
      "intruder",
      "--json",
    );
    const attempt = await cli("sync", "--dir", intruder);
    expect(attempt.code, `the spent bootstrap still worked: ${attempt.all}`).toBe(1);
    expect(attempt.all).toMatch(/auth|not authorised/i);
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
 * I21 and I13 in TODO.md. Adding a device is an invite; the recovery key is
 * shown once by init, named for what it is, and reprinted only on request.
 */
describe("invites (I21)", () => {
  async function started(): Promise<string> {
    const a = await vaultDir("a");
    const init = await cli("init", server.setup, "--dir", a, "--device", "a", "--json");
    expect(init.code, init.all).toBe(0);
    return a;
  }

  it("prints an invite another device joins with, which works once", async () => {
    await fresh();
    const a = await started();
    await write(a, "note.md", "from a\n");
    expect((await cli("sync", "--dir", a)).code).toBe(0);

    const invited = await cli("invite", "--dir", a);
    expect(invited.code, invited.all).toBe(0);
    const invite = invited.out[0]!;
    expect(invite).toMatch(/^basalt3i_[A-Za-z0-9_-]+$/);
    expect(invited.stdout).toMatch(/works once and expires at/);
    // The root is not in it: the invite carries an id and a key of its own.
    const config = JSON.parse(await read(a, ".basalt/config.json")) as Record<string, string>;
    expect(
      Buffer.from(invite.slice("basalt3i_".length), "base64url").toString("latin1"),
    ).not.toContain(Buffer.from(config["secret"]!, "base64url").toString("latin1"));

    const b = await vaultDir("b");
    const paired = await cli("pair", invite, "--dir", b, "--device", "b");
    expect(paired.code, paired.all).toBe(0);
    expect(paired.stdout).toMatch(/Paired .* as "b"/);
    const configB = JSON.parse(await read(b, ".basalt/config.json")) as Record<string, string>;
    expect(configB["secret"]).toBe(config["secret"]);
    expect(configB["url"]).toBe(config["url"]);
    expect((await cli("sync", "--dir", b)).code).toBe(0);
    expect(await read(b, "note.md")).toBe("from a\n");

    // Spent. A third device with the same string is refused and saves nothing.
    const c = await vaultDir("c");
    const again = await cli("pair", invite, "--dir", c, "--device", "c");
    expect(again.code).toBe(1);
    expect(again.all).toMatch(/not authorised/);
    await expect(stat(join(c, ".basalt", "config.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses an invite that has expired", async () => {
    await fresh();
    const a = await started();
    const invited = await cli("invite", "--dir", a, "--ttl", "1ms", "--json");
    expect(invited.code, invited.all).toBe(0);
    await new Promise((r) => setTimeout(r, 100));
    const b = await vaultDir("b");
    const late = await cli("pair", invited.json()["invite"] as string, "--dir", b);
    expect(late.code).toBe(1);
    expect(late.all).toMatch(/not authorised/);
    await expect(stat(join(b, ".basalt", "config.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses an invite for another vault, and one whose key was changed", async () => {
    await fresh();
    const a = await started();
    const { parseInvite, formatInvite } = await import("../core/pairing.ts");
    const invite = parseInvite(
      (await cli("invite", "--dir", a, "--json")).json()["invite"] as string,
    );

    const b = await vaultDir("b");
    const wrongVault = await cli("pair", formatInvite({ ...invite, vaultId: "other" }), "--dir", b);
    expect(wrongVault.code).toBe(1);
    expect(wrongVault.all).toMatch(/not authorised/);

    // The invite is still unspent, so a changed key can be tried against it:
    // the server hands over the sealed root and the wrong key does not open
    // it. Nothing is saved, and the invite is now spent.
    const key = new Uint8Array(invite.key);
    key[0]! ^= 0xff;
    const wrongKey = await cli("pair", formatInvite({ ...invite, key }), "--dir", b);
    expect(wrongKey.code).toBe(1);
    expect(wrongKey.all).toMatch(/invite key does not open/);
    await expect(stat(join(b, ".basalt", "config.json"))).rejects.toMatchObject({ code: "ENOENT" });
    const spent = await cli("pair", formatInvite(invite), "--dir", b);
    expect(spent.all).toMatch(/not authorised/);
  });

  it("leaves a usable state when the redeemed reply is lost: nothing saved, the invite spent, a new one works", async () => {
    await fresh();
    const a = await started();
    const { parseInvite } = await import("../core/pairing.ts");
    const { redeemInvite } = await import("../core/client.ts");
    const inviteString = (await cli("invite", "--dir", a, "--json")).json()["invite"] as string;
    const invite = parseInvite(inviteString);

    // A socket that loses the one text frame the server sends back.
    const b = await vaultDir("b");
    const lossy = (url: string) => {
      const ws = new WebSocket(url) as unknown as import("../core/transport.ts").SocketLike & {
        addEventListener(type: string, fn: (ev: { data: unknown }) => void): void;
      };
      const proxy: import("../core/transport.ts").SocketLike = {
        binaryType: "arraybuffer",
        onopen: null,
        onclose: null,
        onerror: null,
        onmessage: null,
        send: (d) => ws.send(d as never),
        close: () => ws.close(),
      };
      ws.onopen = (ev) => proxy.onopen?.(ev);
      ws.onclose = (ev) => proxy.onclose?.(ev);
      ws.onerror = (ev) => proxy.onerror?.(ev);
      ws.onmessage = () => {
        /* dropped on the floor, as a connection cut at the wrong moment would */
      };
      return proxy;
    };
    await expect(
      redeemInvite(invite, "b", { timeoutMs: 5_000, socketFactory: lossy }),
    ).rejects.toThrow();
    await expect(stat(join(b, ".basalt", "config.json"))).rejects.toMatchObject({ code: "ENOENT" });

    // The server burned the invite before answering, so it is spent.
    const spent = await cli("pair", inviteString, "--dir", b, "--device", "b");
    expect(spent.code).toBe(1);
    expect(spent.all).toMatch(/not authorised/);

    // And the issuing device makes another, which works.
    const fresh2 = (await cli("invite", "--dir", a, "--json")).json()["invite"] as string;
    const paired = await cli("pair", fresh2, "--dir", b, "--device", "b");
    expect(paired.code, paired.all).toBe(0);
  }, 60_000);

  it("still pairs with the recovery key, which init printed once and recovery-key reprints", async () => {
    await fresh();
    const a = await vaultDir("a");
    const init = await cli("init", server.setup, "--dir", a, "--device", "a");
    expect(init.code, init.all).toBe(0);
    expect(init.stdout).toMatch(/recovery key/);
    expect(init.stdout).toMatch(/Write it down and keep it offline/);
    expect(init.stdout).toMatch(/only way back/);
    expect(init.stdout).not.toMatch(/pairing string/);
    const key = init.out.find((l) => l.trim().startsWith("basalt3_"))!.trim();

    const reprint = await cli("recovery-key", "--dir", a);
    expect(reprint.code).toBe(0);
    expect(reprint.stdout.trim()).toBe(key);
    expect(reprint.stderr).toMatch(/Anyone who has it has the vault/);
    expect(reprint.stderr).toMatch(/basalt invite/);

    const b = await vaultDir("b");
    const paired = await cli("pair", key, "--dir", b, "--device", "b");
    expect(paired.code, paired.all).toBe(0);
  });

  it("reaches the server before it says paired (C39)", async () => {
    await fresh();
    const a = await vaultDir("a");
    const init = await cli("init", server.setup, "--dir", a, "--device", "a", "--json");
    const key = init.json()["recoveryKey"] as string;
    const b = await vaultDir("b");
    await server.cleanup();
    const paired = await cli("pair", key, "--dir", b, "--device", "b", "--timeout", "3000");
    expect(paired.code).toBe(1);
    expect(paired.all).not.toMatch(/Paired/);
    await expect(stat(join(b, ".basalt", "config.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

/**
 * I5 in TODO.md. A vault claimed under protocol 3 has a data key the root
 * only wraps, so the root can be replaced without the history going with it.
 */
describe("rotating the secret (I5)", () => {
  it("retires the old key, keeps the history, and every other device pairs again", async () => {
    await fresh();
    const a = await vaultDir("a");
    const init = await cli("init", server.setup, "--dir", a, "--device", "a", "--json");
    const oldKey = init.json()["recoveryKey"] as string;
    await write(a, "kept.md", "written before the rotation\n");
    expect((await cli("sync", "--dir", a)).code).toBe(0);
    const b = await vaultDir("b");
    expect((await cli("pair", oldKey, "--dir", b, "--device", "b")).code).toBe(0);
    expect((await cli("sync", "--dir", b)).code).toBe(0);

    const rotated = await cli("rotate", "--dir", a);
    expect(rotated.code, rotated.all).toBe(0);
    expect(rotated.stdout).toMatch(/new recovery key/);
    const newKey = rotated.out.find((l) => l.trim().startsWith("basalt3_"))!.trim();
    expect(newKey).not.toBe(oldKey);

    // The old string is refused, on a device that had it and on a new one.
    const stale = await cli("sync", "--dir", b);
    expect(stale.code).toBe(1);
    expect(stale.all).toMatch(/not authorised/);
    const c = await vaultDir("c");
    expect((await cli("pair", oldKey, "--dir", c, "--device", "c")).all).toMatch(/not authorised/);

    // The new one works, and the history written before the rotation reads
    // back under it: the data key did not change.
    expect((await cli("pair", newKey, "--dir", c, "--device", "c")).code).toBe(0);
    expect((await cli("sync", "--dir", c)).code).toBe(0);
    expect(await read(c, "kept.md")).toBe("written before the rotation\n");
    const history = await cli("history", "kept.md", "--dir", c, "--json");
    expect(history.code, history.all).toBe(0);
    expect((history.json()["versions"] as unknown[]).length).toBe(1);

    // And the rotating device carries on with the new secret.
    await write(a, "after.md", "after\n");
    expect((await cli("sync", "--dir", a)).code).toBe(0);
    expect((await cli("sync", "--dir", c)).code).toBe(0);
    expect(await read(c, "after.md")).toBe("after\n");
  }, 60_000);

  it("says a protocol 2 vault cannot be rotated, before doing anything", async () => {
    await fresh();
    // A vault claimed with no data key, as every protocol 2 device claimed.
    const { Transport } = await import("../core/transport.ts");
    const { authToken, deriveKeys, generateSecret } = await import("../core/crypto.ts");
    const { formatPairing } = await import("../core/pairing.ts");
    const secret = generateSecret();
    const keys = await deriveKeys(secret);
    const t = new Transport(server.wsUrl, { onBatch: () => {}, timeoutMs: 10_000 });
    await t.connect();
    const ready = await t.hello({
      vault: "default",
      token: server.token,
      claim: authToken(keys),
      device: "old",
      cursor: 0,
    });
    t.close();
    expect(ready.wrapped).toBeUndefined();

    const a = await vaultDir("a");
    const key = formatPairing({ url: server.wsUrl, vaultId: "default", secret });
    expect((await cli("pair", key, "--dir", a, "--device", "a")).code).toBe(0);
    const rotated = await cli("rotate", "--dir", a);
    expect(rotated.code).toBe(1);
    expect(rotated.all).toMatch(
      /this vault was claimed under protocol 2, rotation is a new vault, see docs\/server\.md/,
    );
    // Nothing changed: the same key still opens it.
    expect((await cli("sync", "--dir", a)).code).toBe(0);
  });
});

/**
 * I11, I14, I15, I24 and C33 in TODO.md: the smaller CLI contracts.
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

  it("parses a ttl the way a person types one", async () => {
    const { parseDuration } = await import("./cli.ts");
    expect(parseDuration("10m")).toBe(600_000);
    expect(parseDuration("1h")).toBe(3_600_000);
    expect(parseDuration("90s")).toBe(90_000);
    expect(parseDuration("45")).toBe(45_000);
    expect(() => parseDuration("2h")).toThrow(/at most 1h/);
    expect(() => parseDuration("soon")).toThrow(/like 10m/);
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
      blocked: 0,
      inTheWay: [],
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
 * I10 in TODO.md. A server restored from an older backup is behind a device
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
