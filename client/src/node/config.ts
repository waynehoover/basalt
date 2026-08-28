/**
 * What a paired device remembers.
 *
 * Kept in `.basalt/` inside the vault, which is in the never-sync list, so it
 * neither travels to other devices nor appears as a note. A device's identity
 * and its server's token are local facts; the only thing here that is shared is
 * the root secret, and that arrives by pairing string rather than by sync.
 */

import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { SECRET_LENGTH, base64urlDecode, base64urlEncode } from "../core/crypto.ts";
import type { Pairing } from "../core/pairing.ts";

/** The folder inside a vault that holds this client's state. */
export const STATE_DIR = ".basalt";

export interface Config extends Pairing {
    /** What this device calls itself, which is what appears in conflict copies. */
    readonly device: string;
}

export const configPath = (vault: string) => join(vault, STATE_DIR, "config.json");
export const indexPath = (vault: string) => join(vault, STATE_DIR, "index.json");

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
        throw new Error(`${file} is not valid JSON, so it cannot be trusted: ${(err as Error).message}`);
    }

    const str = (key: string): string => {
        const value = raw[key];
        if (typeof value !== "string" || value === "") throw new Error(`${file} has no ${key}`);
        return value;
    };
    const secret = base64urlDecode(str("secret"));
    if (secret.length !== SECRET_LENGTH) {
        // A secret of the wrong length still derives keys. They would be the
        // wrong keys, and the vault would sync happily and decrypt nothing.
        throw new Error(`${file} holds a ${secret.length} byte secret, and a root secret is ${SECRET_LENGTH}`);
    }

    return {
        url: str("url"),
        token: str("token"),
        vaultId: str("vaultId"),
        device: str("device"),
        secret,
    };
}

/**
 * Writes the config, atomically and readable only by its owner.
 *
 * The mode is set on the temporary file before the rename, so the config is
 * never briefly world-readable. It holds the root secret: anyone who can read it
 * can read every note in the vault.
 */
export async function saveConfig(vault: string, config: Config): Promise<void> {
    const dir = join(vault, STATE_DIR);
    await mkdir(dir, { recursive: true });
    const file = configPath(vault);
    const tmp = `${file}.tmp`;
    const body = {
        url: config.url,
        token: config.token,
        vaultId: config.vaultId,
        device: config.device,
        secret: base64urlEncode(config.secret),
    };
    await writeFile(tmp, JSON.stringify(body, null, 2) + "\n", { mode: 0o600 });
    await chmod(tmp, 0o600);
    await rename(tmp, file);
}

/** Forgets a device's pairing, leaving every note where it is. */
export async function removeState(vault: string): Promise<void> {
    await rm(configPath(vault), { force: true });
    await rm(indexPath(vault), { force: true });
}
