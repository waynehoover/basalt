/**
 * Builds the Go server once for the whole suite.
 *
 * Every test file that talks to a real server used to build its own copy. With
 * fifteen files and four workers that is fifteen `go build` invocations of the
 * same package, all starting at once, all contending for the same build cache.
 * Usually wasteful and occasionally worse: the first run after a change to the
 * Go source produced a failure in whichever file lost the race.
 *
 * Building here happens before any worker starts, so the binary is simply there
 * by the time a test looks, and the path reaches the workers through the
 * environment they are forked with.
 */

import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const GO_DIR = new URL("./../go", import.meta.url).pathname;

let dir: string | undefined;

export async function setup(): Promise<void> {
    dir = await mkdtemp(join(tmpdir(), "basalt-bin-"));
    const binary = join(dir, "basalt");
    await run("go", ["build", "-o", binary, "./cmd/basalt"], {
        cwd: GO_DIR,
        env: { ...process.env, CGO_ENABLED: "0" },
    });
    process.env["BASALT_TEST_BINARY"] = binary;
}

export async function teardown(): Promise<void> {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = undefined;
}
