/**
 * A real `cmd/basaltd` for tests to talk to.
 *
 * Not a mock and not a fixture in the usual sense: it builds the Go binary and
 * runs it. Imported by the test files rather than living in one of them, because
 * two of them need it and a second copy would drift.
 *
 * This file is only ever imported from tests, so nothing it pulls in reaches a
 * shipped bundle.
 */

import { execFile, spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { promisify } from "node:util";

const run = promisify(execFile);
const GO_DIR = new URL("../../../server", import.meta.url).pathname;

let built: Promise<string> | undefined;
let buildDir: string | undefined;

/**
 * The server binary, built once.
 *
 * `vitest.global-setup.ts` builds it before any worker starts and names it in
 * the environment, which is the ordinary path. The fallback below builds one
 * here, for a file run outside that setup.
 *
 * Built rather than assumed present either way: a test that silently skips
 * because it could not find the server is a test that reports success for
 * having done nothing.
 */
export function serverBinary(): Promise<string> {
    const shared = process.env["BASALT_TEST_BINARY"];
    if (shared) return Promise.resolve(shared);
    built ??= (async () => {
        buildDir = await mkdtemp(join(tmpdir(), "basalt-bin-"));
        const binary = join(buildDir, "basalt");
        await run("go", ["build", "-o", binary, "./cmd/basaltd"], {
            cwd: GO_DIR,
            env: { ...process.env, CGO_ENABLED: "0" },
        });
        return binary;
    })();
    return built;
}

/**
 * Removes a binary this file built.
 *
 * Never the shared one: it belongs to the whole run, and a file that deleted it
 * on its way out would break every other file still using it. That is not
 * hypothetical, it is what happens when several files run at once.
 */
export async function cleanupBinary(): Promise<void> {
    if (process.env["BASALT_TEST_BINARY"]) return;
    if (buildDir) await rm(buildDir, { recursive: true, force: true });
    buildDir = undefined;
    built = undefined;
}

/** One server, on its own port, with its own data directory. */
export class TestServer {
    private proc: ChildProcess | undefined;
    dataDir = "";
    port = 0;
    token = "";
    readonly stderr: string[] = [];

    /**
     * Starts a server, retrying if the port turned out to be taken.
     *
     * Ports come from the operating system rather than from a random number,
     * because several test files run at once and each starts servers. A random
     * port in a range collides eventually, and when it does the failure lands on
     * whichever test happened to be running: a suite that fails somewhere
     * different each time is a suite people stop believing.
     *
     * There is still a gap between releasing the port and binding it, so this
     * retries rather than pretending the gap is closed.
     */
    async start(): Promise<void> {
        let last: Error | undefined;
        for (let attempt = 0; attempt < 4; attempt++) {
            try {
                await this.startOnce();
                return;
            } catch (err) {
                last = err as Error;
                await this.stop();
                await new Promise((r) => setTimeout(r, 100 * (attempt + 1)));
            }
        }
        throw new Error(`server would not start after four attempts: ${last?.message}`);
    }

    private async startOnce(fixedPort?: number): Promise<void> {
        const binary = await serverBinary();
        if (!this.dataDir) this.dataDir = await mkdtemp(join(tmpdir(), "basalt-data-"));
        this.port = fixedPort ?? (await freePort());
        this.stderr.length = 0;
        this.proc = spawn(binary, ["serve", "-data", this.dataDir, "-addr", `127.0.0.1:${this.port}`], {
            stdio: ["ignore", "pipe", "pipe"],
        });
        this.proc.stderr?.on("data", (b: Buffer) => this.stderr.push(b.toString()));

        // Waited for rather than slept through.
        const deadline = Date.now() + 30_000;
        for (;;) {
            // A process that has already exited will never answer, and waiting
            // the full timeout to say so turns one clear error into a slow one.
            if (this.proc.exitCode !== null) {
                throw new Error(`server exited with ${this.proc.exitCode}: ${this.stderr.join("")}`);
            }
            if (Date.now() > deadline) throw new Error(`server did not start: ${this.stderr.join("")}`);
            try {
                const res = await fetch(`http://127.0.0.1:${this.port}/health`);
                if (res.ok) break;
            } catch {
                await new Promise((r) => setTimeout(r, 50));
            }
        }
        this.token = (await readFile(join(this.dataDir, "auth-token"), "utf8")).trim();
    }

    /**
     * Stops the server, runs something that needs the directory to itself, and
     * starts again on the same port.
     *
     * `purge` and `backup` take the data directory's exclusive lock, so they
     * cannot run against a live server, which is the whole point of the lock.
     * The port is kept because a client's stored config names it, and a test
     * that had to re-pair afterwards would be testing the re-pairing.
     */
    async whileStopped(fn: () => Promise<void>): Promise<void> {
        const port = this.port;
        await this.stop();
        try {
            await fn();
        } finally {
            await this.startOnce(port);
        }
    }

    /**
     * What a client should authenticate with.
     *
     * The first device to connect uses the token the server printed on its
     * first run, and offers the auth key the vault should belong to from then
     * on. Every device after that uses the key. This mirrors what the shells
     * do, and a harness that handed out the bootstrap for ever would be testing
     * a server that does not exist.
     */
    credentials(derivedAuthKey: string): { token: string; claim: string } {
        const token = this.claimed ? derivedAuthKey : this.token;
        this.claimed = true;
        return { token, claim: derivedAuthKey };
    }

    private claimed = false;

    async stop(): Promise<void> {
        if (this.proc && this.proc.exitCode === null) {
            const ended = new Promise<void>((resolve) => this.proc!.once("exit", () => resolve()));
            this.proc.kill("SIGTERM");
            await Promise.race([ended, new Promise((r) => setTimeout(r, 5000))]);
        }
        this.proc = undefined;
    }

    async cleanup(): Promise<void> {
        await this.stop();
        // Retried for the reason the afterEach in cli.test.ts is: a parallel
        // suite makes a recursive remove race its own listing. stop() waits for
        // the process to exit first, but it gives up after five seconds, and a
        // server still running is exactly when this would bite.
        if (this.dataDir) await rm(this.dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }

    /** Runs a maintenance subcommand against this server's data directory. */
    async cli(...args: string[]): Promise<string> {
        const binary = await serverBinary();
        const { stdout } = await run(binary, [...args, "-data", this.dataDir]);
        return stdout;
    }

    get wsUrl(): string {
        return `ws://127.0.0.1:${this.port}`;
    }
}

/** Waits for a condition rather than sleeping a guessed interval. */
export async function until(what: string, cond: () => boolean, ms = 15_000): Promise<void> {
    const deadline = Date.now() + ms;
    while (!cond()) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
        await new Promise((r) => setTimeout(r, 10));
    }
}

/**
 * A port nothing is listening on, chosen by the operating system.
 *
 * Binding to port 0 and reading back what was assigned, then letting go of it.
 * Not race-free, which is why `start` retries, but far better than picking a
 * number and hoping: with several test files running at once, hoping fails
 * regularly and blames whichever test was unlucky.
 */
async function freePort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const probe = createServer();
        probe.once("error", reject);
        probe.listen(0, "127.0.0.1", () => {
            const address = probe.address();
            const port = typeof address === "object" && address !== null ? address.port : 0;
            probe.close(() => (port === 0 ? reject(new Error("no free port")) : resolve(port)));
        });
    });
}
