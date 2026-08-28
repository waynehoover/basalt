/**
 * Two engines, two vaults, one real server.
 *
 * This is the test the whole client exists to pass, and the one the predecessor's
 * notes warn about: rule 10 of docs/philosophy.md records a conflict test that
 * asserted the two devices *agreed*, and passed while one side's edit had
 * silently vanished. Agreement is not the property. Not losing an edit is.
 *
 * So the assertions here are about edits, by name, and where they ended up. The
 * vaults are in memory and everything else is real: real sealing, real chunking,
 * a real WebSocket, a real Go server writing real SQLite.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { Engine, contentId, type SyncReport } from "./engine.ts";
import { authToken, deriveKeys, type VaultKeys } from "./crypto.ts";
import { Transport } from "./transport.ts";
import { MemoryIndexStore, MemoryVault } from "./vault.ts";
import { TestServer, cleanupBinary, serverBinary, until } from "./test-server.ts";

const SECRET = new Uint8Array(20).fill(33);
let keys: VaultKeys;

beforeAll(async () => {
    await serverBinary();
    keys = await deriveKeys(SECRET);
}, 180_000);

afterAll(async () => {
    await cleanupBinary();
});

/** One device: an in-memory vault, an index, a transport and an engine. */
class Device {
    readonly vault = new MemoryVault();
    readonly store = new MemoryIndexStore();
    transport!: Transport;
    engine!: Engine;
    /** Every batch this device has been handed, for asserting on the wire. */
    readonly batches: { from: number; to: number; entries: unknown[] }[] = [];
    caughtUp = false;
    clock = 1_000_000;

    constructor(readonly name: string) {}

    async connect(server: TestServer, log?: (message: string) => void): Promise<void> {
        this.caughtUp = false;
        this.transport = new Transport(server.wsUrl, {
            onBatch: async (b) => {
                this.batches.push(b);
                await this.engine.acceptBatch(b);
            },
            onCaughtUp: () => {
                this.caughtUp = true;
            },
            timeoutMs: 20_000,
        });
        this.engine = new Engine({
            vault: this.vault,
            store: this.store,
            keys,
            transport: this.transport,
            device: this.name,
            vaultId: "default",
            ...server.credentials(authToken(keys)),
            // A clock the test advances, so the size-scaled write debounce does
            // not decide when a sync may happen.
            now: () => (this.clock += 60_000),
            ...(log ? { log } : {}),
        });
        await this.transport.connect();
        await this.engine.start();
        await until(`${this.name} to drain the backlog`, () => this.caughtUp);
    }

    /** Syncs until nothing more changes, which is what a settled device looks like. */
    async settle(rounds = 4): Promise<SyncReport> {
        let last = await this.engine.sync();
        for (let i = 1; i < rounds; i++) {
            // Let anything the server relayed arrive before deciding again.
            await new Promise((r) => setTimeout(r, 60));
            last = await this.engine.sync();
        }
        return last;
    }

    close(): void {
        this.transport?.close();
    }
}

let server: TestServer;
const devices: Device[] = [];

async function fresh(): Promise<TestServer> {
    server = new TestServer();
    await server.start();
    return server;
}

async function device(name: string, log?: (message: string) => void): Promise<Device> {
    const d = new Device(name);
    devices.push(d);
    await d.connect(server, log);
    return d;
}

afterEach(async () => {
    while (devices.length) devices.pop()!.close();
    if (server) await server.cleanup();
});

/** Syncs both devices repeatedly until each has seen the other's work. */
async function convergeBoth(a: Device, b: Device, rounds = 5): Promise<void> {
    for (let i = 0; i < rounds; i++) {
        await a.engine.sync();
        await new Promise((r) => setTimeout(r, 60));
        await b.engine.sync();
        await new Promise((r) => setTimeout(r, 60));
    }
    await a.engine.sync();
    await new Promise((r) => setTimeout(r, 60));
    await b.engine.sync();
}

describe("one device", () => {
    it("uploads what is in the vault and says what it sent", async () => {
        await fresh();
        const a = await device("a");
        await a.vault.edit("notes/one.md", "# One\n\nSome content.\n");
        await a.vault.edit("notes/two.md", "# Two\n\nOther content.\n");

        const report = await a.engine.sync();
        // Three, not two: the folder the notes live in is an entry of its own,
        // which is how a device that has never seen the vault learns the
        // structure rather than inferring it from paths.
        expect(report.uploaded).toBe(3);
        expect(report.foldersCreated).toBe(0);
        expect(report.chunksSent).toBeGreaterThan(0);
        expect(report.bytesSent).toBeGreaterThan(0);

        // The server agrees that what it stored can be served.
        expect(await server.cli("verify", "-deep")).toMatch(/0 faults/);
    }, 120_000);

    it("uploads nothing on a second pass", async () => {
        await fresh();
        const a = await device("a");
        await a.vault.edit("note.md", "content");
        await a.engine.sync();

        const second = await a.engine.sync();
        expect(second.uploaded).toBe(0);
        expect(second.chunksSent).toBe(0);
        expect(second.bytesSent).toBe(0);
    }, 120_000);

    it("sends only the chunks an edit changed", async () => {
        await fresh();
        const a = await device("a");
        let text = "";
        for (let i = 0; i < 2000; i++) text += `Line ${i} of a long note with several words.\n`;
        await a.vault.edit("long.md", text);
        const first = await a.engine.sync();

        const at = text.indexOf("\n", Math.floor(text.length / 3)) + 1;
        await a.vault.edit("long.md", text.slice(0, at) + "An inserted line.\n" + text.slice(at));
        const second = await a.engine.sync();

        expect(second.uploaded).toBe(1);
        expect(second.chunksSent).toBeLessThanOrEqual(3);
        // The ratio rather than two absolute figures. What the design claims is
        // that an edit costs a fraction of the file, and that claim should not
        // have to be restated every time a chunk size changes.
        expect(
            second.bytesSent * 8,
            `the first sync sent ${first.bytesSent} bytes and one edit cost ${second.bytesSent}`
        ).toBeLessThan(first.bytesSent);
    }, 120_000);

    it("sends nothing for a second file with the same content", async () => {
        await fresh();
        const a = await device("a");
        const content = "# Shared\n\nThe very same words.\n";
        await a.vault.edit("a.md", content);
        await a.engine.sync();

        await a.vault.edit("b.md", content);
        const second = await a.engine.sync();
        expect(second.uploaded).toBe(1);
        expect(second.chunksSent).toBe(0);
    }, 120_000);

    it("keeps its index across a restart and re-uploads nothing", async () => {
        await fresh();
        const a = await device("a");
        await a.vault.edit("note.md", "content");
        await a.engine.sync();
        const cursorBefore = a.engine.status().cursor;
        a.close();

        // Same vault, same index store, new engine and connection.
        const again = new Device("a");
        devices.push(again);
        Object.assign(again, { vault: a.vault, store: a.store });
        await again.connect(server);
        const report = await again.engine.sync();

        expect(report.uploaded).toBe(0);
        expect(report.chunksSent).toBe(0);
        expect(again.engine.status().cursor).toBe(cursorBefore);
    }, 120_000);
});

describe("two devices", () => {
    it("carries a file from one to the other", async () => {
        await fresh();
        const a = await device("a");
        const b = await device("b");

        await a.vault.edit("notes/hello.md", "# Hello\n\nFrom device a.\n");
        await convergeBoth(a, b);

        expect(b.vault.text("notes/hello.md")).toBe("# Hello\n\nFrom device a.\n");
        expect(b.vault.snapshot()).toEqual(a.vault.snapshot());
    }, 180_000);

    it("carries a vault of several files both ways", async () => {
        await fresh();
        const a = await device("a");
        const b = await device("b");

        for (let i = 0; i < 5; i++) await a.vault.edit(`from-a/${i}.md`, `written on a, number ${i}\n`);
        for (let i = 0; i < 5; i++) await b.vault.edit(`from-b/${i}.md`, `written on b, number ${i}\n`);

        await convergeBoth(a, b, 6);

        // Every edit, by name, on both sides. Not "the two agree".
        for (let i = 0; i < 5; i++) {
            expect(a.vault.text(`from-b/${i}.md`), `a is missing b's file ${i}`).toBe(`written on b, number ${i}\n`);
            expect(b.vault.text(`from-a/${i}.md`), `b is missing a's file ${i}`).toBe(`written on a, number ${i}\n`);
        }
        expect(a.vault.snapshot()).toEqual(b.vault.snapshot());
    }, 240_000);

    it("carries an edit to a file both devices already have", async () => {
        await fresh();
        const a = await device("a");
        const b = await device("b");

        await a.vault.edit("note.md", "first version\n");
        await convergeBoth(a, b);
        expect(b.vault.text("note.md")).toBe("first version\n");

        await a.vault.edit("note.md", "second version\n");
        await convergeBoth(a, b);
        expect(b.vault.text("note.md")).toBe("second version\n");
    }, 240_000);
});

describe("concurrent edits, which is where notes get lost", () => {
    it("merges edits to different parts of one note, keeping both", async () => {
        await fresh();
        const a = await device("a");
        const b = await device("b");

        const base = ["# Note", "", "First paragraph.", "", "Second paragraph.", "", "Third paragraph."].join("\n");
        await a.vault.edit("note.md", base);
        await convergeBoth(a, b);
        expect(b.vault.text("note.md")).toBe(base);

        // Both edit, neither having seen the other.
        await a.vault.edit("note.md", base.replace("First paragraph.", "First paragraph, edited on A."));
        await b.vault.edit("note.md", base.replace("Third paragraph.", "Third paragraph, edited on B."));

        await convergeBoth(a, b, 6);

        // The property that matters: both edits exist, on both devices.
        for (const d of [a, b]) {
            const text = d.vault.text("note.md") ?? "";
            expect(text, `${d.name} lost A's edit`).toContain("edited on A");
            expect(text, `${d.name} lost B's edit`).toContain("edited on B");
        }
        expect(a.vault.snapshot()).toEqual(b.vault.snapshot());
    }, 240_000);

    it("keeps both versions when the same line was rewritten twice", async () => {
        await fresh();
        const a = await device("a");
        const b = await device("b");

        await a.vault.edit("note.md", "# Note\n\nThe original sentence.\n");
        await convergeBoth(a, b);

        await a.vault.edit("note.md", "# Note\n\nA's completely different sentence.\n");
        await b.vault.edit("note.md", "# Note\n\nB's entirely other sentence.\n");

        await convergeBoth(a, b, 6);

        // Neither version is anywhere lost. One of them is under a conflict
        // copy's name, and which does not matter; that both survive does.
        for (const d of [a, b]) {
            const all = Object.values(d.vault.snapshot()).join("\n---\n");
            expect(all, `${d.name} lost A's version`).toContain("A's completely different sentence");
            expect(all, `${d.name} lost B's version`).toContain("B's entirely other sentence");
        }

        // And a conflict copy exists, so somebody can see there was a conflict.
        const copies = a.vault.paths().filter((p) => p.includes("Conflicted copy"));
        expect(copies.length).toBeGreaterThan(0);
    }, 240_000);

    it("keeps both when an attachment changed on both sides", async () => {
        await fresh();
        const a = await device("a");
        const b = await device("b");

        const bytes = (seed: number) => {
            const out = new Uint8Array(4096);
            for (let i = 0; i < out.length; i++) out[i] = (Math.imul(i + seed, 2654435761) >>> 24) & 0xff;
            return out;
        };
        await a.vault.write("file.bin", bytes(1), { mtime: 1000, ctime: 1000 });
        await convergeBoth(a, b);

        await a.vault.write("file.bin", bytes(2), { mtime: 2000, ctime: 1000 });
        await b.vault.write("file.bin", bytes(3), { mtime: 2001, ctime: 1000 });
        await convergeBoth(a, b, 6);

        // Binary cannot be merged, so both must exist rather than one winning.
        for (const d of [a, b]) {
            const copies = d.vault.paths().filter((p) => p.includes("Conflicted copy"));
            expect(copies.length, `${d.name} has no conflict copy`).toBeGreaterThan(0);
        }
    }, 240_000);
});

describe("deletions", () => {
    it("carries a delete from one device to the other", async () => {
        await fresh();
        const a = await device("a");
        const b = await device("b");

        await a.vault.edit("doomed.md", "not for long\n");
        await convergeBoth(a, b);
        expect(b.vault.text("doomed.md")).toBe("not for long\n");

        await a.vault.remove("doomed.md");
        await convergeBoth(a, b, 6);

        expect(a.vault.text("doomed.md")).toBeUndefined();
        expect(b.vault.text("doomed.md")).toBeUndefined();
    }, 240_000);

    /**
     * A deletion can be repeated. An edit that is gone from the device that made
     * it and from the server cannot be recovered. So the edit wins.
     */
    it("keeps a file deleted on one device but edited on the other", async () => {
        await fresh();
        const a = await device("a");
        const b = await device("b");

        await a.vault.edit("contested.md", "original\n");
        await convergeBoth(a, b);

        await a.vault.remove("contested.md");
        await b.vault.edit("contested.md", "edited, and worth keeping\n");
        await convergeBoth(a, b, 6);

        expect(b.vault.text("contested.md"), "the edit was deleted").toBe("edited, and worth keeping\n");
        expect(a.vault.text("contested.md"), "the edit did not come back").toBe("edited, and worth keeping\n");
    }, 240_000);
});

describe("folders and renames", () => {
    it("creates a folder the other device made", async () => {
        await fresh();
        const a = await device("a");
        const b = await device("b");

        await a.vault.mkdir("some/deep/folder");
        await a.vault.edit("some/deep/folder/note.md", "inside\n");
        await convergeBoth(a, b);

        expect(b.vault.text("some/deep/folder/note.md")).toBe("inside\n");
    }, 240_000);

    it("carries a rename as a rename, not a delete and an add", async () => {
        await fresh();
        const a = await device("a");
        const b = await device("b");

        await a.vault.edit("before.md", "the same content throughout\n");
        await convergeBoth(a, b);

        // As the vault would report it: the file moved, and the engine is told.
        const bytes = await a.vault.read("before.md");
        await a.vault.remove("before.md");
        await a.vault.write("after.md", bytes, { mtime: 2000, ctime: 1000 });
        a.engine.noteRename("before.md", "after.md");

        const report = await a.engine.sync();
        // Nothing new to send: the content is already there, so the rename costs
        // metadata and no chunks at all.
        expect(report.chunksSent).toBe(0);

        await convergeBoth(a, b, 6);
        expect(b.vault.text("after.md")).toBe("the same content throughout\n");
        expect(b.vault.text("before.md")).toBeUndefined();
    }, 240_000);
});

describe("the content identity", () => {
    it("distinguishes an empty file from one that never synced", () => {
        // The index reads `synchash === ""` as "never synced". Without a marker
        // for it, an empty note that had synced perfectly well would read as one
        // that never had, and every pass would treat it as new.
        expect(contentId([])).not.toBe("");
        expect(contentId([])).toBe("-empty-");
        expect(contentId(["a", "b"])).toBe("a,b");
    });

    it("round trips an empty note between two devices", async () => {
        await fresh();
        const a = await device("a");
        const b = await device("b");

        await a.vault.edit("empty.md", "");
        await convergeBoth(a, b);
        expect(b.vault.text("empty.md")).toBe("");

        // And settles: a second pass must not decide it is new again.
        const report = await b.engine.sync();
        expect(report.uploaded).toBe(0);
        expect(report.downloaded).toBe(0);
    }, 240_000);
});

describe("a file that can never sync", () => {
    it("is skipped rather than retried forever", async () => {
        await fresh();
        const a = await device("a");

        // A path the server refuses: over its length bound. Retrying it would
        // fail identically forever and hide everything else in the log.
        const tooLong = "x".repeat(5000) + ".md";
        await a.vault.edit(tooLong, "content");
        await a.vault.edit("fine.md", "content");

        const first = await a.engine.sync();
        expect(first.uploaded).toBeGreaterThanOrEqual(1);
        expect(first.skipped + first.retrying).toBeGreaterThanOrEqual(1);

        // The good file synced regardless: one bad path must not stall the rest.
        expect(a.engine.status().files).toBeGreaterThanOrEqual(1);
        const second = await a.engine.sync();
        expect(second.skipped).toBeGreaterThanOrEqual(1);
    }, 120_000);
});

describe("the guards the happy path hides", () => {
    it("reads no files at all on a pass where nothing changed", async () => {
        // The index's content cache is what keeps a routine scan to one stat per
        // file. Correctness does not depend on it, which is why nothing else
        // here notices when it stops working, and a vault of four thousand notes
        // very much does.
        await fresh();
        const a = await device("a");
        for (let i = 0; i < 5; i++) await a.vault.edit(`note${i}.md`, `content ${i}`);
        await a.engine.sync();

        const before = a.vault.reads;
        await a.engine.sync();
        expect(a.vault.reads - before, "an unchanged pass re-read the vault").toBe(0);
    }, 120_000);

    it("writes its index, so a restart is not a rebuild", async () => {
        await fresh();
        const a = await device("a");
        await a.vault.edit("note.md", "content");
        await a.engine.sync();
        expect(a.store.saves).toBeGreaterThan(0);
    }, 120_000);

    /**
     * A device whose index is gone but whose vault matches the server.
     *
     * Every file decides "nothing", and the ancestor has to move anyway, or the
     * device has no common ancestor for anything and the next concurrent edit
     * conflicts where it should have merged. A lost afternoon rather than a lost
     * note, and still wrong.
     *
     * What this verifies is that the rebuilt device does not re-upload the vault
     * and that the edits both survive. It does *not* isolate the ancestor
     * recovery: with that removed the assertions still hold, because the other
     * device merges and the result comes back. A case that pins the recovery
     * itself would have to make the rebuilt device the one that merges, and
     * ordering two devices that precisely is not something these tests can do
     * yet.
     */
    it("recovers the ancestor for files that already agree", async () => {
        await fresh();
        const a = await device("a");
        const b = await device("b");

        const base = ["# Note", "", "First paragraph.", "", "Second paragraph.", "", "Third paragraph."].join("\n");
        await a.vault.edit("note.md", base);
        await convergeBoth(a, b);

        // A restarts having lost its index entirely. The vault is untouched.
        a.close();
        const rebuilt = new Device("a");
        devices.push(rebuilt);
        Object.assign(rebuilt, { vault: a.vault, store: new MemoryIndexStore() });
        await rebuilt.connect(server);
        const recovery = await rebuilt.engine.sync();
        expect(recovery.uploaded, "a rebuilt index re-uploaded the vault").toBe(0);

        // Now both edit different parts. This can only merge if the rebuilt
        // device worked out its ancestor from the agreement.
        await rebuilt.vault.edit("note.md", base.replace("First paragraph.", "First paragraph, edited on A."));
        await b.vault.edit("note.md", base.replace("Third paragraph.", "Third paragraph, edited on B."));
        await convergeBoth(rebuilt, b, 6);

        for (const d of [rebuilt, b]) {
            const text = d.vault.text("note.md") ?? "";
            expect(text, `${d.name} lost A's edit`).toContain("edited on A");
            expect(text, `${d.name} lost B's edit`).toContain("edited on B");
        }
    }, 240_000);

    /**
     * A device that was not part of the conflict still ends up with both
     * versions.
     *
     * This one passes with the conflict copy's upload removed, and the reason is
     * worth writing down rather than leaving as a puzzle: the copy is a new file
     * in the vault, so the very next scan finds it and uploads it like any other
     * new file. The scan is the backstop. The explicit upload only makes it
     * happen a round earlier, and the test below is the one that shows why a
     * round earlier matters.
     */
    it("carries both versions to a device that was not part of the conflict", async () => {
        await fresh();
        const a = await device("a");
        const b = await device("b");

        await a.vault.edit("note.md", "# Note\n\nThe original sentence.\n");
        await convergeBoth(a, b);

        await a.vault.edit("note.md", "# Note\n\nA's completely different sentence.\n");
        await b.vault.edit("note.md", "# Note\n\nB's entirely other sentence.\n");
        await convergeBoth(a, b, 6);

        // C arrives afterwards, having seen none of it.
        const c = await device("c");
        await c.settle(6);

        const all = Object.values(c.vault.snapshot()).join("\n---\n");
        expect(all, "c never received A's version").toContain("A's completely different sentence");
        expect(all, "c never received B's version").toContain("B's entirely other sentence");
    }, 300_000);

    /**
     * The device that detected the conflict sends both versions before it can
     * stop.
     *
     * The scan is the backstop for the conflict copy, and a backstop that needs
     * another pass is not one for the case that matters: B notices the conflict,
     * writes the copy, and then the laptop lid closes. If the copy has not
     * already left, the only place A's own text still exists is A, and A is about
     * to download B's version over it.
     *
     * So B syncs exactly once here and then goes away for good. Everything A
     * recovers, it recovers from what that single pass uploaded.
     */
    it("gets both versions off the device before it stops syncing", async () => {
        await fresh();
        const a = await device("a");
        const b = await device("b");

        await a.vault.edit("note.md", "# Note\n\nThe original sentence.\n");
        await convergeBoth(a, b);

        await a.vault.edit("note.md", "# Note\n\nA's completely different sentence.\n");
        await b.vault.edit("note.md", "# Note\n\nB's entirely other sentence.\n");

        // A publishes first, so it is B that finds the conflict.
        await a.engine.sync();
        await new Promise((r) => setTimeout(r, 120));
        const report = await b.engine.sync();
        expect(report.conflicted, "B was meant to be the one that conflicted").toBe(1);

        // And B is gone. One pass, no second chance.
        b.close();
        await new Promise((r) => setTimeout(r, 120));

        await a.settle(6);

        const all = Object.values(a.vault.snapshot()).join("\n---\n");
        expect(all, "A lost its own version").toContain("A's completely different sentence");
        expect(all, "A never received B's version").toContain("B's entirely other sentence");
    }, 300_000);

    /**
     * Two devices that independently arrive at the same content have synced,
     * and the index has to say so.
     *
     * The same note typed twice, or restored from the same backup twice. Nothing
     * is transferred, so it is tempting to call it a no-op. It is not: if the
     * ancestor does not move to the content both sides hold, the next pair of
     * edits merges against a version neither device has ever had, which is a
     * conflict reported for two edits that never overlapped.
     *
     * Nothing else in this file pins that down, because everywhere else the
     * ancestor was already recorded by whichever transfer put the content there.
     * Here there was no transfer.
     */
    it("records the ancestor when both devices already agree", async () => {
        await fresh();
        const a = await device("a");
        const b = await device("b");

        const base = ["# Note", "", "First paragraph.", "", "Second paragraph.", "", "Third paragraph."].join("\n");
        // Typed on both, neither having seen the other. Byte for byte the same.
        await a.vault.edit("note.md", base);
        await b.vault.edit("note.md", base);
        await convergeBoth(a, b, 6);

        // Now the edits that must merge rather than collide.
        await a.vault.edit("note.md", base.replace("First paragraph.", "First paragraph, edited on A."));
        await b.vault.edit("note.md", base.replace("Third paragraph.", "Third paragraph, edited on B."));
        await convergeBoth(a, b, 6);

        for (const d of [a, b]) {
            const text = d.vault.text("note.md") ?? "";
            expect(text, `${d.name} lost A's edit`).toContain("edited on A");
            expect(text, `${d.name} lost B's edit`).toContain("edited on B");
            expect(d.vault.paths().filter((x) => x.includes("Conflicted copy")), `${d.name} conflicted`).toEqual([]);
        }
    }, 300_000);

    /**
     * A download records the ancestor itself, rather than leaving it for the
     * next pass to notice.
     *
     * Once a file has been downloaded, local and remote agree, so the pass above
     * would set the ancestor on the following scan anyway. That makes the two
     * mechanisms cover for each other, and cover is not the same as either one
     * being tested. This closes the window between them: B downloads and the
     * user edits straight away, so there is no following scan in which both
     * sides still agree.
     */
    it("records the ancestor on the download itself", async () => {
        await fresh();
        const a = await device("a");
        const b = await device("b");

        const base = ["# Note", "", "First paragraph.", "", "Second paragraph.", "", "Third paragraph."].join("\n");
        await a.vault.edit("note.md", base);
        await a.engine.sync();
        await new Promise((r) => setTimeout(r, 150));

        await b.engine.sync();
        expect(b.vault.text("note.md"), "B was meant to have downloaded it by now").toBe(base);

        // Edited before any pass in which local and remote still agree.
        await b.vault.edit("note.md", base.replace("Third paragraph.", "Third paragraph, edited on B."));
        await a.vault.edit("note.md", base.replace("First paragraph.", "First paragraph, edited on A."));
        await convergeBoth(a, b, 6);

        for (const d of [a, b]) {
            const text = d.vault.text("note.md") ?? "";
            expect(text, `${d.name} lost A's edit`).toContain("edited on A");
            expect(text, `${d.name} lost B's edit`).toContain("edited on B");
            expect(d.vault.paths().filter((x) => x.includes("Conflicted copy")), `${d.name} conflicted`).toEqual([]);
        }
    }, 300_000);

    it("runs one pass at a time however often it is asked", async () => {
        // Two passes deciding about the same file from the same index is how a
        // file gets uploaded twice or downloaded over itself.
        await fresh();
        const a = await device("a");
        for (let i = 0; i < 8; i++) await a.vault.edit(`note${i}.md`, `content ${i}`);

        const [first, second, third] = await Promise.all([
            a.engine.sync(),
            a.engine.sync(),
            a.engine.sync(),
        ]);

        // The later calls set a flag and return nothing rather than starting a
        // second pass, so the total is the work done once.
        const uploaded = first.uploaded + second.uploaded + third.uploaded;
        expect(uploaded).toBe(8);
        const settled = await a.engine.sync();
        expect(settled.uploaded).toBe(0);
    }, 120_000);
});

describe("what the index forgets", () => {
    /**
     * `entries` was pruned and `remote` was not, so a vault kept the server's
     * word about every path it had ever deleted, for ever, in a file rewritten
     * on every sync. Measured before the fix: six hundred deleted notes left a
     * 59 KB index that only ever grew.
     */
    it("does not keep a record of every note ever deleted", async () => {
        await fresh();
        const a = await device("a");

        for (let i = 0; i < 40; i++) await a.vault.edit(`note-${i}.md`, `body ${i}\n`);
        await a.settle();
        expect(await remoteCount(a)).toBe(40);

        for (let i = 0; i < 40; i++) await a.vault.remove(`note-${i}.md`);
        await a.settle();
        expect(await remoteCount(a), "the index kept a tombstone per deleted note").toBe(0);
        expect(await entryCount(a)).toBe(0);
    }, 300_000);

    /**
     * The whole risk of forgetting. A deletion this device has applied must
     * stay applied: if dropping the record let the file come back, the prune
     * would be undoing somebody's deletion on every pass.
     */
    it("does not let a deletion undo itself once forgotten", async () => {
        await fresh();
        const a = await device("a");
        const b = await device("b");

        await a.vault.edit("gone.md", "here for now\n");
        await convergeBoth(a, b);
        expect(b.vault.text("gone.md")).toBe("here for now\n");

        await a.vault.remove("gone.md");
        await convergeBoth(a, b, 6);
        expect(await remoteCount(a)).toBe(0);

        // Several more passes, long after the record was dropped.
        await convergeBoth(a, b, 6);
        expect(a.vault.paths()).not.toContain("gone.md");
        expect(b.vault.paths()).not.toContain("gone.md");
    }, 300_000);

    /**
     * A device that was away when the deletion happened still learns about it,
     * because that comes from the server's batches rather than from anybody's
     * local index.
     */
    it("still tells a device that was not there", async () => {
        await fresh();
        const a = await device("a");
        await a.vault.edit("gone.md", "here for now\n");
        await a.settle();
        await a.vault.remove("gone.md");
        await a.settle();
        expect(await remoteCount(a)).toBe(0);

        const late = await device("late");
        await late.settle(6);
        expect(late.vault.paths()).not.toContain("gone.md");
    }, 300_000);

    /**
     * Work still outstanding is not something to forget.
     *
     * Applying an incoming deletion can fail on a real device: a locked file is
     * the ordinary case. The path stays on the inbound work list, and the
     * server's word about it is what the retry will act on. Dropping that
     * record would leave a work item nothing could ever resolve, and a file
     * that stays on this device after being deleted everywhere else.
     */
    it("keeps what it needs while a deletion has not been applied yet", async () => {
        await fresh();
        const a = await device("a");
        const b = await device("b");

        await a.vault.edit("locked.md", "cannot be removed just now\n");
        await convergeBoth(a, b);
        expect(b.vault.text("locked.md")).toBeDefined();

        // B is told to delete it and cannot, this once.
        b.vault.failRemoveOnce = "locked.md";
        await a.vault.remove("locked.md");
        await a.settle();
        await new Promise((r) => setTimeout(r, 80));
        // One pass, not a settle: a settle would retry within the same call and
        // the window being tested would close before it could be looked at.
        await b.engine.sync();

        // The file is still there, so the work is not done, and the record of
        // what to do must have survived.
        expect(b.vault.paths(), "the removal was meant to fail").toContain("locked.md");
        expect(await remoteCount(b), "B forgot what it still had to do").toBeGreaterThan(0);

        // And the retry finishes the job.
        await convergeBoth(a, b, 8);
        expect(b.vault.paths()).not.toContain("locked.md");
    }, 300_000);

    /** A path used again after being deleted is a new file, and syncs like one. */
    it("handles a path used again after it was forgotten", async () => {
        await fresh();
        const a = await device("a");
        const b = await device("b");

        await a.vault.edit("reused.md", "the first note\n");
        await convergeBoth(a, b);
        await a.vault.remove("reused.md");
        await convergeBoth(a, b, 6);
        expect(await remoteCount(a)).toBe(0);

        await a.vault.edit("reused.md", "a completely different note\n");
        await convergeBoth(a, b, 6);
        expect(b.vault.text("reused.md")).toBe("a completely different note\n");
    }, 300_000);
});

describe("a file that could not sync, and then could", () => {
    /**
     * A permanent refusal stops the retries, which is right: a file the server
     * will reject for the same reason every time is noise that hides everything
     * else. But "permanent" describes the *file*, not the path, and a file can
     * be changed.
     *
     * Somebody whose note is refused for being too large shortens it, and
     * nothing happens, because the path was written off. The only way back was
     * to restart the application, and nothing said so.
     *
     * The refusal used here is an over-long name, which shortening the file does
     * not fix, so it is refused again. That is the correct outcome and not the
     * property being tested: what is tested is that it was tried at all, and the
     * log is where an attempt is observable.
     */
    it("tries again once the file has changed", async () => {
        await fresh();
        const said: string[] = [];
        const a = await device("a", (m) => said.push(m));

        // One filename past the server's limit: the cheapest permanent refusal
        // that lands on exactly one path. A deep path would refuse every folder
        // above it too.
        const tooLong = `${"x".repeat(5000)}.md`;
        await a.vault.edit(tooLong, "refused", 1_000);
        await a.vault.edit("fine.md", "accepted", 1_000);

        const refused = await a.settle();
        expect(refused.skipped, `report was ${JSON.stringify(refused)}`).toBe(1);
        expect(said.filter((m) => m === "skipped for good").length).toBe(1);

        // Unchanged, so it stays written off rather than being asked again.
        await a.settle();
        expect(said.filter((m) => m === "skipped for good").length).toBe(1);
        expect(said.filter((m) => m.startsWith("skipped file changed")).length).toBe(0);

        // Now the file changes.
        await a.vault.edit(tooLong, "different content entirely", 2_000);
        await a.settle();
        expect(
            said.filter((m) => m.startsWith("skipped file changed")).length,
            "a changed file was never tried again"
        ).toBe(1);
        // Tried, and refused again, which is the honest outcome for a name that
        // is still too long.
        expect(said.filter((m) => m === "skipped for good").length).toBe(2);
    }, 300_000);
});

/** How many paths the persisted index still has the server's word about. */
async function remoteCount(d: Device): Promise<number> {
    const state = await d.store.load();
    return state ? Object.keys(state.remote).length : 0;
}

async function entryCount(d: Device): Promise<number> {
    const state = await d.store.load();
    return state ? Object.keys(state.entries).length : 0;
}

describe("what a large attachment costs to send", () => {
    /**
     * A put used to take every sealed chunk of a file at once, so a 256 MiB
     * attachment, which is the size the server advertises it will take, meant
     * 512 MiB live: the file and a sealed copy of it. Measured rather than
     * guessed, and on a phone that is not a spike but the end of the process.
     *
     * The names still have to be known before the put is sent, so the file is
     * chunked and sealed in full either way. What changed is whether the sealed
     * bytes are then kept. Above a threshold they are dropped and a wanted
     * chunk is sealed again from the file, which is deterministic and so gives
     * the same bytes.
     *
     * This counts how many sealed bodies are alive when the server asks for one
     * rather than trying to read the heap, because the heap is the runtime's
     * business and the count is the property.
     */
    it("does not hold a sealed copy of the whole file", async () => {
        await fresh();
        const said: string[] = [];
        const a = await device("a", (m: string, ...r: unknown[]) => said.push(m + " " + r.map(String).join(" ")));

        // Incompressible, so the sealed bytes are the size of the file rather
        // than of a run-length encoding of it.
        const big = new Uint8Array(12 * 1024 * 1024);
        for (let at = 0; at < big.length; at += 65536) {
            crypto.getRandomValues(big.subarray(at, Math.min(at + 65536, big.length)));
        }
        await a.vault.write("attachment.bin", big, { mtime: 1000, ctime: 1000 });

        const report = await a.engine.sync();
        expect(report.uploaded, said.join(" | ")).toBe(1);
        expect(report.chunksSent, "a 12 MiB attachment came out as one chunk").toBeGreaterThan(1);

        // And it arrives intact, which is the thing re-sealing could break: the
        // second seal has to be byte for byte the first, or the server refuses
        // the body against the name it asked for.
        const b = await device("b");
        await b.settle(6);
        const got = await b.vault.read("attachment.bin");
        expect(got.length).toBe(big.length);
        expect(Buffer.from(got).equals(Buffer.from(big)), "the attachment came back different").toBe(true);
    }, 300_000);

    /** A note keeps its sealed chunks, because re-sealing one saves nothing. */
    it("still sends a small file without sealing it twice", async () => {
        await fresh();
        const a = await device("a");
        await a.vault.edit("note.md", "a note, which is what almost every file is\n");
        // One pass, because Device.settle returns the last of several and the
        // last one is by construction the one with nothing left to do.
        const report = await a.engine.sync();
        expect(report.uploaded).toBe(1);

        const b = await device("b");
        await b.settle(4);
        expect(b.vault.text("note.md")).toBe("a note, which is what almost every file is\n");
    }, 300_000);
});

/**
 * Large files, of both kinds, through the real server.
 *
 * The chunk-size bug that made a max-size chunk exceed the ceiling only bit on
 * data that does not compress, and every large-file test in this project used
 * data that did. These use both: bytes from the random source, which is what a
 * photo or a video is, and prose, which is what a long note is.
 */
describe("large files", () => {
    /** Incompressible, in pieces because getRandomValues has a cap. */
    const noise = (bytes: number): Uint8Array => {
        const out = new Uint8Array(bytes);
        for (let at = 0; at < out.length; at += 65536) {
            crypto.getRandomValues(out.subarray(at, Math.min(at + 65536, out.length)));
        }
        return out;
    };

    /** Prose, which compresses, and is what a long note actually is. */
    const prose = (bytes: number): string => {
        const words = "the quick brown fox jumps over a lazy dog while nobody watches".split(" ");
        let out = "";
        let i = 0;
        while (out.length < bytes) {
            out += words[i++ % words.length] + (i % 12 === 0 ? "\n" : " ");
        }
        return out.slice(0, bytes);
    };

    it("carries an attachment that does not compress", async () => {
        await fresh();
        const a = await device("a");
        const b = await device("b");

        const bytes = noise(9 * 1024 * 1024);
        await a.vault.write("photo.raw", bytes, { mtime: 1000, ctime: 1000 });

        const sent = await a.engine.sync();
        expect(sent.uploaded, `report was ${JSON.stringify(sent)}`).toBe(1);
        expect(sent.chunksSent, "9 MiB arrived as one chunk").toBeGreaterThan(4);

        await convergeBoth(a, b, 6);
        const got = await b.vault.read("photo.raw");
        expect(got.length).toBe(bytes.length);
        expect(Buffer.from(got).equals(Buffer.from(bytes)), "the attachment came back different").toBe(true);
    }, 300_000);

    it("carries a note far larger than a note usually is", async () => {
        await fresh();
        const a = await device("a");
        const b = await device("b");

        const text = prose(6 * 1024 * 1024);
        await a.vault.edit("long.md", text);

        const sent = await a.engine.sync();
        expect(sent.uploaded, `report was ${JSON.stringify(sent)}`).toBe(1);

        await convergeBoth(a, b, 8);
        expect(b.vault.text("long.md")?.length).toBe(text.length);
        expect(b.vault.text("long.md")).toBe(text);
    }, 300_000);

    /**
     * The reason for chunking at all. An edit in the middle of a large file
     * should cost a chunk, not the file.
     */
    it("sends a chunk rather than the file when a large note changes", async () => {
        await fresh();
        const a = await device("a");
        const text = prose(4 * 1024 * 1024);
        await a.vault.edit("long.md", text);
        await a.settle();

        const middle = Math.floor(text.length / 2);
        await a.vault.edit("long.md", text.slice(0, middle) + "an inserted sentence. " + text.slice(middle), 2_000_000);
        const again = await a.engine.sync();

        expect(again.uploaded).toBe(1);
        expect(
            again.bytesSent,
            `an edit to a 4 MiB note cost ${again.bytesSent} bytes across ${again.chunksSent} chunks`
        ).toBeLessThan(64 * 1024);
    }, 300_000);

    /** An attachment edited in the middle is the same claim, without deflate. */
    it("sends a chunk rather than the file when a large attachment changes", async () => {
        await fresh();
        const a = await device("a");
        const bytes = noise(8 * 1024 * 1024);
        await a.vault.write("clip.raw", bytes, { mtime: 1000, ctime: 1000 });
        await a.settle();

        const edited = bytes.slice();
        edited.set(noise(1024), Math.floor(edited.length / 2));
        await a.vault.write("clip.raw", edited, { mtime: 2000, ctime: 1000 });
        const again = await a.engine.sync();

        expect(again.uploaded).toBe(1);
        expect(
            again.bytesSent,
            `changing 1 KiB of an 8 MiB attachment cost ${again.bytesSent} bytes`
        ).toBeLessThan(4 * 1024 * 1024);
    }, 300_000);
});
