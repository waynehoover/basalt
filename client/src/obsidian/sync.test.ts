/**
 * Two Obsidian vaults, through a real server.
 *
 * The engine tests do this with in-memory vaults, which is what makes them fast
 * enough to run a mutation pass over. The CLI test does it with real directories
 * on a disk. This is the third adapter, and until this file existed nothing had
 * ever run the engine against Obsidian's interface at all.
 *
 * Everything here is real except Obsidian: real sealing, real chunking, a real
 * WebSocket, a real Go server writing real SQLite. What is faked is
 * `DataAdapter`, and `fake.ts` says what that is worth and what it is not.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { Client } from "../core/client.ts";
import { deriveKeys, type VaultKeys } from "../core/crypto.ts";
import { TestServer, cleanupBinary, serverBinary } from "../core/test-server.ts";
import { FakeAdapter } from "./fake.ts";
import { ObsidianIndexStore, ObsidianVault } from "./vault.ts";

const SECRET = new Uint8Array(20).fill(77);
let keys: VaultKeys;

beforeAll(async () => {
    await serverBinary();
    keys = await deriveKeys(SECRET);
}, 180_000);

afterAll(async () => {
    await cleanupBinary();
});

/** One device: a fake Obsidian vault, and the same Client both shells use. */
class Device {
    readonly adapter = new FakeAdapter();
    client!: Client;

    constructor(readonly name: string) {}

    async connect(server: TestServer): Promise<void> {
        this.client = new Client({
            vault: new ObsidianVault(this.adapter, ".obsidian"),
            // Where the plugin puts it: inside its own folder, under
            // `.obsidian`, which never syncs.
            store: new ObsidianIndexStore(this.adapter, ".obsidian/plugins/basalt/index.json"),
            keys,
            url: server.wsUrl,
            token: server.token,
            vaultId: "default",
            device: this.name,
            timeoutMs: 20_000,
            // These tests drive discrete syncs, so there is no next pass for the
            // write debounce to defer to. The plugin leaves it on, because a
            // plugin does have one.
            coalesceWrites: false,
        });
        await this.client.connect();
    }

    close(): void {
        this.client?.close();
    }

    /** Everything a person would see in the vault, ignoring the plugin's own state. */
    notes(): string[] {
        return this.adapter.filePaths().filter((p) => !p.startsWith(".obsidian/") && !p.startsWith(".trash/"));
    }

    text(path: string): string | undefined {
        return this.adapter.text(path);
    }
}

let server: TestServer;
const devices: Device[] = [];

async function fresh(): Promise<void> {
    server = new TestServer();
    await server.start();
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

/** Syncs both until each has seen the other's work. */
async function converge(a: Device, b: Device, rounds = 5): Promise<void> {
    for (let i = 0; i < rounds; i++) {
        await a.client.settle();
        await new Promise((r) => setTimeout(r, 60));
        await b.client.settle();
        await new Promise((r) => setTimeout(r, 60));
    }
}

describe("a vault reaching another device", () => {
    it("carries notes, folders and an attachment", async () => {
        await fresh();
        const a = await device("a");
        const b = await device("b");

        a.adapter.seed("Meeting notes.md", "# Meeting\n\nDiscussed the thing.\n");
        a.adapter.seed("Projects/Basalt.md", "# Basalt\n\nA sync tool.\n");
        const bytes = new Uint8Array(5000);
        for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 37) & 0xff;
        await a.adapter.writeBinary("attachment.bin", bytes.slice().buffer as ArrayBuffer, { mtime: 1000 });

        await converge(a, b);

        expect(b.notes().sort()).toEqual(["Meeting notes.md", "Projects/Basalt.md", "attachment.bin"]);
        expect(b.text("Meeting notes.md")).toBe("# Meeting\n\nDiscussed the thing.\n");
        expect(b.text("Projects/Basalt.md")).toBe("# Basalt\n\nA sync tool.\n");
        expect([...new Uint8Array(await b.adapter.readBinary("attachment.bin"))]).toEqual([...bytes]);
        // And the folder came too, so an empty one would as well.
        expect(await b.adapter.exists("Projects")).toBe(true);
    }, 300_000);

    /**
     * The bug this whole file was written to find, end to end.
     *
     * `normalizePath` rewrites a non-breaking space, and the first version of
     * the adapter dropped such a note from its listing without a word. It would
     * never have synced.
     */
    it("carries a note whose name Obsidian would rewrite", async () => {
        await fresh();
        const a = await device("a");
        const b = await device("b");

        a.adapter.seed("Q1 review.md", "the note with a non-breaking space");
        a.adapter.seed("ordinary.md", "the other one");
        await converge(a, b);

        expect(b.notes().length, "a note went missing on the way").toBe(2);
        const carried = b.notes().find((p) => p !== "ordinary.md")!;
        expect(b.text(carried)).toBe("the note with a non-breaking space");
    }, 300_000);

    it("never sends what must never sync", async () => {
        await fresh();
        const a = await device("a");
        const b = await device("b");

        a.adapter.seed(".obsidian/workspace.json", "{}");
        a.adapter.seed(".obsidian/plugins/other/main.js", "// not yours");
        a.adapter.seed("real.md", "x");
        await converge(a, b);

        // One device disabling every plugin on another is where that rule came
        // from, and the index living under .obsidian is why it matters here.
        expect(b.notes()).toEqual(["real.md"]);
        expect(await b.adapter.exists(".obsidian/workspace.json")).toBe(false);
    }, 300_000);

    it("carries an edit back the other way", async () => {
        await fresh();
        const a = await device("a");
        const b = await device("b");

        a.adapter.seed("note.md", "first\n");
        await converge(a, b);
        expect(b.text("note.md")).toBe("first\n");

        b.adapter.seed("note.md", "second\n", 2_000_000);
        await converge(a, b);
        expect(a.text("note.md")).toBe("second\n");
    }, 300_000);

    /**
     * A deletion arriving over the wire goes to the trash rather than away. It
     * was somebody's decision on another device, possibly a mistaken one.
     */
    it("carries a deletion, into the trash", async () => {
        await fresh();
        const a = await device("a");
        const b = await device("b");

        a.adapter.seed("doomed.md", "here for now\n");
        await converge(a, b);
        expect(b.text("doomed.md")).toBe("here for now\n");

        await a.adapter.remove("doomed.md");
        await converge(a, b);

        expect(b.notes()).not.toContain("doomed.md");
        expect(b.adapter.trashedLocally).toContain("doomed.md");
        // Recoverable by hand, and not syncing back out to undo the deletion
        // everywhere else.
        expect(b.adapter.text(".trash/doomed.md")).toBe("here for now\n");
    }, 300_000);

    it("merges edits to different parts of one note", async () => {
        await fresh();
        const a = await device("a");
        const b = await device("b");

        const base = ["# Note", "", "First paragraph.", "", "Second paragraph.", "", "Third paragraph."].join("\n");
        a.adapter.seed("note.md", base);
        await converge(a, b);

        a.adapter.seed("note.md", base.replace("First paragraph.", "First paragraph, edited on A."), 2_000_000);
        b.adapter.seed("note.md", base.replace("Third paragraph.", "Third paragraph, edited on B."), 2_000_000);
        await converge(a, b, 6);

        for (const d of [a, b]) {
            const text = d.text("note.md") ?? "";
            expect(text, `${d.name} lost A's edit`).toContain("edited on A");
            expect(text, `${d.name} lost B's edit`).toContain("edited on B");
        }
    }, 300_000);

    /**
     * Rule 10: the property is not that the two devices agree, it is that
     * neither edit was lost. Both are asserted by name.
     */
    it("keeps both versions when the same line was rewritten twice", async () => {
        await fresh();
        const a = await device("a");
        const b = await device("b");

        a.adapter.seed("note.md", "# Note\n\nThe original sentence.\n");
        await converge(a, b);

        a.adapter.seed("note.md", "# Note\n\nA's completely different sentence.\n", 2_000_000);
        b.adapter.seed("note.md", "# Note\n\nB's entirely other sentence.\n", 2_000_000);
        await converge(a, b, 6);

        for (const d of [a, b]) {
            const all = d.notes().map((p) => d.text(p)).join("\n---\n");
            expect(all, `${d.name} lost A's version`).toContain("A's completely different sentence");
            expect(all, `${d.name} lost B's version`).toContain("B's entirely other sentence");
            expect(d.notes().some((p) => p.includes("Conflicted copy")), `${d.name} has no copy`).toBe(true);
        }
    }, 300_000);

    it("does not upload back what it just downloaded", async () => {
        // The adapter sets the mtime it was given for exactly this reason. A
        // file stamped with the moment it landed looks locally edited on the
        // next pass, and the two devices push it back and forth forever.
        await fresh();
        const a = await device("a");
        const b = await device("b");

        a.adapter.seed("note.md", "settled\n");
        await converge(a, b);

        const quiet = await b.client.settle();
        expect(quiet.uploaded).toBe(0);
        expect(quiet.downloaded).toBe(0);
        expect(quiet.chunksSent).toBe(0);
    }, 300_000);
});
