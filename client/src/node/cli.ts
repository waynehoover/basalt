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
import { Client, runForever, type ClientOptions } from "../core/client.ts";
import type { SyncReport } from "../core/engine.ts";
import { formatPairing, normaliseUrl, parsePairing } from "../core/pairing.ts";

export { normaliseUrl };
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
  basalt deleted                            notes the server still has and you do not
  basalt history PATH                       every version the server holds of one note
  basalt restore PATH                       put a note back, newest version first
  basalt unlink                             forget the pairing, keep the notes

Options
  --dir DIR        the vault (default: the current directory)
  --device NAME    what this device calls itself (default: its hostname)
  --vault-id ID    which vault on the server (default: default)
  --json           machine-readable output
  --timeout MS     how long to wait on the server (default: 30000)
  --uid N          restore one exact version, from basalt history
  --to PATH        restore somewhere other than where it came from
  --limit N        how many versions history shows (default: 20)
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
            case "deleted":
                return await cmdDeleted(args, io);
            case "history":
                return await cmdHistory(args, io);
            case "restore":
                return await cmdRestore(args, io);
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

    const client = await open(config, args, io);
    try {
        const report = await client.settle();
        report_(report, args, io, client.serverCursor);
        // A file that can never sync is not a successful run, whatever else
        // worked. Exiting zero here is how a broken vault stays broken quietly
        // in somebody's cron.
        return report.skipped > 0 ? 1 : 0;
    } finally {
        client.close();
    }
}

/**
 * Syncs, then keeps syncing.
 *
 * The reconnecting is `runForever` in core, because the plugin needs exactly the
 * same loop for exactly the same reasons. What is left here is what a shell
 * should own: deciding what to print.
 */
async function watchForever(config: Config, args: Args, io: Console): Promise<number> {
    let fatal: Error | undefined;
    await runForever(await clientOptions(config, args, io), {
        onSynced: (report, serverCursor) => {
            report_(report, args, io, serverCursor);
            if (!args.json) io.err("Watching for changes. Ctrl-C to stop.");
        },
        onDisconnected: (cause, retryIn) => {
            io.err(`Disconnected: ${cause.message}. Trying again in ${seconds(retryIn)}.`);
        },
        onUnreachable: (cause, retryIn) => {
            io.err(`Cannot reach the server: ${cause.message}. Trying again in ${seconds(retryIn)}.`);
        },
        onFatal: (cause) => {
            fatal = cause;
        },
    });
    if (fatal) {
        io.err(`basalt: ${fatal.message}`);
        io.err("That will not fix itself by trying again.");
        return 1;
    }
    return 0;
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
        const client = await open(config, args, io);
        server = { reachable: true, cursor: client.serverCursor, behind: Math.max(0, client.serverCursor - local.cursor) };
        client.close();
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

/* ---------------------------------------------------------------- *
 * Recovery
 * ---------------------------------------------------------------- */

/**
 * Notes the server still holds and this vault does not.
 *
 * The whole point of keeping every version is that this list exists. Until it
 * did, a deleted note was safe and unreachable, which is only half a promise.
 */
async function cmdDeleted(args: Args, io: Console): Promise<number> {
    const config = await mustLoad(args.dir);
    const client = await open(config, args, io);
    try {
        const gone = await client.deleted(args.limit > 20 ? args.limit : undefined);
        if (args.json) {
            io.out(JSON.stringify({ ok: true, deleted: gone.notes, more: gone.more }));
            return 0;
        }
        if (gone.notes.length === 0) {
            io.out("Nothing has been deleted from this vault.");
            return 0;
        }
        for (const v of gone.notes) {
            io.out(`${when(v.mtime)}  ${v.device.padEnd(12)}  ${v.path}`);
        }
        io.out("");
        io.out(`${gone.notes.length} deleted, all still recoverable. basalt restore PATH brings one back.`);
        // Never a short list that looks complete. Somebody reading one and not
        // finding their note concludes it is gone.
        if (gone.more) io.out("There are older deletions than these. --limit N shows more.");
        return 0;
    } finally {
        client.close();
    }
}

/** Every version of one note, newest first. */
async function cmdHistory(args: Args, io: Console): Promise<number> {
    const path = args.rest[0];
    if (!path) throw new Error("history needs the path of a note");
    const config = await mustLoad(args.dir);
    const client = await open(config, args, io);
    try {
        const versions = await client.history(path, { limit: args.limit });
        if (args.json) {
            io.out(JSON.stringify({ ok: true, path, versions }));
            return 0;
        }
        if (versions.length === 0) {
            // The server cannot tell a path it never had from one whose history
            // was purged, so neither can this. Saying which would be a guess in
            // the one tool where a guess is least welcome.
            io.out(`The server holds no versions of ${path}.`);
            return 0;
        }
        for (const v of versions) {
            const what = v.deleted ? "deleted" : v.folder ? "folder" : `${bytes(v.size)}`;
            io.out(`${String(v.uid).padStart(7)}  ${when(v.mtime)}  ${v.device.padEnd(12)}  ${what}`);
        }
        io.out("");
        io.out("basalt restore PATH --uid N brings one of these back.");
        return 0;
    } finally {
        client.close();
    }
}

/**
 * Puts a note back.
 *
 * Never overwrites. If something already occupies the path, the restored copy
 * lands beside it and both are reported: a recovery tool that can destroy the
 * thing you still have is worse than none.
 */
async function cmdRestore(args: Args, io: Console): Promise<number> {
    const path = args.rest[0];
    if (!path) throw new Error("restore needs the path of a note");
    const config = await mustLoad(args.dir);
    const client = await open(config, args, io);
    try {
        let version;
        if (args.uid !== undefined) {
            const versions = await client.history(path, { limit: 500 });
            version = versions.find((v) => v.uid === args.uid);
            if (!version) throw new Error(`the server has no version ${args.uid} of ${path}`);
            // Whether that version can be restored is Client.restore's to say,
            // and it says it. A second check here would be a duplicate that no
            // test could pin: remove either one and the other still refuses.
        } else {
            version = await client.newestContentVersion(path);
            if (!version) throw new Error(`the server holds no version of ${path} with any content in it`);
        }

        const done = await client.restore(version, args.to);
        // Sent straight away rather than left for the next sync. Somebody who
        // has just recovered a note should not have to know that it is only on
        // this device until something else happens.
        const report = await client.settle({ coalesceWrites: false });

        if (args.json) {
            // `restored` is already a counter on the report, so the path is `path`.
            io.out(JSON.stringify({ ok: true, path: done.path, uid: version.uid, bytes: done.bytes, sync: report }));
            return 0;
        }
        io.out(`Restored version ${version.uid} of ${path} (${bytes(done.bytes)}, from ${when(version.mtime)}).`);
        if (done.path !== (args.to ?? path)) {
            io.out(`Written to ${done.path}, because something is already at ${args.to ?? path}.`);
        }
        if (report.uploaded > 0) io.out("Sent to the server, so your other devices will pick it up.");
        return 0;
    } finally {
        client.close();
    }
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

/** Assembles the four objects, which is the whole of what a shell does. */
async function open(config: Config, args: Args, io?: Console): Promise<Client> {
    const client = new Client(await clientOptions(config, args, io));
    await client.connect();
    return client;
}

async function clientOptions(config: Config, args: Args, io?: Console): Promise<ClientOptions> {
    return {
        vault: new NodeVault(args.dir),
        store: new JsonIndexStore(indexPath(args.dir)),
        keys: await deriveKeys(config.secret),
        url: config.url,
        token: config.token,
        vaultId: config.vaultId,
        device: config.device,
        timeoutMs: args.timeout,
        // A one-shot sync does not defer a file to a next pass it will never
        // run. A watching one does, because there is one.
        coalesceWrites: args.watch,
        ...(args.verbose && io
            ? { log: (m: string, ...rest: unknown[]) => io.err(`  ${m} ${rest.map(brief).join(" ")}`.trimEnd()) }
            : {}),
    };
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
    uid?: number;
    to?: string;
    limit: number;
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
        limit: 20,
        verbose: false,
        help: false,
        timeout: 30_000,
    };

    const takes = new Set(["--dir", "--device", "--vault-id", "--server", "--token", "--timeout", "--uid", "--to", "--limit"]);
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
            case "--uid": {
                const uid = Number(value);
                if (!Number.isInteger(uid) || uid <= 0) throw new Error(`--uid wants a version number, not ${value}`);
                args.uid = uid;
                break;
            }
            case "--to": args.to = value!; break;
            case "--limit": {
                const limit = Number(value);
                if (!Number.isInteger(limit) || limit <= 0) throw new Error(`--limit wants a count, not ${value}`);
                args.limit = limit;
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


/** A timestamp somebody can read, which is the point of a recovery listing. */
function when(ms: number): string {
    if (!Number.isFinite(ms) || ms <= 0) return "unknown         ";
    const d = new Date(ms);
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function seconds(ms: number): string {
    return `${Math.max(1, Math.round(ms / 1000))}s`;
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
