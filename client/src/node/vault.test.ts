import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { JsonIndexStore, NodeVault } from "./vault.ts";

let root: string;

beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "basalt-vault-"));
});

afterEach(async () => {
    await rm(root, { recursive: true, force: true });
});

const enc = new TextEncoder();
const dec = new TextDecoder();

describe("listing", () => {
    it("reports files and the folders above them", async () => {
        await mkdir(join(root, "notes", "deep"), { recursive: true });
        await writeFile(join(root, "top.md"), "top");
        await writeFile(join(root, "notes", "one.md"), "one");
        await writeFile(join(root, "notes", "deep", "two.md"), "two");

        const listed = await new NodeVault(root).list();
        const byPath = new Map(listed.map((f) => [f.path, f]));

        expect([...byPath.keys()].sort()).toEqual([
            "notes",
            "notes/deep",
            "notes/deep/two.md",
            "notes/one.md",
            "top.md",
        ]);
        expect(byPath.get("notes")?.folder).toBe(true);
        expect(byPath.get("top.md")?.folder).toBe(false);
        expect(byPath.get("top.md")?.size).toBe(3);
        expect(byPath.get("top.md")?.mtime).toBeGreaterThan(0);
    });

    it("uses forward slashes whatever the platform", async () => {
        // Paths are the vault's identity and travel between devices. A backslash
        // from one platform is a filename character on another.
        await mkdir(join(root, "a", "b"), { recursive: true });
        await writeFile(join(root, "a", "b", "c.md"), "x");
        const listed = await new NodeVault(root).list();
        expect(listed.map((f) => f.path)).toContain("a/b/c.md");
        for (const f of listed) expect(f.path).not.toContain("\\");
    });

    it("leaves the directories that must never sync alone", async () => {
        // Plugin and settings sync is refused, and .basalt is this client's own
        // bookkeeping: syncing it would sync the index to itself.
        for (const dir of [".obsidian", ".basalt", ".git", ".trash", "node_modules"]) {
            await mkdir(join(root, dir), { recursive: true });
            await writeFile(join(root, dir, "inside.md"), "x");
        }
        await writeFile(join(root, "real.md"), "x");

        const listed = await new NodeVault(root).list();
        expect(listed.map((f) => f.path)).toEqual(["real.md"]);
    });

    it("takes extra names to leave alone", async () => {
        await mkdir(join(root, "scratch"), { recursive: true });
        await writeFile(join(root, "scratch", "x.md"), "x");
        await writeFile(join(root, "keep.md"), "x");

        const listed = await new NodeVault(root, { alsoIgnore: ["scratch"] }).list();
        expect(listed.map((f) => f.path)).toEqual(["keep.md"]);
    });

    it("does not follow a symlink out of the vault", async () => {
        // Following one would sync a file that is not in the vault, and copying
        // it as a link would sync a path that means nothing anywhere else.
        const outside = await mkdtemp(join(tmpdir(), "basalt-outside-"));
        try {
            await writeFile(join(outside, "secret.md"), "not yours");
            await symlink(outside, join(root, "linked"));
            await writeFile(join(root, "real.md"), "x");

            const listed = await new NodeVault(root).list();
            expect(listed.map((f) => f.path)).toEqual(["real.md"]);
        } finally {
            await rm(outside, { recursive: true, force: true });
        }
    });

    it("refuses to report an empty vault when a directory cannot be read", async () => {
        // Rule 2: absent and unreadable are different states. Reporting the
        // second as the first would tell the engine every file in it was deleted.
        await mkdir(join(root, "locked"), { recursive: true });
        await writeFile(join(root, "locked", "note.md"), "x");
        const { chmod } = await import("node:fs/promises");
        await chmod(join(root, "locked"), 0o000);
        try {
            await expect(new NodeVault(root).list()).rejects.toThrow(/cannot read/);
        } finally {
            await chmod(join(root, "locked"), 0o755);
        }
    });
});

describe("reading and writing", () => {
    it("round trips bytes", async () => {
        const v = new NodeVault(root);
        const bytes = new Uint8Array([0, 1, 250, 255, 128]);
        await v.write("bin/file.dat", bytes, { mtime: 1_700_000_000_000, ctime: 0 });
        expect(await v.read("bin/file.dat")).toEqual(bytes);
    });

    it("creates the folders a path needs", async () => {
        const v = new NodeVault(root);
        await v.write("a/b/c/note.md", enc.encode("deep"), { mtime: 1_700_000_000_000, ctime: 0 });
        expect(dec.decode(await v.read("a/b/c/note.md"))).toBe("deep");
    });

    /**
     * The engine's decision table compares mtimes. A downloaded file stamped
     * with the moment it landed looks locally edited on the next pass, so the
     * device would upload back what it had just received, forever.
     */
    it("sets the modification time it was given", async () => {
        const v = new NodeVault(root);
        const when = 1_600_000_000_000;
        await v.write("note.md", enc.encode("x"), { mtime: when, ctime: when });
        const s = await stat(join(root, "note.md"));
        expect(Math.round(s.mtimeMs)).toBe(when);
        // And the listing agrees, which is what the engine actually reads.
        const listed = await v.list();
        expect(Math.round(listed.find((f) => f.path === "note.md")!.mtime)).toBe(when);
    });

    it("leaves no partial file and no temporary behind", async () => {
        // Written to a temporary name and renamed, so a crash or a concurrent
        // read never sees half a note.
        const v = new NodeVault(root);
        await v.write("note.md", enc.encode("complete"), { mtime: 1, ctime: 1 });
        const listed = await v.list();
        expect(listed.map((f) => f.path)).toEqual(["note.md"]);
        expect(dec.decode(await v.read("note.md"))).toBe("complete");
    });

    it("overwrites cleanly", async () => {
        const v = new NodeVault(root);
        await v.write("note.md", enc.encode("first"), { mtime: 1000, ctime: 1000 });
        await v.write("note.md", enc.encode("second"), { mtime: 2000, ctime: 1000 });
        expect(dec.decode(await v.read("note.md"))).toBe("second");
    });

    it("removes files and folders, and says a path is gone", async () => {
        const v = new NodeVault(root);
        await v.write("dir/note.md", enc.encode("x"), { mtime: 1, ctime: 1 });
        expect(await v.exists("dir/note.md")).toBe(true);

        await v.remove("dir/note.md");
        expect(await v.exists("dir/note.md")).toBe(false);

        await v.mkdir("dir2");
        expect(await v.exists("dir2")).toBe(true);
        await v.remove("dir2");
        expect(await v.exists("dir2")).toBe(false);
    });


});

describe("paths from elsewhere", () => {
    /**
     * Paths arrive from the server, sealed by another device. The seal proves
     * they came from someone holding the vault key; it does not prove that
     * device is well, and a bug on it is enough.
     */
    it("refuses to write outside the vault", async () => {
        const v = new NodeVault(root);
        const escapes = [
            "../escaped.md",
            "../../escaped.md",
            "a/../../escaped.md",
            "/etc/passwd",
            "a/b/../../../escaped.md",
        ];
        for (const path of escapes) {
            await expect(v.write(path, enc.encode("x"), { mtime: 1, ctime: 1 }), path).rejects.toThrow(
                /outside the vault/
            );
        }
        // And nothing was written above the root.
        await expect(readFile(join(root, "..", "escaped.md"), "utf8")).rejects.toThrow();
    });

    it("refuses to read, remove or make a folder outside the vault", async () => {
        const v = new NodeVault(root);
        await expect(v.read("../secret.md")).rejects.toThrow(/outside the vault/);
        await expect(v.remove("../important")).rejects.toThrow(/outside the vault/);
        await expect(v.mkdir("../elsewhere")).rejects.toThrow(/outside the vault/);
    });

    it("allows a path that merely looks alarming", async () => {
        // `..` inside a name is a filename, not a traversal, and refusing it
        // would make a legitimate note unsyncable.
        const v = new NodeVault(root);
        await v.write("notes/a..b.md", enc.encode("fine"), { mtime: 1, ctime: 1 });
        expect(dec.decode(await v.read("notes/a..b.md"))).toBe("fine");
    });
});

describe("the index on disk", () => {
    const state = (cursor: number) => ({
        cursor,
        entries: { "note.md": { path: "note.md", hash: "h" } },
        remote: { "note.md": { uid: 1 } },
        pending: ["note.md"],
    });

    it("round trips", async () => {
        const store = new JsonIndexStore(join(root, ".basalt", "index.json"));
        await store.save(state(7));
        expect(await store.load()).toEqual(state(7));
    });

    it("reports nothing when there is nothing yet", async () => {
        const store = new JsonIndexStore(join(root, ".basalt", "index.json"));
        expect(await store.load()).toBeUndefined();
    });

    /**
     * Rule 2, and the incident behind it: code that read a config file, fell
     * back to an empty result on error, and wrote that back disabled every plugin
     * on a device. An index that cannot be read must stop the run, not be
     * silently replaced with a blank one that then re-uploads the vault.
     */
    it("refuses to start from an index it cannot parse", async () => {
        const file = join(root, "index.json");
        await writeFile(file, "{ this is not json");
        await expect(new JsonIndexStore(file).load()).rejects.toThrow(/not valid JSON/);
    });

    it("refuses to start from an index it cannot read", async () => {
        const file = join(root, "index.json");
        await writeFile(file, "{}");
        const { chmod } = await import("node:fs/promises");
        await chmod(file, 0o000);
        try {
            await expect(new JsonIndexStore(file).load()).rejects.toThrow(/cannot read the index/);
        } finally {
            await chmod(file, 0o644);
        }
    });

    it("leaves the previous index intact until the new one is complete", async () => {
        // A half-written index is worse than none: no index re-reads the vault
        // and recovers, while a truncated one is read as fact.
        const file = join(root, "index.json");
        const store = new JsonIndexStore(file);
        await store.save(state(1));
        await store.save(state(2));
        expect((await store.load())?.cursor).toBe(2);
        // No temporary left behind to be mistaken for the real thing.
        const { readdir } = await import("node:fs/promises");
        expect((await readdir(root)).filter((f) => f.endsWith(".tmp"))).toEqual([]);
    });
});

/**
 * A deletion arriving over the wire was somebody's decision on another device,
 * possibly a mistaken one, and the first rule is not to lose a note.
 *
 * The Obsidian adapter has always trashed rather than deleted and this one did
 * not, which is the same defect Sync Engine had reported against it as issue
 * 232: files destroyed on one platform and trashed on another, by the same
 * sync. Found by reading their issues rather than by anything failing here.
 */
describe("deleting, which must be recoverable", () => {
    it("moves a file to the vault's trash rather than destroying it", async () => {
        const v = new NodeVault(root);
        await v.write("notes/gone.md", enc.encode("here for now"), { mtime: 1, ctime: 1 });

        await v.remove("notes/gone.md");
        expect(await v.exists("notes/gone.md")).toBe(false);
        expect(dec.decode(await readFile(join(root, ".trash", "notes", "gone.md")))).toBe("here for now");
    });

    it("moves a folder too", async () => {
        const v = new NodeVault(root);
        await v.write("folder/inside.md", enc.encode("in there"), { mtime: 1, ctime: 1 });
        await v.remove("folder");
        expect(await v.exists("folder")).toBe(false);
        expect(dec.decode(await readFile(join(root, ".trash", "folder", "inside.md")))).toBe("in there");
    });

    /**
     * Deleting, restoring and deleting again is ordinary, and the second
     * deletion overwriting the first would quietly discard a version somebody
     * might want.
     */
    it("does not overwrite what is already in the trash", async () => {
        const v = new NodeVault(root);
        await v.write("note.md", enc.encode("the first one"), { mtime: 1, ctime: 1 });
        await v.remove("note.md");
        await v.write("note.md", enc.encode("the second one"), { mtime: 2, ctime: 1 });
        await v.remove("note.md");

        const { readdir } = await import("node:fs/promises");
        const trashed = (await readdir(join(root, ".trash"))).sort();
        expect(trashed.length, `the trash holds ${JSON.stringify(trashed)}`).toBe(2);
        const contents = await Promise.all(trashed.map((f) => readFile(join(root, ".trash", f), "utf8")));
        expect(contents.sort()).toEqual(["the first one", "the second one"]);
    });

    it("keeps the trash out of the listing, so it does not sync back", async () => {
        // Otherwise what was deleted travels back out and undoes the deletion
        // on every other device in turn.
        const v = new NodeVault(root);
        await v.write("note.md", enc.encode("x"), { mtime: 1, ctime: 1 });
        await v.remove("note.md");
        await v.write("kept.md", enc.encode("y"), { mtime: 1, ctime: 1 });
        expect((await v.list()).map((f) => f.path)).toEqual(["kept.md"]);
    });

    it("removing something already gone is still not an error", async () => {
        const v = new NodeVault(root);
        await expect(v.remove("never-existed.md")).resolves.toBeUndefined();
        const { readdir } = await import("node:fs/promises");
        await expect(readdir(join(root, ".trash"))).rejects.toThrow();
    });
});
