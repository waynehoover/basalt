/**
 * review finding C38. `removeState` removed the index and the config and proved
 * both gone, and did not sync the directory they were in, so a power cut right
 * after an unlink could bring the config back: a vault that reads as paired to
 * a server it was told to forget, with a fresh index built against it on the
 * next run.
 */

import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const synced: string[] = [];
vi.mock("./vault.ts", async (importOriginal) => {
  const real = await importOriginal<typeof import("./vault.ts")>();
  return {
    ...real,
    syncDirectory: async (dir: string) => {
      synced.push(dir);
      return real.syncDirectory(dir);
    },
  };
});

import {
  STATE_DIR,
  indexLog,
  indexPath,
  orphanedIndex,
  removeIndex,
  removeState,
  saveConfig,
} from "./config.ts";
import { generateSecret } from "../core/crypto.ts";

const dirs: string[] = [];
afterEach(async () => {
  synced.length = 0;
  while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true });
});

async function paired(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "basalt-config-"));
  dirs.push(dir);
  await saveConfig(dir, {
    url: "ws://x",
    vaultId: "default",
    device: "d",
    secret: generateSecret(),
  });
  return dir;
}

describe("forgetting a pairing, durably (C38)", () => {
  it("syncs the state directory after removing the config", async () => {
    const dir = await paired();
    synced.length = 0;
    await removeState(dir);
    expect(synced).toContain(join(dir, STATE_DIR));
  });

  it("syncs the state directory after removing the index alone", async () => {
    const dir = await paired();
    synced.length = 0;
    await removeIndex(dir);
    expect(synced).toContain(join(dir, STATE_DIR));
  });
});

/**
 * The index is two files now, and both of them are the index.
 *
 * A journal left behind after an unlink is a delta against a snapshot that no
 * longer exists, and the next load refuses to start rather than guessing at a
 * base. A rebase that left one would have the vault refuse every command until
 * somebody deleted a file nothing told them about.
 */
describe("removing an index that has a journal", () => {
  async function withIndex(): Promise<string> {
    const dir = await paired();
    await writeFile(indexPath(dir), '{"cursor":1,"entries":{},"remote":{},"pending":[],"seq":2}');
    await writeFile(indexLog(dir), "1 00000000 {}\n");
    return dir;
  }

  it("removes the journal as well, and proves it", async () => {
    const dir = await withIndex();
    await removeIndex(dir);
    await expect(stat(indexLog(dir)), "the journal outlived the index").rejects.toThrow(/ENOENT/);
    await expect(stat(indexPath(dir))).rejects.toThrow(/ENOENT/);
  });

  it("takes the journal with the rest of the state on an unlink", async () => {
    const dir = await withIndex();
    await removeState(dir);
    await expect(stat(indexLog(dir))).rejects.toThrow(/ENOENT/);
  });

  it("counts a journal on its own as an orphaned index", async () => {
    // Pairing over one would load a delta with nothing to apply it to. The
    // refusal has to name it, or the next command fails somewhere further in
    // with no way back.
    const dir = await withIndex();
    await rm(indexPath(dir));
    expect(await orphanedIndex(dir), "a journal on its own read as no index at all").toBe(true);
  });
});
