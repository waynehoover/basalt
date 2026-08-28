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
import { deriveKeys, type VaultKeys } from "./crypto.ts";
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

    async connect(server: TestServer): Promise<void> {
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
            token: server.token,
            // A clock the test advances, so the size-scaled write debounce does
            // not decide when a sync may happen.
            now: () => (this.clock += 60_000),
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

async function device(name: string): Promise<Device> {
    const d = new Device(name);
    devices.push(d);
    await d.connect(server);
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
        expect(second.bytesSent).toBeLessThan(4096);
        expect(first.bytesSent).toBeGreaterThan(15_000);
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
     * Being straight about what this does and does not pin down: it passes with
     * the conflict copy's upload removed, so it is not a test *of* that upload.
     * Some other path carries both versions here, and which one has not been
     * established. The upload stays because a third device having only the
     * version that won the real path is the obvious failure and is what it
     * exists to prevent; what is missing is a case that isolates it.
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
