/**
 * What a paired device remembers.
 *
 * Kept in `.basalt/` inside the vault, which is in the never-sync list, so it
 * neither travels to other devices nor appears as a note. A device's identity
 * and its server's token are local facts; the only thing here that is shared is
 * the root secret, and that arrives by pairing string rather than by sync.
 */

import { mkdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";

import { indexLogPath } from "../core/index-journal-store.ts";
import { decodeConfig, encodeConfig, type DeviceConfig } from "../core/pairing.ts";
import { syncDirectory, writeDurably } from "./vault.ts";

/** The folder inside a vault that holds this client's state. */
export const STATE_DIR = ".basalt";

/** What a paired device stores. Defined in core, so both shells agree. */
export type Config = DeviceConfig;

export const configPath = (vault: string) => join(vault, STATE_DIR, "config.json");
export const indexPath = (vault: string) => join(vault, STATE_DIR, "index.json");
/** The journal of what has changed since that snapshot. Both are the index. */
export const indexLog = (vault: string) => indexLogPath(indexPath(vault));

/**
 * Reads the config, distinguishing "not paired" from "cannot be read".
 *
 * Returns undefined only for a config that is genuinely absent. Anything else
 * throws: rule 2, and the incident behind it, where falling back to an empty
 * result on a read error and writing it back disabled every plugin on a device.
 * An unreadable config treated as an unpaired vault would re-pair and re-upload.
 */
export async function loadConfig(vault: string): Promise<Config | undefined> {
  const file = configPath(vault);
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(`cannot read ${file}: ${(err as Error).message}`);
  }

  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(text) as Record<string, unknown>;
  } catch (err) {
    throw new Error(
      `${file} is not valid JSON, so it cannot be trusted: ${(err as Error).message}`,
    );
  }

  // Decoded by core, so the plugin and this agree about what a config is and
  // refuse the same things. A secret of the wrong length still derives keys;
  // they are the wrong keys, and the vault would sync and decrypt nothing.
  return decodeConfig(raw, file);
}

/**
 * Writes the config, durably, atomically and readable only by its owner.
 *
 * The mode is set on the temporary file before the rename, so the config is
 * never briefly world-readable. It holds the root secret: anyone who can read it
 * can read every note in the vault.
 *
 * Durably, through the same path a note takes. This file is the only copy of
 * the root secret, and the first device claims the server the moment after
 * writing it. A write and a rename with no fsync between them can be undone
 * by a power cut, leaving a server durably bound to a key that never reached
 * the disk, and a vault nothing will ever open again. The state directory is
 * created and synced too, so the file's name is as durable as its bytes.
 */
export async function saveConfig(vault: string, config: Config): Promise<void> {
  const dir = join(vault, STATE_DIR);
  await mkdir(dir, { recursive: true });
  const file = configPath(vault);
  const text = JSON.stringify(encodeConfig(config), null, 2) + "\n";
  await writeDurably(file, new TextEncoder().encode(text), true, {
    mode: 0o600,
    stageIn: join(dir, "tmp"),
  });
  // The directory itself may be new. Its own entry in the vault root is what
  // makes it findable after a crash.
  await syncDirectory(vault);
}

/**
 * Forgets a device's pairing, leaving every note where it is.
 *
 * The index goes first, and is checked to be gone, before the config does.
 * The other order left a window in which the vault read as unpaired while
 * the old index still existed, and a new pairing then loaded an index that
 * described another secret's sync: every note "already synced" against a
 * server that had never seen this device. An index removal that fails must
 * leave the vault paired, which is the state that refuses to pair again.
 */
export async function removeState(vault: string): Promise<void> {
  await removeIndex(vault);
  await rm(configPath(vault), { force: true });
  await mustBeGone(configPath(vault), "the config");
  // Synced, so the removal is as durable as the writes were (C38). Without
  // this a power cut after unlink could bring the config back, and with it
  // a vault that reads as paired to a server it was told to forget.
  await syncDirectory(join(vault, STATE_DIR)).catch(() => undefined);
}

/**
 * Removes the index alone, proven gone, and syncs the directory.
 *
 * What `rebase` does to start again from the server's cursor, and the first
 * half of `removeState`. Kept apart so a rebase cannot remove the config by
 * taking the wrong function.
 */
export async function removeIndex(vault: string): Promise<void> {
  // The journal first, and this order is the only safe one. A crash between
  // the two leaves a snapshot with no journal, which is exactly what an index
  // looked like before the journal existed and loads without a word. The other
  // order leaves a journal with no snapshot, which is a delta against a base
  // that is not there, and the next load refuses to start at all.
  await rm(indexLog(vault), { force: true });
  await mustBeGone(indexLog(vault), "the index journal");
  await rm(indexPath(vault), { force: true });
  await mustBeGone(indexPath(vault), "the index");
  await syncDirectory(join(vault, STATE_DIR)).catch(() => undefined);
}

/**
 * Whether a vault holds an index but no config.
 *
 * That is not "unpaired", it is an unlink that did not finish or a config
 * somebody removed by hand, and pairing over it would load the orphan. The
 * caller refuses and says how to clear it.
 */
export async function orphanedIndex(vault: string): Promise<boolean> {
  // Either half counts. A journal left on its own is not something a fresh
  // pairing can start from either: it is a delta against a snapshot that is
  // gone, and the load refuses it rather than guessing at a base.
  for (const path of [indexPath(vault), indexLog(vault)]) {
    try {
      await stat(path);
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }
  return false;
}

async function mustBeGone(path: string, what: string): Promise<void> {
  try {
    await stat(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
  throw new Error(`${what} at ${path} is still there after removing it`);
}
