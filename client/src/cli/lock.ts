/**
 * One process per vault, for anything that changes it.
 *
 * The headless client had no idea whether another of itself was running. Two
 * `sync --watch` instances, a cron `sync` beside a watcher, or an `unlink`
 * racing a pass could each load the index, decide from it, and write notes,
 * the config and the index over each other from state the other never saw.
 * The engine's single-flight rule holds inside one process and nowhere else.
 *
 * So a lock file, taken with `wx` so that creating it is the test for whether
 * it exists. It names its holder, because a refusal that cannot say who holds
 * the vault leaves a person guessing at which terminal to look in, and a
 * holder that has died is recognised by its pid and replaced rather than
 * waited on for ever.
 */

import { mkdir, open, readFile, rm } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";

import { STATE_DIR } from "./config.ts";

export const lockPath = (vault: string) => join(vault, STATE_DIR, "lock");

/** What the lock file says about who holds it. */
export interface LockHolder {
  readonly pid: number;
  readonly host: string;
  readonly command: string;
  /** Milliseconds since the epoch. */
  readonly since: number;
}

/**
 * Takes the vault's lock, or refuses with the holder's name.
 *
 * Returns the release. A holder on this host whose process is gone is a lock
 * left behind by a crash or a kill, and is taken over. A holder on another
 * host cannot be checked, so it is believed: a vault on a shared disk with two
 * machines pointing at it is exactly the case the lock is for.
 */
export async function lockVault(vault: string, command: string): Promise<() => Promise<void>> {
  const path = lockPath(vault);
  await mkdir(join(vault, STATE_DIR), { recursive: true });
  const mine: LockHolder = { pid: process.pid, host: hostname(), command, since: Date.now() };

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const handle = await open(path, "wx");
      try {
        await handle.writeFile(JSON.stringify(mine));
      } finally {
        await handle.close();
      }
      return async () => {
        // Only if it is still ours. A stale takeover between our crash and
        // this release would otherwise remove somebody else's lock.
        const now = await readHolder(path);
        if (now?.pid === mine.pid && now.host === mine.host) await rm(path, { force: true });
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }

    const holder = await readHolder(path);
    if (holder === undefined) {
      // Created and removed between our attempt and our read, or unreadable
      // as JSON. Either way it is not a holder that can be named; try once
      // more rather than guessing.
      await rm(path, { force: true });
      continue;
    }
    if (holder.host === mine.host && !alive(holder.pid)) {
      // Left behind. Taking it over is safe because the process that wrote
      // it cannot be doing anything any more.
      await rm(path, { force: true });
      continue;
    }
    throw new Error(
      `another basalt is using this vault: ${holder.command} (pid ${holder.pid} on ${holder.host}, ` +
        `since ${new Date(holder.since).toISOString()}). Wait for it to finish, or stop it.`,
    );
  }
  throw new Error(`could not take the lock at ${path}: something keeps recreating it`);
}

async function readHolder(path: string): Promise<LockHolder | undefined> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
  try {
    const raw = JSON.parse(text) as Partial<LockHolder>;
    if (typeof raw.pid !== "number" || typeof raw.host !== "string") return undefined;
    return {
      pid: raw.pid,
      host: raw.host,
      command: typeof raw.command === "string" ? raw.command : "unknown command",
      since: typeof raw.since === "number" ? raw.since : 0,
    };
  } catch {
    return undefined;
  }
}

/** Whether a process on this host is still running. EPERM means it is, and is not ours. */
export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== "ESRCH";
  }
}
