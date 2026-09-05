/**
 * Two devices that were apart, put back together, through the whole client.
 *
 * The pieces of this are each covered somewhere else and the composition was
 * not. `merge.fuzz.ts` owns `mergeText` and never touches a socket.
 * `engine.test.ts` runs two engines against a real server and gives them
 * in-memory vaults, so the filesystem adapter, the on-disk index and the
 * conflict copy's real name are all outside it. `cli.test.ts` drives two real
 * directories and asserts one shape at a time. What none of them does is let
 * both devices diverge in every way at once and then ask the three questions
 * that matter afterwards: did the two vaults converge, is every conflict copy
 * on both of them, and does the server's history still tell the whole story
 * from either side.
 *
 * Rule 10 of docs/design.md is why the assertions are shaped the way they are.
 * A conflict test that asserted the two devices agreed passed while one side's
 * edit had vanished, so agreement is checked *as well as*, never instead of,
 * every edit being present by name.
 *
 * Rule 6 is the other half: a deletion is an entry, so the history of a note
 * that was deleted and came back has to hold the deletion too. A history that
 * quietly starts at the version after the interesting one is the safety net
 * with a hole in it.
 */

import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
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

/** Captures what the CLI printed, and what it exited with. */
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

/** A fresh server with two paired directories on it, named `a` and `b`. */
async function twoDevices(): Promise<{ a: string; b: string }> {
  server = new TestServer();
  await server.start();
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
  const paired = await cli(
    "pair",
    init.json()["recoveryKey"] as string,
    "--dir",
    b,
    "--device",
    "b",
    "--json",
  );
  expect(paired.code, paired.all).toBe(0);
  return { a, b };
}

const read = (dir: string, path: string) => readFile(join(dir, path), "utf8");
const write = async (dir: string, path: string, text: string) => {
  await mkdir(join(dir, path, ".."), { recursive: true });
  await writeFile(join(dir, path), text);
};

/**
 * Syncs both directories until neither has anything left to say.
 *
 * Alternating rather than parallel, because a divergence takes more than one
 * pass to settle by design: the second device sees the first's version, keeps
 * both, and the copy it writes then has to travel back. Three rounds is one
 * more than any case here needs, and a case that needed more would be a bug
 * rather than a reason to raise the number.
 */
async function together(a: string, b: string, rounds = 3): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    const one = await cli("sync", "--dir", a, "--json");
    expect(one.code, `sync on a: ${one.all}`).toBe(0);
    const two = await cli("sync", "--dir", b, "--json");
    expect(two.code, `sync on b: ${two.all}`).toBe(0);
  }
}

/**
 * Every file in a vault and its bytes, for comparing one directory to another.
 *
 * `.basalt` is left out because it is this device's own state: its config
 * names the device and its index records what this device has seen, so two
 * converged vaults differ there and should.
 */
async function tree(dir: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const walk = async (at: string, prefix: string): Promise<void> => {
    for (const item of await readdir(at, { withFileTypes: true })) {
      if (item.name === ".basalt" || item.name === ".trash") continue;
      const path = prefix ? `${prefix}/${item.name}` : item.name;
      if (item.isDirectory()) await walk(join(at, item.name), path);
      else out.set(path, await readFile(join(at, item.name), "utf8"));
    }
  };
  await walk(dir, "");
  return out;
}

/** What differs between two vaults, as something an assertion can print. */
function differences(a: Map<string, string>, b: Map<string, string>): string[] {
  const out: string[] = [];
  for (const [path, text] of a) {
    const other = b.get(path);
    if (other === undefined) out.push(`only on a: ${path}`);
    else if (other !== text) out.push(`different bytes: ${path}`);
  }
  for (const path of b.keys()) if (!a.has(path)) out.push(`only on b: ${path}`);
  return out;
}

/** Everything a vault holds, joined, for asking whether a text survived at all. */
async function everywhere(dir: string): Promise<string> {
  return [...(await tree(dir)).values()].join("\n---\n");
}

interface Version {
  uid: number;
  device: string;
  size: number;
  deleted: boolean;
  folder: boolean;
}

/** What the server tells this device about one path's past. */
async function history(dir: string, path: string): Promise<Version[]> {
  const h = await cli("history", path, "--dir", dir, "--json");
  expect(h.code, h.all).toBe(0);
  return h.json()["versions"] as Version[];
}

/**
 * Both devices' answers for one path, checked against each other and returned.
 *
 * The two lists must be identical, uid for uid. History is the recovery
 * surface: rule 11 says a recovery path nobody runs is a rumour, and a history
 * that is complete on the device you happen to be holding and short on the
 * other is exactly the rumour that reads as a fact until the day it matters.
 */
async function agreedHistory(a: string, b: string, path: string): Promise<Version[]> {
  const fromA = await history(a, path);
  const fromB = await history(b, path);
  expect(
    fromB.map((v) => v.uid),
    `the two devices tell different stories about ${path}`,
  ).toEqual(fromA.map((v) => v.uid));
  return fromA;
}

const copies = (files: Map<string, string>): string[] =>
  [...files.keys()].filter((p) => p.includes("Conflicted copy")).sort();

describe("two devices that edited the same line while apart", () => {
  /**
   * Two devices rewriting one sentence differently is the case docs/design.md
   * says diff-match-patch would "apply" cleanly into a sentence neither wrote.
   * Both versions are kept instead, and the incoming one takes the conflict
   * name so a sync never rewrites the file somebody has open.
   */
  it("keeps both versions, and both devices end up holding both", async () => {
    const { a, b } = await twoDevices();
    await write(a, "note.md", "# Note\n\nThe original sentence.\n");
    await together(a, b, 1);
    expect(await read(b, "note.md")).toBe("# Note\n\nThe original sentence.\n");

    await write(a, "note.md", "# Note\n\nA's completely different sentence.\n");
    await write(b, "note.md", "# Note\n\nB's entirely other sentence.\n");
    await together(a, b);

    // Rule 10: not that the two agree, but that neither sentence is gone.
    for (const [name, dir] of [
      ["a", a],
      ["b", b],
    ] as const) {
      const all = await everywhere(dir);
      expect(all, `${name} lost A's version`).toContain("A's completely different sentence");
      expect(all, `${name} lost B's version`).toContain("B's entirely other sentence");
    }

    // And then that they agree, which is the separate question. A conflict
    // copy that only exists on the device that made it is a note that
    // disappears the next time somebody opens the other laptop.
    const onA = await tree(a);
    const onB = await tree(b);
    expect(differences(onA, onB)).toEqual([]);
    expect(copies(onA), "no conflict copy was made").toHaveLength(1);
    expect(copies(onB)).toEqual(copies(onA));

    // Rule 6, applied to history: every version is an entry, so the server
    // holds the base and both rewrites, and says so to whichever device asks.
    // Three at least, and both devices named in them: a history that came
    // back with only the asking device's own writes would look complete and
    // be the half of the story nobody needs.
    const versions = await agreedHistory(a, b, "note.md");
    expect(versions.length, `only ${versions.length} versions of note.md`).toBeGreaterThanOrEqual(
      3,
    );
    expect([...new Set(versions.map((v) => v.device))].sort()).toEqual(["a", "b"]);
  }, 300_000);
});

describe("two devices that edited different parts of one note while apart", () => {
  it("merges them, and the merge is the same on both", async () => {
    const { a, b } = await twoDevices();
    const base = [
      "# Note",
      "",
      "First paragraph.",
      "",
      "Second paragraph.",
      "",
      "Third paragraph.",
      "",
    ].join("\n");
    await write(a, "note.md", base);
    await together(a, b, 1);

    await write(a, "note.md", base.replace("First paragraph.", "First paragraph, edited on A."));
    await write(b, "note.md", base.replace("Third paragraph.", "Third paragraph, edited on B."));
    await together(a, b);

    for (const [name, dir] of [
      ["a", a],
      ["b", b],
    ] as const) {
      const text = await read(dir, "note.md");
      expect(text, `${name} lost A's edit`).toContain("edited on A");
      expect(text, `${name} lost B's edit`).toContain("edited on B");
      // The untouched paragraph is still there, which is what distinguishes a
      // merge from one side simply winning.
      expect(text, `${name} lost the paragraph neither touched`).toContain("Second paragraph.");
    }
    const onA = await tree(a);
    expect(differences(onA, await tree(b))).toEqual([]);
    // Nothing was contested, so nothing is kept twice: a spurious conflict
    // copy for every daily note two devices both append to is its own failure.
    expect(copies(onA)).toEqual([]);
    await agreedHistory(a, b, "note.md");
  }, 300_000);
});

describe("a note one device deleted and the other edited while apart", () => {
  /**
   * A deletion can be repeated; an edit that is gone from the device that made
   * it and from the server cannot be recovered. So the edit wins, on both
   * devices, and the deletion is the thing that has to be undone.
   *
   * `engine.test.ts` pins this against in-memory vaults. On a real disk it is
   * a different question, because the note has to be written back to a path
   * this device's own index believes it deleted a moment ago.
   */
  it("keeps the edit, on the device that deleted it too", async () => {
    const { a, b } = await twoDevices();
    await write(a, "contested.md", "the original\n");
    await together(a, b, 1);
    expect(await read(b, "contested.md")).toBe("the original\n");

    await rm(join(a, "contested.md"));
    await write(b, "contested.md", "edited, and worth keeping\n");
    await together(a, b);

    expect(await read(b, "contested.md"), "the edit was deleted").toBe(
      "edited, and worth keeping\n",
    );
    expect(await read(a, "contested.md"), "the edit did not come back").toBe(
      "edited, and worth keeping\n",
    );
    expect(differences(await tree(a), await tree(b))).toEqual([]);

    // Rule 6: the deletion is an entry, not an absence, so it is still in the
    // history between the original and the edit that outlived it. A history
    // that skipped it would say the note was edited twice and never removed.
    const versions = await agreedHistory(a, b, "contested.md");
    expect(
      versions.some((v) => v.deleted),
      `no deletion in ${JSON.stringify(versions)}`,
    ).toBe(true);
    expect(versions[0]!.deleted, "the newest version is the deletion, not the edit").toBe(false);
  }, 300_000);
});

describe("a note one device moved and the other edited while apart", () => {
  /**
   * The headless client has no rename event: it scans, so a move is a delete
   * of one path and an addition of another, and that is deliberately how this
   * sets it up. What must not happen is the delete half of the move taking the
   * other device's edit with it.
   *
   * `engine.test.ts` covers a rename told to the engine (the plugin's path,
   * via `noteRename`) against a device that made no edit. This is the other
   * corner: nobody tells anything, and there is an edit in the way.
   */
  it("keeps the moved note and the edit made to it where it was", async () => {
    const { a, b } = await twoDevices();
    await write(a, "original.md", "# Notes\n\nA line that was here first.\n");
    await together(a, b, 1);
    expect(await read(b, "original.md")).toBe("# Notes\n\nA line that was here first.\n");

    // A moves it. B, not knowing, writes to where it still is.
    await rename(join(a, "original.md"), join(a, "moved.md"));
    await write(b, "original.md", "# Notes\n\nA line that was here first.\nB added this line.\n");
    await together(a, b);

    // Rule 10 again: both texts, by name, on both devices, wherever they
    // ended up. Which name holds which is the engine's business; that
    // neither is gone is not negotiable.
    for (const [name, dir] of [
      ["a", a],
      ["b", b],
    ] as const) {
      const all = await everywhere(dir);
      expect(all, `${name} lost B's edit`).toContain("B added this line.");
      expect(all, `${name} lost the moved note`).toContain("A line that was here first.");
    }
    const onA = await tree(a);
    expect(differences(onA, await tree(b))).toEqual([]);

    // Both names, on both devices, holding the right bytes. The marker
    // search above cannot tell these apart, because the moved copy and the
    // edited one share their first line: an arrival that never happened
    // would pass it and fail here.
    expect([...onA.keys()].sort()).toEqual(["moved.md", "original.md"]);
    expect(onA.get("moved.md")).toBe("# Notes\n\nA line that was here first.\n");
    expect(onA.get("original.md")).toBe(
      "# Notes\n\nA line that was here first.\nB added this line.\n",
    );

    // Both names have a story, and both devices tell the same one. The old
    // name's holds the move's half of the delete, followed by the edit that
    // outlived it, which is the record of what happened here.
    await agreedHistory(a, b, "moved.md");
    const was = await agreedHistory(a, b, "original.md");
    expect(
      was.some((v) => v.deleted),
      "the move deleted the old name and its history does not say so",
    ).toBe(true);
    expect(was[0]!.deleted, "the note is here and its newest version is a deletion").toBe(false);
  }, 300_000);
});

describe("all four divergences at once, on two real directories", () => {
  /**
   * The composition, which is the thing that had no test. Each shape above in
   * one apart-period, so they have to settle in the same passes and against
   * each other, and then the three questions asked over the whole vault rather
   * than over one path: converged, every conflict copy on both, history whole
   * from either side.
   *
   * A per-shape test can pass while the combination does not. A pass decides
   * every path before it flushes, and the deletion, the move and the two
   * merges all land in the same pass here, which is where an inbox filled part
   * way through and a delete list built from a stale set of writes have both
   * gone wrong before (C1, C2).
   */
  it("converges, holds every conflict copy on both, and keeps history whole", async () => {
    const { a, b } = await twoDevices();

    const line = "# Note\n\nThe original sentence.\n";
    const parts = ["# Parts", "", "First paragraph.", "", "Second paragraph.", ""].join("\n");
    await write(a, "same-line.md", line);
    await write(a, "different-parts.md", parts);
    await write(a, "deleted-here.md", "the original\n");
    await write(a, "folder/moved-here.md", "# Moved\n\nA line that was here first.\n");
    await together(a, b, 1);
    for (const path of [
      "same-line.md",
      "different-parts.md",
      "deleted-here.md",
      "folder/moved-here.md",
    ]) {
      expect(await read(b, path), `b never received ${path}`).toBeTruthy();
    }

    // Apart. Neither device sees any of this until the syncs below.
    await write(a, "same-line.md", "# Note\n\nA's completely different sentence.\n");
    await write(b, "same-line.md", "# Note\n\nB's entirely other sentence.\n");

    await write(
      a,
      "different-parts.md",
      parts.replace("First paragraph.", "First paragraph, edited on A."),
    );
    await write(
      b,
      "different-parts.md",
      parts.replace("Second paragraph.", "Second paragraph, edited on B."),
    );

    await rm(join(a, "deleted-here.md"));
    await write(b, "deleted-here.md", "edited on B, and worth keeping\n");

    await rename(join(a, "folder/moved-here.md"), join(a, "folder/moved-there.md"));
    await write(b, "folder/moved-here.md", "# Moved\n\nA line that was here first.\nB's line.\n");

    await together(a, b, 4);

    // 1. Every edit, by name, on both devices. Rule 10: this comes first and
    //    convergence comes second, because two devices agree perfectly when
    //    one of them has thrown an edit away.
    const wanted = [
      "A's completely different sentence",
      "B's entirely other sentence",
      "First paragraph, edited on A.",
      "Second paragraph, edited on B.",
      "edited on B, and worth keeping",
      "B's line.",
      "A line that was here first.",
    ];
    for (const [name, dir] of [
      ["a", a],
      ["b", b],
    ] as const) {
      const all = await everywhere(dir);
      for (const text of wanted) expect(all, `${name} lost "${text}"`).toContain(text);
    }

    // 2. Converged, byte for byte, and every conflict copy on both. A copy
    //    only the device that made it holds is a note that vanishes the next
    //    time somebody opens the other laptop.
    const onA = await tree(a);
    const onB = await tree(b);
    expect(differences(onA, onB)).toEqual([]);

    //    And the vault is the one it should be, named path by path. Rule 10
    //    again, one level up: `differences` is empty for two vaults that lost
    //    the same file, so agreeing is only worth anything alongside a list of
    //    what should be there. `moved-there.md` is the one this catches: the
    //    marker search
    //    above finds its text under the old name too, so a move that never
    //    arrived would pass every assertion before this one.
    expect([...onA.keys()].filter((p) => !p.includes("Conflicted copy")).sort()).toEqual([
      "deleted-here.md",
      "different-parts.md",
      "folder/moved-here.md",
      "folder/moved-there.md",
      "same-line.md",
    ]);
    // The edit outlived the deletion, and the note the mover left behind
    // holds the edit that was made to it rather than the mover's copy.
    expect(onA.get("deleted-here.md")).toBe("edited on B, and worth keeping\n");
    expect(onA.get("folder/moved-here.md")).toContain("B's line.");
    expect(onA.get("folder/moved-there.md")).toBe("# Moved\n\nA line that was here first.\n");

    //    Exactly one copy, from the device that resolved the divergence. Two
    //    would mean the same conflict was resolved twice, once on each side,
    //    which is how a vault fills with copies of copies.
    expect(copies(onA), "the same line was rewritten twice and nothing was kept").toHaveLength(1);
    expect(copies(onB)).toEqual(copies(onA));

    // 3. History, whole, from either device, for every path that has one.
    //    Asked over the resulting vault rather than a fixed list, so a path
    //    this test did not think of still has to answer.
    for (const path of [...onA.keys()].sort()) {
      const versions = await agreedHistory(a, b, path);
      expect(versions.length, `the server holds no history for ${path}`).toBeGreaterThan(0);
    }

    //    Rule 6: a deletion is an entry, not an absence. Both of these were
    //    removed on A while B was writing to them, and both survived, so
    //    each has a deletion in the middle of its story and something newer
    //    after it. A history that dropped the deletion would read as a note
    //    nobody ever removed, which is the one fact somebody reading it in
    //    order to recover from a bad delete has come to find out.
    for (const path of ["deleted-here.md", "folder/moved-here.md"]) {
      const versions = await agreedHistory(a, b, path);
      expect(
        versions.some((v) => v.deleted),
        `${path} was deleted on a and its history does not say so`,
      ).toBe(true);
      expect(versions[0]!.deleted, `${path} is here but its newest version is a deletion`).toBe(
        false,
      );
      // Both devices wrote to this path, so both are named in its past.
      expect([...new Set(versions.map((v) => v.device))].sort()).toEqual(["a", "b"]);
    }

    // 4. And the server agrees with itself about all of it.
    expect(await server.cli("verify", "-deep")).toMatch(/0 faults/);
  }, 600_000);
});
