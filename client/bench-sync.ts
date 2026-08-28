/**
 * A whole vault through a real server, timed, and checked.
 *
 * `bun run bench:sync`
 *
 * The shape is borrowed from Sync Engine's benchmark harness: many small notes,
 * a few medium ones, a handful of large files, across folders several deep.
 * That distribution is closer to somebody's vault than anything this project
 * was measuring against.
 *
 * Two departures. Half the large files are incompressible, because prose is
 * what hid a defect here for months: deflate made the sealed chunk smaller than
 * the plaintext and a size bug disappeared into the saving. And correctness is
 * reported next to the timings rather than assumed, which is the good idea in
 * their harness and the reason to have read it.
 *
 * Timings here are localhost. They say what the software costs, not what a
 * network costs, and they are not comparable to a number measured over a link
 * with latency in it. docs/benchmark.md says what that means for comparisons.
 */

import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cpus, totalmem } from "node:os";

import { Client } from "./src/core/client.ts";
import { authToken, deriveKeys } from "./src/core/crypto.ts";
import { TestServer, serverBinary } from "./src/core/test-server.ts";
import { LatencyProxy, type Wire } from "./src/core/latency.ts";
import { JsonIndexStore, NodeVault } from "./src/node/vault.ts";
import type { SyncReport } from "./src/core/engine.ts";

const FOLDERS = [
    ["Daily Notes", "Projects", "Areas", "Resources", "Work", "Personal", "Ideas", "Reference", "Archive"],
    ["2024", "2025", "2026", "Current", "Backlog", "Inbox"],
    ["Inbox", "Ideas", "Weekly", "Monthly", "Research", "Notes", "Planning", "Tasks"],
    ["Q1", "Q2", "Q3", "Q4", "Design", "Engineering"],
    ["Active", "Archived", "Drafts", "Review"],
];

const scale = Number(process.env["BENCH_SCALE"] ?? 1);
const COUNTS = {
    small: Math.round(1880 * scale),
    medium: Math.round(100 * scale),
    large: Math.round(20 * scale),
};

function pathFor(kind: string, i: number, ext: string): string {
    const depth = (i + kind.length) % (FOLDERS.length + 1);
    const parts = Array.from({ length: depth }, (_, level) => {
        const choices = FOLDERS[level]!;
        return choices[(i * 7919 + kind.length * 104_729 + level * 97) % choices.length]!;
    });
    return `${parts.length ? parts.join("/") + "/" : ""}${kind}-${String(i + 1).padStart(4, "0")}.${ext}`;
}

const sizeFor = (i: number, min: number, max: number) => min + ((i * 7919) % (max - min + 1));

/**
 * Prose that compresses and does not repeat itself between files.
 *
 * The first version cycled a dozen words, so every note was nearly every other
 * note and cross-file deduplication looked like it was saving eighty per cent.
 * It was measuring the generator. On genuinely distinct notes it saves nothing
 * at all, which is the honest number and the one worth reporting.
 */
function prose(bytes: number, seed: number): string {
    const vocabulary = Array.from({ length: 5000 }, (_, i) => `w${i.toString(36)}${"aeiou"[i % 5]}`);
    const pool = new Uint32Array(4096);
    let at = pool.length;
    const next = (): number => {
        if (at >= pool.length) {
            crypto.getRandomValues(pool);
            at = 0;
        }
        return pool[at++]!;
    };
    let out = `# Note ${seed}\n\n`;
    while (out.length < bytes) {
        out += vocabulary[next() % vocabulary.length]! + (next() % 12 === 0 ? "\n" : " ");
    }
    return out.slice(0, bytes);
}

function noise(bytes: number): Uint8Array {
    const out = new Uint8Array(bytes);
    for (let at = 0; at < out.length; at += 65536) {
        crypto.getRandomValues(out.subarray(at, Math.min(at + 65536, out.length)));
    }
    return out;
}

async function buildVault(dir: string): Promise<number> {
    let total = 0;
    const write = async (path: string, body: Uint8Array | string) => {
        const full = join(dir, path);
        await mkdir(join(full, ".."), { recursive: true });
        await writeFile(full, body);
        total += typeof body === "string" ? Buffer.byteLength(body) : body.length;
    };
    for (let i = 0; i < COUNTS.small; i++) await write(pathFor("small", i, "md"), prose(sizeFor(i, 50, 50 * 1024), i));
    for (let i = 0; i < COUNTS.medium; i++) {
        await write(pathFor("medium", i, "md"), prose(sizeFor(i, 500 * 1024, 2 * 1024 * 1024), i));
    }
    for (let i = 0; i < COUNTS.large; i++) {
        const size = sizeFor(i, 4 * 1024 * 1024, 16 * 1024 * 1024);
        if (i % 2 === 0) await write(pathFor("large", i, "bin"), noise(size));
        else await write(pathFor("large", i, "md"), prose(size, i));
    }
    return total;
}

/** Every file, by path, with a hash of its bytes. */
async function contentsOf(dir: string): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    const walk = async (at: string, prefix: string): Promise<void> => {
        for (const item of await readdir(at, { withFileTypes: true })) {
            if (item.name === ".basalt" || item.name === ".trash") continue;
            const path = prefix ? `${prefix}/${item.name}` : item.name;
            if (item.isDirectory()) await walk(join(at, item.name), path);
            else {
                const body = await readFile(join(at, item.name));
                out.set(path, Buffer.from(await crypto.subtle.digest("SHA-256", body.slice().buffer as ArrayBuffer)).toString("hex"));
            }
        }
    };
    await walk(dir, "");
    return out;
}

const mib = (n: number) => (n / (1024 * 1024)).toFixed(1);
const secs = (ms: number) => (ms / 1000).toFixed(2);

function row(label: string, ms: number, r?: SyncReport, bytes?: number) {
    const rate = bytes && ms > 0 ? `${(bytes / (1024 * 1024) / (ms / 1000)).toFixed(0)} MiB/s` : "";
    const sent = r ? `${r.chunksSent} chunks, ${mib(r.bytesSent)} MiB on the wire` : "";
    console.log(`  ${label.padEnd(34)} ${secs(ms).padStart(7)} s  ${rate.padStart(10)}  ${sent}`);
}

/**
 * The wires to measure over.
 *
 * 400ms is Sync Engine's published environment, and it is here so that a figure
 * from this project can be read next to theirs without pretending the two were
 * measured together. 2.6 MiB/s is their upload speed, for the same reason.
 */
const WIRES: Array<{ name: string; wire: Wire }> = [
    { name: "loopback", wire: { rttMs: 0 } },
    { name: "20ms, a LAN or a close tailnet", wire: { rttMs: 20 } },
    { name: "100ms, a server across a country", wire: { rttMs: 100 } },
    { name: "400ms and 2.6 MiB/s", wire: { rttMs: 400, bytesPerSecond: 2.6 * 1024 * 1024 } },
];

async function main() {
    console.log("basalt: a whole vault, timed and checked");
    console.log(`  ${cpus()[0]?.model ?? "unknown cpu"}, ${cpus().length} cores, ${mib(totalmem())} MiB`);
    console.log(`  ${process.release.name} ${process.versions.bun ? "bun " + process.versions.bun : process.version}`);

    await serverBinary();
    const only = process.env["BENCH_WIRE"];
    for (const { name, wire } of WIRES) {
        if (only && !name.startsWith(only)) continue;
        console.log(`\n=== ${name} ===`);
        await run(wire);
    }
}

async function run(wire: Wire) {
    const server = new TestServer();
    await server.start();
    const proxy = new LatencyProxy("127.0.0.1", server.port, wire);
    await proxy.start();
    const keys = await deriveKeys(new Uint8Array(20).fill(31));
    const dirs: string[] = [];
    const clients: Client[] = [];

    const device = async (name: string) => {
        const dir = await mkdtemp(join(tmpdir(), `basalt-bench-${name}-`));
        dirs.push(dir);
        const c = new Client({
            vault: new NodeVault(dir),
            store: new JsonIndexStore(join(dir, ".basalt", "index.json")),
            keys,
            url: proxy.url,
            ...server.credentials(authToken(keys)),
            vaultId: "default",
            device: name,
            timeoutMs: 120_000,
            coalesceWrites: false,
            ...(process.env["BENCH_LOG"] ? { log: (m: string, ...r: unknown[]) => console.log(`    [${name}] ${m}`, ...r.slice(0, 1)) } : {}),
        });
        clients.push(c);
        await c.connect();
        return { c, dir };
    };

    try {
        const a = await device("a");
        const b = await device("b");

        const bytes = await buildVault(a.dir);
        const files = COUNTS.small + COUNTS.medium + COUNTS.large;
        console.log(`\n  ${files} files, ${mib(bytes)} MiB as the devices see it\n`);

        let t = performance.now();
        const up = await a.c.settle({}, 64);
        row("first sync, upload", performance.now() - t, up, bytes);

        t = performance.now();
        const down = await b.c.settle({}, 64);
        row("first sync, download", performance.now() - t, down, bytes);

        t = performance.now();
        const quiet = await a.c.settle({}, 4);
        row("nothing changed", performance.now() - t, quiet);

        // A day's editing: a handful of notes touched, spread through the vault
        // rather than adjacent, because adjacent files share folders and would
        // flatter the folder handling.
        const edits = Math.min(20, COUNTS.small);
        const stride = Math.max(1, Math.floor(COUNTS.small / edits));
        for (let i = 0; i < edits; i++) {
            const path = pathFor("small", i * stride, "md");
            const body = await readFile(join(a.dir, path), "utf8");
            await writeFile(join(a.dir, path), body + "\na line added today.\n");
        }
        t = performance.now();
        const daily = await a.c.settle({}, 16);
        row(`${edits} notes edited, upload`, performance.now() - t, daily);

        t = performance.now();
        const dailyDown = await b.c.settle({}, 16);
        row(`${edits} notes edited, download`, performance.now() - t, dailyDown);

        // Correctness, next to the timings rather than assumed. This is the
        // idea worth taking from Sync Engine's harness.
        const before = await contentsOf(a.dir);
        const after = await contentsOf(b.dir);
        let wrong = 0;
        for (const [path, digest] of before) if (after.get(path) !== digest) wrong++;
        const extra = [...after.keys()].filter((p) => !before.has(p)).length;

        console.log("");
        console.log(`  files sent            ${before.size}`);
        console.log(`  files arrived         ${after.size}`);
        console.log(`  wrong or missing      ${wrong}`);
        console.log(`  arrived unasked for   ${extra}`);
        console.log(`  refused for good      ${up.skipped + down.skipped + daily.skipped + dailyDown.skipped}`);
        // What latency multiplies. A design that asks once per file behaves
        // very differently on a slow wire from one that asks once per pass.
        console.log(`  round trips, upload   ${a.c.requestsSent} for ${files} files`);
        console.log(`  round trips, download ${b.c.requestsSent}`);
        console.log("");
        console.log(wrong === 0 && extra === 0 && before.size === after.size ? "  correct" : "  NOT CORRECT");
    } finally {
        for (const c of clients) c.close();
        await proxy.stop();
        await server.cleanup();
        for (const d of dirs) await rm(d, { recursive: true, force: true });
    }
}

await main();
