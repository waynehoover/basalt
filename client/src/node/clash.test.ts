/**
 * A path that is a file on one device and a folder on another.
 *
 * Uncommon, and entirely possible with extensionless names: one device has a
 * note called `notes`, another makes a folder called `notes`. The in-memory
 * vault cannot show what happens, because its mkdir is a set insert and never
 * fails. A real filesystem refuses, and what the engine does with that refusal
 * is the question.
 */

import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { Client } from "../core/client.ts";
import { authToken, deriveKeys, type VaultKeys } from "../core/crypto.ts";
import { TestServer, cleanupBinary, serverBinary } from "../core/test-server.ts";
import { JsonIndexStore, NodeVault } from "./vault.ts";

let keys: VaultKeys;
beforeAll(async () => {
    await serverBinary();
    keys = await deriveKeys(new Uint8Array(20).fill(11));
}, 180_000);
afterAll(async () => await cleanupBinary());

let server: TestServer;
const open: Client[] = [];
const dirs: string[] = [];

afterEach(async () => {
    while (open.length) open.pop()!.close();
    while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true });
    if (server) await server.cleanup();
});

async function device(name: string): Promise<{ c: Client; dir: string }> {
    const dir = await mkdtemp(join(tmpdir(), `basalt-clash-${name}-`));
    dirs.push(dir);
    const c = new Client({
        vault: new NodeVault(dir),
        store: new JsonIndexStore(join(dir, ".basalt", "index.json")),
        keys,
        url: server.wsUrl,
        ...server.credentials(authToken(keys)),
        vaultId: "default",
        device: name,
        timeoutMs: 20_000,
        coalesceWrites: false,
    });
    open.push(c);
    await c.connect();
    return { c, dir };
}

/** Everything in the vault, so an assertion can say where a note ended up. */
async function contents(dir: string): Promise<string> {
    const out: string[] = [];
    const walk = async (at: string, prefix: string): Promise<void> => {
        for (const item of await readdir(at, { withFileTypes: true })) {
            if (item.name === ".basalt") continue;
            const path = prefix ? `${prefix}/${item.name}` : item.name;
            if (item.isDirectory()) {
                out.push(`${path}/`);
                await walk(join(at, item.name), path);
            } else {
                out.push(`${path}: ${(await readFile(join(at, item.name), "utf8")).trim()}`);
            }
        }
    };
    await walk(dir, "");
    return out.sort().join(" | ");
}

describe("a path that is a file here and a folder there", () => {
    it("keeps the note and settles on something", async () => {
        server = new TestServer();
        await server.start();
        const a = await device("a");
        const b = await device("b");

        // A has a note called `notes`. B makes a folder of the same name.
        const { writeFile, mkdir } = await import("node:fs/promises");
        await writeFile(join(a.dir, "notes"), "a file, not a folder\n");
        await a.c.settle();

        await mkdir(join(b.dir, "notes"));
        await writeFile(join(b.dir, "notes", "inside.md"), "in the folder\n");
        await b.c.settle();

        for (let i = 0; i < 5; i++) {
            await a.c.settle();
            await new Promise((r) => setTimeout(r, 60));
            await b.c.settle();
        }

        const reportA = await a.c.settle();
        const reportB = await b.c.settle();
        const held = await contents(a.dir);

        // Rule 1. Whatever was decided, the note A wrote is still there and
        // nothing renamed it to make room.
        expect(held, `A holds ${held}`).toContain("a file, not a folder");
        expect((await stat(join(a.dir, "notes"))).isFile()).toBe(true);

        // Neither device retries the impossible, and both say what is wrong
        // rather than going quiet about it.
        expect(reportA.retrying, `A: ${JSON.stringify(reportA)}`).toBe(0);
        expect(reportB.retrying, `B: ${JSON.stringify(reportB)}`).toBe(0);
        expect(
            reportA.skipped + reportA.blocked + reportB.skipped + reportB.blocked,
            `neither device reported the disagreement: A ${JSON.stringify(reportA)} B ${JSON.stringify(reportB)}`
        ).toBeGreaterThan(0);
    }, 300_000);

    /**
     * The same disagreement seen from the other side, which used to be worse:
     * "folder exists on both sides" was returned for a folder here and a file
     * there, so the file was never downloaded and nothing said why.
     */
    it("does not silently ignore a file it cannot make room for", async () => {
        server = new TestServer();
        await server.start();
        const a = await device("a");
        const b = await device("b");

        const { writeFile, mkdir } = await import("node:fs/promises");
        // A has a folder called `notes`; B has a note of the same name.
        await mkdir(join(a.dir, "notes"));
        await writeFile(join(a.dir, "notes", "inside.md"), "in the folder\n");
        await a.c.settle();

        await writeFile(join(b.dir, "notes"), "a file, not a folder\n");
        await b.c.settle();

        for (let i = 0; i < 5; i++) {
            await a.c.settle();
            await new Promise((r) => setTimeout(r, 60));
            await b.c.settle();
        }

        const reportA = await a.c.settle();
        const reportB = await b.c.settle();
        const held = await contents(a.dir);
        expect(held, `A holds ${held}`).toContain("notes/inside.md");
        expect((await stat(join(a.dir, "notes"))).isDirectory()).toBe(true);
        // B is the one that cannot have both, and it says so rather than
        // passing over the folder in silence, which is what it used to do.
        // Counted apart, because they are different things to be told. One
        // path can never work until somebody renames something, and one is
        // simply waiting on a name that is in the way.
        expect(
            { skipped: reportB.skipped, blocked: reportB.blocked },
            `B passed it over: ${JSON.stringify(reportB)} (A: ${JSON.stringify(reportA)})`
        ).toEqual({ skipped: 1, blocked: 1 });
    }, 300_000);

    /** And once somebody renames one of them, it syncs like anything else. */
    it("syncs once the disagreement is resolved", async () => {
        server = new TestServer();
        await server.start();
        const a = await device("a");
        const b = await device("b");

        const { writeFile, mkdir, rename } = await import("node:fs/promises");
        await writeFile(join(a.dir, "notes"), "a file, not a folder\n");
        await a.c.settle();
        await mkdir(join(b.dir, "notes"));
        await writeFile(join(b.dir, "notes", "inside.md"), "in the folder\n");
        await b.c.settle();
        for (let i = 0; i < 4; i++) {
            await a.c.settle();
            await b.c.settle();
        }
        // A renames its note out of the way, which is what it was told to do.
        await rename(join(a.dir, "notes"), join(a.dir, "notes.md"));
        for (let i = 0; i < 5; i++) {
            await a.c.settle();
            await new Promise((r) => setTimeout(r, 60));
            await b.c.settle();
        }

        const held = await contents(a.dir);
        expect(held, `A holds ${held}`).toContain("notes/inside.md");
        expect(held, `A holds ${held}`).toContain("a file, not a folder");
        const settled = await a.c.settle();
        expect(
            { skipped: settled.skipped, blocked: settled.blocked },
            "still refusing after the rename"
        ).toEqual({ skipped: 0, blocked: 0 });
    }, 300_000);
});
