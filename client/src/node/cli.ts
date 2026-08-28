/**
 * The headless client.
 *
 * The same engine the plugin runs, with the filesystem in place of Obsidian's
 * Vault API. Nothing in here decides anything about syncing; it reads arguments,
 * assembles the same four objects the plugin assembles, and prints what came
 * back. If this file ever grows a sync decision, it is in the wrong file.
 *
 * ## Shape
 *
 * `run` takes an argv and an output pair and returns an exit code, so a test can
 * drive the whole CLI against a real server and real directories without a
 * subprocess. `bin.ts` is the four lines that connect it to a process.
 *
 * ## What it prints
 *
 * Rule 7 of docs/philosophy.md: a status that cannot distinguish the cases it
 * collapses is not a status. So a sync never reports a total. It reports what
 * was uploaded, downloaded, merged, conflicted and skipped, separately, and it
 * exits non-zero when anything was skipped for good, because a file that will
 * never sync is not a successful run.
 */

import { hostname } from "node:os";
import { resolve } from "node:path";

import { deriveKeys, generateSecret } from "../core/crypto.ts";
import { Engine, type SyncReport } from "../core/engine.ts";
import { formatPairing, parsePairing } from "../core/pairing.ts";
import { Backoff, ProtocolError, Transport } from "../core/transport.ts";
import { JsonIndexStore, NodeVault } from "./vault.ts";
import { indexPath, loadConfig, removeState, saveConfig, type Config } from "./config.ts";

/** Where output goes, so a test can read it. */
export interface Console {
    out(line: string): void;
    err(line: string): void;
}

export const USAGE = `basalt: self-hosted sync for Obsidian

  basalt init --server URL --token TOKEN    pair this vault as the first device
  basalt pair PAIRING-STRING                pair this vault with an existing one
  basalt invite                             print the string another device needs
  basalt sync                               sync once and exit
  basalt sync --watch                       sync, then keep syncing
  basalt status                             what this device thinks the state is
  basalt unlink                             forget the pairing, keep the notes

Options
  --dir DIR        the vault (default: the current directory)
  --device NAME    what this device calls itself (default: its hostname)
  --vault-id ID    which vault on the server (default: default)
  --json           machine-readable output
  --timeout MS     how long to wait on the server (default: 30000)
`;

export async function run(argv: readonly string[], io: Console): Promise<number> {
    let args: Args;
    try {
        args = parseArgs(argv);
    } catch (err) {
        io.err(String((err as Error).message));
        return 2;
    }

    if (args.help || args.command === undefined) {
        io.out(USAGE);
        return args.command === undefined && !args.help ? 2 : 0;
    }

    try {
        switch (args.command) {
            case "init":
                return await cmdInit(args, io);
            case "pair":
                return await cmdPair(args, io);
            case "invite":
                return await cmdInvite(args, io);
            case "sync":
                return await cmdSync(args, io);
            case "status":
                return await cmdStatus(args, io);
            case "unlink":
                return await cmdUnlink(args, io);
            default:
                io.err(`no such command: ${args.command}`);
                io.err(USAGE);
                return 2;
        }
    } catch (err) {
        // Every failure arrives here as a sentence rather than a stack. A stack
        // is for a bug in this program; the common failures are a server that is
        // not running and a string that was pasted wrong, and those deserve to
        // be readable.
        const message = err instanceof Error ? err.message : String(err);
        if (args.json) io.out(JSON.stringify({ ok: false, error: message }));
        else io.err(`basalt: ${message}`);
        return 1;
    }
}

/* ---------------------------------------------------------------- *
 * Commands
 * ---------------------------------------------------------------- */

async function cmdInit(args: Args, io: Console): Promise<number> {
    if (!args.server || !args.token) throw new Error("init needs --server and --token, from the server's first run");
    if (await loadConfig(args.dir)) {
        // Re-pairing over a paired vault would replace the root secret, and
        // every note already on the server would become undecryptable here.
        throw new Error(`${args.dir} is already paired. Use unlink first if that is really what you want.`);
    }

    const config: Config = {
        url: normaliseUrl(args.server),
        token: args.token,
        vaultId: args.vaultId,
        device: args.device,
        secret: generateSecret(),
    };
    await saveConfig(args.dir, config);

    const pairing = formatPairing(config);
    if (args.json) {
        io.out(JSON.stringify({ ok: true, paired: args.dir, device: config.device, pairing }));
    } else {
        io.out(`Paired ${args.dir} as "${config.device}".`);
        io.out("");
        io.out("Give this to every other device. Anyone who has it has the vault:");
        io.out("");
        io.out(`  ${pairing}`);
        io.out("");
        io.out("It is the only copy. The server cannot reissue it, because the server");
        io.out("has never seen the secret in it.");
    }
    return 0;
}

async function cmdPair(args: Args, io: Console): Promise<number> {
    if (!args.rest[0]) throw new Error("pair needs the string another device printed");
    if (await loadConfig(args.dir)) {
        throw new Error(`${args.dir} is already paired. Use unlink first if that is really what you want.`);
    }

    const pairing = parsePairing(args.rest[0]);
    const config: Config = { ...pairing, device: args.device };
    await saveConfig(args.dir, config);

    if (args.json) io.out(JSON.stringify({ ok: true, paired: args.dir, device: config.device, url: config.url }));
    else io.out(`Paired ${args.dir} with ${config.url} as "${config.device}". Run basalt sync.`);
    return 0;
}

async function cmdInvite(args: Args, io: Console): Promise<number> {
    const config = await mustLoad(args.dir);
    const pairing = formatPairing(config);
    if (args.json) io.out(JSON.stringify({ ok: true, pairing }));
    else {
        io.out(pairing);
        io.err("Anyone who has that string has this vault.");
    }
    return 0;
}

async function cmdSync(args: Args, io: Console): Promise<number> {
    const config = await mustLoad(args.dir);
    if (args.watch) return await watchForever(config, args, io);

    const session = await open(config, args, io);
    try {
        const report = await session.settle();
        report_(report, args, io, session.serverCursor);
        // A file that can never sync is not a successful run, whatever else
        // worked. Exiting zero here is how a broken vault stays broken quietly
        // in somebody's cron.
        return report.skipped > 0 ? 1 : 0;
    } finally {
        session.close();
    }
}

/**
 * Syncs, then keeps syncing, and reconnects when the connection goes.
 *
 * The transport deliberately does not reconnect itself, because a client that
 * exits wants to fail where a client that stays wants to wait. This is the
 * second kind, so the backoff lives here.
 *
 * A network that comes and goes is the normal case for a laptop, not an error,
 * so a dropped connection is reported and retried rather than fatal. What is
 * fatal is a refusal that would fail identically forever: a bad token, or a
 * cursor the server says is impossible. Retrying those is a loop that never
 * ends and never tells anybody why.
 */
async function watchForever(config: Config, args: Args, io: Console): Promise<number> {
    const backoff = new Backoff(0, 300_000, 5_000, true);
    for (;;) {
        let session: Session | undefined;
        try {
            session = await open(config, args, io);
            backoff.success(Date.now());
            const first = await session.settle();
            report_(first, args, io, session.serverCursor);
            if (!args.json) io.err("Watching for changes. Ctrl-C to stop.");
            const cause = await session.runUntilClosed();
            io.err(`Disconnected: ${cause.message}`);
            if (cause instanceof ProtocolError && cause.fatal) {
                io.err("That will not fix itself by trying again.");
                return 1;
            }
        } catch (err) {
            const e = err as Error;
            if (e instanceof ProtocolError && e.fatal) {
                io.err(`basalt: ${e.message}`);
                return 1;
            }
            io.err(`Cannot reach the server: ${e.message}`);
        } finally {
            session?.close();
        }
        backoff.fail(Date.now());
        const wait = backoff.delay();
        io.err(`Trying again in ${Math.max(1, Math.round(wait / 1000))}s.`);
        await sleep(wait);
    }
}

async function cmdStatus(args: Args, io: Console): Promise<number> {
    const config = await mustLoad(args.dir);
    const stored = await new JsonIndexStore(indexPath(args.dir)).load();

    const local = {
        vault: args.dir,
        device: config.device,
        server: config.url,
        vaultId: config.vaultId,
        cursor: stored?.cursor ?? 0,
        tracked: stored ? Object.keys(stored.entries).length : 0,
        pending: stored?.pending.length ?? 0,
    };

    // Reachability is reported, never assumed. "up to date" from a client that
    // could not reach the server is the kind of status rule 7 is about.
    let server: { reachable: boolean; cursor?: number; behind?: number; error?: string };
    try {
        const session = await open(config, args, io);
        server = { reachable: true, cursor: session.serverCursor, behind: Math.max(0, session.serverCursor - local.cursor) };
        session.close();
    } catch (err) {
        server = { reachable: false, error: (err as Error).message };
    }

    if (args.json) {
        io.out(JSON.stringify({ ok: true, ...local, server }));
        return server.reachable ? 0 : 1;
    }

    io.out(`vault    ${local.vault}`);
    io.out(`device   ${local.device}`);
    io.out(`server   ${local.server} (vault "${local.vaultId}")`);
    io.out(`tracked  ${local.tracked} files`);
    io.out(`cursor   ${local.cursor}`);
    if (local.pending > 0) io.out(`pending  ${local.pending} files with work outstanding`);
    if (server.reachable) {
        io.out(server.behind === 0 ? "state    up to date with the server" : `state    ${server.behind} changes behind`);
        return 0;
    }
    io.out(`state    cannot reach the server: ${server.error}`);
    return 1;
}

async function cmdUnlink(args: Args, io: Console): Promise<number> {
    const config = await loadConfig(args.dir).catch(() => undefined);
    await removeState(args.dir);
    if (args.json) io.out(JSON.stringify({ ok: true, unlinked: args.dir, wasPaired: config !== undefined }));
    else {
        io.out(`Forgot the pairing for ${args.dir}. Every note is where it was.`);
        io.out("Nothing was removed from the server.");
    }
    return 0;
}

/* ---------------------------------------------------------------- *
 * Wiring
 * ---------------------------------------------------------------- */

interface Session {
    engine: Engine;
    transport: Transport;
    serverCursor: number;
    settle(): Promise<SyncReport>;
    /** Resolves with the reason when the connection ends. */
    runUntilClosed(): Promise<Error>;
    close(): void;
}

/** Assembles the four objects, which is the whole of what a shell does. */
async function open(config: Config, args: Args, io: Console): Promise<Session> {
    const keys = await deriveKeys(config.secret);
    const vault = new NodeVault(args.dir);
    const store = new JsonIndexStore(indexPath(args.dir));

    let engine!: Engine;
    let caughtUp = false;
    let ended: ((cause: Error) => void) | undefined;
    let endedWith: Error | undefined;

    const transport = new Transport(config.url, {
        onBatch: async (batch) => {
            await engine.acceptBatch(batch);
        },
        onCaughtUp: () => {
            caughtUp = true;
        },
        onClosed: (cause) => {
            endedWith = cause;
            ended?.(cause);
        },
        timeoutMs: args.timeout,
    });
    engine = new Engine({
        vault,
        store,
        keys,
        transport,
        device: config.device,
        vaultId: config.vaultId,
        token: config.token,
        // A one-shot sync does not defer a file to a next pass it will never
        // run. A watching one does, because there is one.
        coalesceWrites: args.watch,
        ...(args.verbose
            ? { log: (m: string, ...rest: unknown[]) => io.err(`  ${m} ${rest.map(brief).join(" ")}`.trimEnd()) }
            : {}),
    });

    await transport.connect();
    const limits = await engine.start();

    // Everything the server already had must arrive before the first pass
    // decides anything, or the pass sees a vault the server has files for and
    // calls them local-only.
    const deadline = Date.now() + args.timeout;
    while (!caughtUp && Date.now() < deadline) await sleep(25);
    if (!caughtUp) throw new Error("the server never finished sending what it already had");

    return {
        engine,
        transport,
        serverCursor: limits.cursor,
        async settle() {
            // Passes until one changes nothing. Downloads produce more work, and
            // an upload can be answered by a relay that needs acting on.
            //
            // The passes are added together rather than the last one returned.
            // The last pass is by construction the one that found nothing left
            // to do, so returning it would tell every successful sync that it
            // had done nothing.
            let pass = await engine.sync();
            let total = pass;
            for (let i = 0; i < 8 && didSomething(pass); i++) {
                await sleep(60);
                pass = await engine.sync();
                total = accumulate(total, pass);
            }
            return total;
        },
        async runUntilClosed() {
            if (endedWith) return endedWith;
            // The watcher says when to look and the timer is the backstop for a
            // platform where watching does not work. Neither decides anything:
            // the scan does, and it re-reads the vault every time, so a missed
            // event costs latency and never correctness.
            const stop = vault.watch?.(() => void engine.sync().catch(() => {}));
            const ticker = setInterval(() => void engine.sync().catch(() => {}), 30_000);
            try {
                return await new Promise<Error>((resolveWith) => {
                    ended = resolveWith;
                });
            } finally {
                clearInterval(ticker);
                stop?.();
            }
        },
        close() {
            transport.close();
        },
    };
}

/**
 * Adds a pass onto the running total.
 *
 * The work counters add up, because they count things that happened. The state
 * counters do not: `unchanged`, `waiting` and `skipped` describe how the vault
 * looks at the end of a pass, and summing them across passes would report one
 * unchanged file four times for having been looked at four times.
 */
function accumulate(total: SyncReport, pass: SyncReport): SyncReport {
    return {
        uploaded: total.uploaded + pass.uploaded,
        downloaded: total.downloaded + pass.downloaded,
        merged: total.merged + pass.merged,
        conflicted: total.conflicted + pass.conflicted,
        deletedLocally: total.deletedLocally + pass.deletedLocally,
        deletedRemotely: total.deletedRemotely + pass.deletedRemotely,
        restored: total.restored + pass.restored,
        foldersCreated: total.foldersCreated + pass.foldersCreated,
        chunksSent: total.chunksSent + pass.chunksSent,
        bytesSent: total.bytesSent + pass.bytesSent,
        unchanged: pass.unchanged,
        waiting: pass.waiting,
        retrying: pass.retrying,
        skipped: pass.skipped,
    };
}

function didSomething(r: SyncReport): boolean {
    return (
        r.uploaded + r.downloaded + r.merged + r.conflicted + r.deletedLocally + r.deletedRemotely + r.restored + r.foldersCreated + r.waiting >
        0
    );
}

function report_(r: SyncReport, args: Args, io: Console, serverCursor: number): void {
    if (args.json) {
        io.out(JSON.stringify({ ok: true, ...r, serverCursor }));
        return;
    }

    const lines: string[] = [];
    const say = (n: number, what: string) => {
        if (n > 0) lines.push(`${String(n).padStart(5)}  ${what}`);
    };
    say(r.uploaded, "uploaded");
    say(r.downloaded, "downloaded");
    say(r.merged, "merged");
    say(r.conflicted, "kept both versions");
    say(r.deletedLocally, "deleted here");
    say(r.deletedRemotely, "deleted on the server");
    say(r.restored, "brought back, having been edited elsewhere");
    say(r.foldersCreated, "folders created");
    say(r.waiting, "waiting for a write to settle");
    say(r.retrying, "failed, will try again");
    say(r.skipped, "cannot sync and will not be retried");

    if (lines.length === 0) {
        io.out("Nothing to do. Everything here matches the server.");
    } else {
        for (const line of lines) io.out(line);
    }
    if (r.chunksSent > 0) io.out(`${String(r.chunksSent).padStart(5)}  chunks sent, ${bytes(r.bytesSent)}`);
    if (r.conflicted > 0) io.err('Look for files with "Conflicted copy" in the name. Both versions are kept.');
}

/* ---------------------------------------------------------------- *
 * Arguments
 * ---------------------------------------------------------------- */

interface Args {
    command?: string;
    rest: string[];
    dir: string;
    device: string;
    vaultId: string;
    server?: string;
    token?: string;
    json: boolean;
    watch: boolean;
    verbose: boolean;
    help: boolean;
    timeout: number;
}

export function parseArgs(argv: readonly string[]): Args {
    const args: Args = {
        rest: [],
        dir: process.cwd(),
        device: hostname().split(".")[0] || "device",
        vaultId: "default",
        json: false,
        watch: false,
        verbose: false,
        help: false,
        timeout: 30_000,
    };

    const takes = new Set(["--dir", "--device", "--vault-id", "--server", "--token", "--timeout"]);
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i]!;
        let value: string | undefined;
        if (takes.has(arg)) {
            value = argv[++i];
            // A flag that swallowed the next flag is the classic way to end up
            // pointed at the wrong directory without noticing.
            if (value === undefined || value.startsWith("--")) throw new Error(`${arg} needs a value`);
        }
        switch (arg) {
            case "--dir": args.dir = resolve(value!); break;
            case "--device": args.device = value!; break;
            case "--vault-id": args.vaultId = value!; break;
            case "--server": args.server = value!; break;
            case "--token": args.token = value!; break;
            case "--timeout": {
                const ms = Number(value);
                if (!Number.isFinite(ms) || ms <= 0) throw new Error(`--timeout wants a number of milliseconds, not ${value}`);
                args.timeout = ms;
                break;
            }
            case "--json": args.json = true; break;
            case "--watch": args.watch = true; break;
            case "--verbose": case "-v": args.verbose = true; break;
            case "--help": case "-h": args.help = true; break;
            default:
                if (arg.startsWith("-")) throw new Error(`no such option: ${arg}`);
                if (args.command === undefined) args.command = arg;
                else args.rest.push(arg);
        }
    }
    return args;
}

/* ---------------------------------------------------------------- *
 * Small things
 * ---------------------------------------------------------------- */

async function mustLoad(dir: string): Promise<Config> {
    const config = await loadConfig(dir);
    if (!config) throw new Error(`${dir} is not paired. Run basalt init or basalt pair first.`);
    return config;
}

/**
 * Accepts what a person is likely to type and turns it into a WebSocket URL.
 *
 * `http` and `https` are accepted because that is what somebody copies out of a
 * browser, and a bare host is accepted because that is what somebody types.
 * `wss` is assumed for a bare host, because TLS is terminated in front of the
 * server and the plain case is the one worth making explicit.
 */
export function normaliseUrl(input: string): string {
    const text = input.trim().replace(/\/+$/, "");
    if (text === "") throw new Error("that is not a server address");
    if (text.startsWith("ws://") || text.startsWith("wss://")) return text;
    if (text.startsWith("http://")) return "ws://" + text.slice("http://".length);
    if (text.startsWith("https://")) return "wss://" + text.slice("https://".length);
    if (text.includes("://")) throw new Error(`a server address is ws:// or wss://, not ${text.split("://")[0]}://`);
    return "wss://" + text;
}

function bytes(n: number): string {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MiB`;
}

function brief(v: unknown): string {
    return typeof v === "string" ? v : JSON.stringify(v);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
