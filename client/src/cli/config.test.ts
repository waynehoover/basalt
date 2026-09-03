/**
 * review finding C38. `removeState` removed the index and the config and proved
 * both gone, and did not sync the directory they were in, so a power cut right
 * after an unlink could bring the config back: a vault that reads as paired to
 * a server it was told to forget, with a fresh index built against it on the
 * next run.
 */

import { mkdtemp, rm } from "node:fs/promises";
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

import { STATE_DIR, removeIndex, removeState, saveConfig } from "./config.ts";
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
