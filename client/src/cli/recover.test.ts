/**
 * Recovery, end to end.
 *
 * The server has kept every version of every note and every deletion since the
 * first commit in this repository, and until now exposed none of it. For a
 * project whose first rule is not to lose a note, a safety net nobody can reach
 * is half a promise.
 *
 * Two read-only operations make it reachable, and restoring is deliberately not
 * one of them: a client fetches an old version with the ordinary `get` and
 * writes it back, so the server keeps exactly one way to change a vault. These
 * tests drive that through the real CLI, against a real server, with real
 * directories.
 */

import { mkdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { cleanupBinary, removeTree, serverBinary, TestServer } from "../core/test-server.ts";
import { run, type Console } from "./cli.ts";

beforeAll(async () => {
  await serverBinary();
}, 180_000);

afterAll(async () => {
  await cleanupBinary();
});

class Run {
  readonly out: string[] = [];
  readonly err: string[] = [];
  code = -1;
  get stdout(): string {
    return this.out.join("\n");
  }
  get all(): string {
    return this.out.join("\n") + "\n" + this.err.join("\n");
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

afterEach(async () => {
  while (dirs.length) await removeTree(dirs.pop()!);
  if (server) await server.cleanup();
});

/** One paired vault against a fresh server. */
async function paired(): Promise<string> {
  return (await pairedWithKey()).dir;
}

/**
 * The same, and the recovery key `init` printed. Kept by the caller because
 * nothing reprints it: a paired device holds its own credential and not the
 * vault's root.
 */
async function pairedWithKey(): Promise<{ dir: string; recoveryKey: string }> {
  server = new TestServer();
  await server.start();
  const dir = await vaultDir("a");
  const init = await cli(
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
  expect(init.code, init.all).toBe(0);
  return { dir, recoveryKey: init.json()["recoveryKey"] as string };
}

const read = (dir: string, path: string) => readFile(join(dir, path), "utf8");
const write = async (dir: string, path: string, text: string) => {
  await mkdir(join(dir, path, ".."), { recursive: true });
  await writeFile(join(dir, path), text);
};

describe("history", () => {
  it("shows every version, newest first", async () => {
    const dir = await paired();
    for (const text of ["one\n", "two\n", "three\n"]) {
      await write(dir, "note.md", text);
      await cli("sync", "--dir", dir);
    }

    const h = await cli("history", "note.md", "--dir", dir, "--json");
    expect(h.code, h.all).toBe(0);
    const versions = h.json()["versions"] as { uid: number; size: number }[];
    expect(versions.length).toBe(3);
    expect(versions[0]!.uid).toBeGreaterThan(versions[1]!.uid);
    expect(versions[1]!.uid).toBeGreaterThan(versions[2]!.uid);
    expect(versions.map((v) => v.size)).toEqual([6, 4, 4]);
  }, 300_000);

  it("includes the deletion, so the story does not just stop", async () => {
    const dir = await paired();
    await write(dir, "note.md", "here\n");
    await cli("sync", "--dir", dir);
    await rm(join(dir, "note.md"));
    await cli("sync", "--dir", dir);

    const h = await cli("history", "note.md", "--dir", dir, "--json");
    const versions = h.json()["versions"] as { deleted: boolean }[];
    expect(versions.length).toBe(2);
    expect(versions[0]!.deleted).toBe(true);
    expect(versions[1]!.deleted).toBe(false);
  }, 300_000);

  /**
   * The server cannot tell a path it never had from one whose history was
   * purged: both are absent. Saying which would be a guess, and this is the
   * one tool where a guess is least welcome.
   */
  it("says plainly when there is nothing, rather than guessing why", async () => {
    const dir = await paired();
    const h = await cli("history", "never-existed.md", "--dir", dir);
    expect(h.code).toBe(0);
    expect(h.stdout).toMatch(/no versions of never-existed\.md/);
  }, 300_000);

  it("needs a path", async () => {
    const dir = await paired();
    const h = await cli("history", "--dir", dir);
    expect(h.code).toBe(1);
    expect(h.all).toMatch(/needs the path/);
  }, 300_000);

  /**
   * The server lists at most five hundred versions and answers a larger
   * limit with its default page of a hundred, saying nothing. Passed
   * through, `--limit 600` printed a hundred versions that read as all of
   * them.
   */
  it("caps the limit at what the server will list, and says so", async () => {
    const dir = await paired();
    await write(dir, "note.md", "one\n");
    await cli("sync", "--dir", dir);

    const h = await cli("history", "note.md", "--dir", dir, "--limit", "600");
    expect(h.code, h.all).toBe(0);
    expect(h.stdout).toMatch(/at most 500 versions/);
    expect(h.stdout).toMatch(/--limit 600 was capped/);

    const j = await cli("history", "note.md", "--dir", dir, "--limit", "600", "--json");
    expect(j.json()["limit"]).toBe(500);

    // Within the cap nothing is said, because nothing was changed.
    const small = await cli("history", "note.md", "--dir", dir, "--limit", "5");
    expect(small.stdout).not.toMatch(/capped/);
  }, 300_000);
});

describe("the list of what is gone", () => {
  it("names notes the vault no longer has", async () => {
    const dir = await paired();
    await write(dir, "kept.md", "still here\n");
    await write(dir, "lost.md", "not for long\n");
    await write(dir, "folder/also-lost.md", "nor this\n");
    await cli("sync", "--dir", dir);

    await rm(join(dir, "lost.md"));
    await rm(join(dir, "folder", "also-lost.md"));
    await cli("sync", "--dir", dir);

    const d = await cli("deleted", "--dir", dir, "--json");
    expect(d.code, d.all).toBe(0);
    const paths = (d.json()["deleted"] as { path: string }[]).map((v) => v.path).sort();
    expect(paths).toContain("lost.md");
    expect(paths).toContain("folder/also-lost.md");
    expect(paths).not.toContain("kept.md");
  }, 300_000);

  /**
   * The paths come back unsealed. The server never saw them in the clear and
   * still has not: it answered with the sealed names, and the client opened
   * them with a key the server has never held.
   */
  it("reads back plaintext names the server cannot", async () => {
    const dir = await paired();
    await write(dir, "Meeting notes 2026.md", "x\n");
    await cli("sync", "--dir", dir);
    await rm(join(dir, "Meeting notes 2026.md"));
    await cli("sync", "--dir", dir);

    const d = await cli("deleted", "--dir", dir, "--json");
    const paths = (d.json()["deleted"] as { path: string }[]).map((v) => v.path);
    expect(paths).toEqual(["Meeting notes 2026.md"]);
  }, 300_000);

  it("says so when nothing has been deleted", async () => {
    const dir = await paired();
    await write(dir, "kept.md", "here\n");
    await cli("sync", "--dir", dir);
    const d = await cli("deleted", "--dir", dir);
    expect(d.code).toBe(0);
    expect(d.stdout).toMatch(/Nothing has been deleted/);
  }, 300_000);

  /**
   * A rename the client could not see is reported as a deletion, and that is
   * honest rather than a bug.
   *
   * A filesystem scan cannot tell a rename from a delete plus a create: it
   * sees one path gone and another arrived, and nothing connects them. The
   * headless client gets no rename event and so reports what it saw. The
   * server's suppression is real and is tested where a rename can actually be
   * observed, which is Obsidian, in src/plugin/sync.test.ts.
   *
   * Nothing is lost either way. The content is on the server under both
   * names, and chunk deduplication means the second name cost nothing to
   * store.
   */
  it("reports a rename it could not see as a deletion, because that is what it saw", async () => {
    const dir = await paired();
    await write(dir, "old-name.md", "the same content throughout\n");
    await cli("sync", "--dir", dir);

    await write(dir, "new-name.md", "the same content throughout\n");
    await rm(join(dir, "old-name.md"));
    await cli("sync", "--dir", dir);

    const d = await cli("deleted", "--dir", dir, "--json");
    const paths = (d.json()["deleted"] as { path: string }[]).map((v) => v.path);
    expect(paths).toContain("old-name.md");
    // And the note is not lost: it is under the new name, and the old name
    // is restorable.
    expect(await read(dir, "new-name.md")).toBe("the same content throughout\n");
  }, 300_000);
});

describe("restoring", () => {
  it("brings a deleted note back", async () => {
    const dir = await paired();
    await write(dir, "gone.md", "# Gone\n\nBut not forgotten.\n");
    await cli("sync", "--dir", dir);
    await rm(join(dir, "gone.md"));
    await cli("sync", "--dir", dir);
    await expect(read(dir, "gone.md")).rejects.toThrow();

    const r = await cli("restore", "gone.md", "--dir", dir, "--json");
    expect(r.code, r.all).toBe(0);
    expect(await read(dir, "gone.md")).toBe("# Gone\n\nBut not forgotten.\n");
  }, 300_000);

  it("brings back an exact version by uid", async () => {
    const dir = await paired();
    for (const text of ["first\n", "second\n", "third\n"]) {
      await write(dir, "note.md", text);
      await cli("sync", "--dir", dir);
    }
    const versions = (await cli("history", "note.md", "--dir", dir, "--json")).json()[
      "versions"
    ] as {
      uid: number;
      size: number;
    }[];
    const oldest = versions[versions.length - 1]!;

    const r = await cli("restore", "note.md", "--dir", dir, "--uid", String(oldest.uid), "--json");
    expect(r.code, r.all).toBe(0);
    // The path was occupied, so the restored copy landed beside it.
    const at = r.json()["path"] as string;
    expect(at).not.toBe("note.md");
    expect(await read(dir, at)).toBe("first\n");
    // And what was already there is untouched.
    expect(await read(dir, "note.md")).toBe("third\n");
  }, 300_000);

  /**
   * A recovery tool that can destroy the thing you still have is worse than
   * none at all. Restoring onto an occupied path keeps both.
   */
  it("never overwrites what is already there", async () => {
    const dir = await paired();
    await write(dir, "note.md", "the old version\n");
    await cli("sync", "--dir", dir);
    await rm(join(dir, "note.md"));
    await cli("sync", "--dir", dir);

    // Somebody has since written something new at the same path.
    await write(dir, "note.md", "something I am working on now\n");

    const r = await cli("restore", "note.md", "--dir", dir, "--json");
    expect(r.code, r.all).toBe(0);
    expect(await read(dir, "note.md")).toBe("something I am working on now\n");
    expect(await read(dir, r.json()["path"] as string)).toBe("the old version\n");
  }, 300_000);

  it("restores somewhere else when asked", async () => {
    const dir = await paired();
    await write(dir, "note.md", "content\n");
    await cli("sync", "--dir", dir);
    await rm(join(dir, "note.md"));
    await cli("sync", "--dir", dir);

    const r = await cli("restore", "note.md", "--dir", dir, "--to", "recovered/note.md", "--json");
    expect(r.code, r.all).toBe(0);
    expect(await read(dir, "recovered/note.md")).toBe("content\n");
  }, 300_000);

  /**
   * A restore is a new version like any other, so the other devices get it
   * without anybody doing anything. Leaving it local until the next sync
   * would mean somebody who has just recovered a note has to know that.
   */
  it("sends the restored note to the other devices", async () => {
    const { dir, recoveryKey: pairing } = await pairedWithKey();
    await write(dir, "shared.md", "the original\n");
    await cli("sync", "--dir", dir);

    const other = await vaultDir("b");
    await cli("pair", pairing, "--dir", other, "--device", "b");
    await cli("sync", "--dir", other);
    expect(await read(other, "shared.md")).toBe("the original\n");

    await rm(join(dir, "shared.md"));
    await cli("sync", "--dir", dir);
    await cli("sync", "--dir", other);
    await expect(read(other, "shared.md")).rejects.toThrow();

    await cli("restore", "shared.md", "--dir", dir);
    await cli("sync", "--dir", other);
    expect(await read(other, "shared.md")).toBe("the original\n");
  }, 300_000);

  /**
   * A restored note keeps the time it was written, not the time it was
   * recovered. Stamping it "now" would make a note from March look like the
   * newest thing in the vault, and sort to the top of every recent list.
   */
  it("keeps the timestamp the note was written with", async () => {
    const dir = await paired();
    await write(dir, "note.md", "content\n");
    const original = new Date("2026-03-04T05:06:07Z");
    await utimes(join(dir, "note.md"), original, original);
    await cli("sync", "--dir", dir);

    const versions = (await cli("history", "note.md", "--dir", dir, "--json")).json()[
      "versions"
    ] as {
      mtime: number;
    }[];
    expect(Math.round(versions[0]!.mtime)).toBe(original.getTime());

    await rm(join(dir, "note.md"));
    await cli("sync", "--dir", dir);
    await cli("restore", "note.md", "--dir", dir);

    const back = await stat(join(dir, "note.md"));
    expect(Math.round(back.mtimeMs)).toBe(original.getTime());
  }, 300_000);

  /**
   * The deletion is a version like any other and has no content in it. Asking
   * to restore it is asking to restore nothing, and quietly writing an empty
   * file would be the worst possible answer.
   */
  it("refuses to restore the deletion itself", async () => {
    const dir = await paired();
    await write(dir, "note.md", "content\n");
    await cli("sync", "--dir", dir);
    await rm(join(dir, "note.md"));
    await cli("sync", "--dir", dir);

    const versions = (await cli("history", "note.md", "--dir", dir, "--json")).json()[
      "versions"
    ] as {
      uid: number;
      deleted: boolean;
    }[];
    const deletion = versions.find((v) => v.deleted)!;

    const r = await cli("restore", "note.md", "--dir", dir, "--uid", String(deletion.uid));
    expect(r.code).toBe(1);
    expect(r.all).toMatch(/is the deletion itself/);
    // And nothing was written, least of all an empty file.
    await expect(read(dir, "note.md")).rejects.toThrow();
  }, 300_000);

  it("refuses a version it does not have, rather than restoring the wrong one", async () => {
    const dir = await paired();
    await write(dir, "note.md", "content\n");
    await cli("sync", "--dir", dir);

    const r = await cli("restore", "note.md", "--dir", dir, "--uid", "99999");
    expect(r.code).toBe(1);
    expect(r.all).toMatch(/no version 99999/);
  }, 300_000);

  it("refuses to restore a note the server never had", async () => {
    const dir = await paired();
    const r = await cli("restore", "never-existed.md", "--dir", dir);
    expect(r.code).toBe(1);
    expect(r.all).toMatch(/no version of never-existed\.md/);
  }, 300_000);

  it("refuses a uid that is not a uid", async () => {
    const dir = await paired();
    const r = await cli("restore", "note.md", "--dir", dir, "--uid", "banana");
    expect(r.code).toBe(2);
    expect(r.all).toMatch(/--uid wants a version number/);
  }, 300_000);
});

describe("recovery is read only", () => {
  /**
   * Looking must not change anything. The one moment somebody reaches for
   * this is the moment they have already lost something.
   */
  it("leaves the vault and the server exactly as they were", async () => {
    const dir = await paired();
    await write(dir, "note.md", "content\n");
    await cli("sync", "--dir", dir);

    const before = (await cli("status", "--dir", dir, "--json")).json();
    await cli("history", "note.md", "--dir", dir);
    await cli("deleted", "--dir", dir);
    const after = (await cli("status", "--dir", dir, "--json")).json();

    expect(after["cursor"]).toBe(before["cursor"]);
    expect((after["server"] as Record<string, unknown>)["cursor"]).toBe(
      (before["server"] as Record<string, unknown>)["cursor"],
    );
  }, 300_000);
});

describe("after the history has been purged", () => {
  /**
   * Purge keeps only the newest version per path. For a deleted note that is
   * the deletion record, so the note stays in the list and its content is
   * gone. The list used to print "all still recoverable" over it, which told
   * somebody their note was safe when it was not.
   */
  it("says which notes can no longer be brought back", async () => {
    const dir = await paired();
    await write(dir, "kept.md", "still here\n");
    await write(dir, "purged.md", "about to be unrecoverable\n");
    await cli("sync", "--dir", dir);
    await rm(join(dir, "purged.md"));
    await cli("sync", "--dir", dir);

    const before = await cli("deleted", "--dir", dir, "--json");
    expect((before.json()["deleted"] as { restorable: number }[])[0]!.restorable).toBeGreaterThan(
      0,
    );

    // Purge needs the data directory to itself, which is what the
    // exclusive lock is for, so the server steps aside for it.
    await server.whileStopped(async () => {
      await server.cli("purge", "-vault", "default", "-confirm", "default", "-no-backup-check");
    });

    const after = await cli("deleted", "--dir", dir, "--json");
    const notes = after.json()["deleted"] as { path: string; restorable: number }[];
    expect(notes.map((n) => n.path)).toEqual(["purged.md"]);
    expect(notes[0]!.restorable, "the content survived a purge, which it should not have").toBe(0);

    const human = await cli("deleted", "--dir", dir);
    expect(human.stdout).toMatch(/content purged/);
    expect(human.stdout, "it still claimed everything was recoverable").not.toMatch(
      /all still recoverable/,
    );

    // And trying anyway fails plainly rather than writing an empty file.
    const attempt = await cli("restore", "purged.md", "--dir", dir);
    expect(attempt.code).toBe(1);
    expect(attempt.all).toMatch(/no version of purged\.md with any content/);
    await expect(read(dir, "purged.md")).rejects.toThrow();
  }, 300_000);
});
