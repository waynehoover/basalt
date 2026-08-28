/**
 * The pairing string.
 *
 * "One binary, one pairing string" is the promise in the README, and this is the
 * string. Everything a second device needs to join a vault is in it: where the
 * server is, the token that server will accept, and the vault's root secret.
 *
 * It lives in `core` rather than beside the CLI because the plugin has to read
 * exactly the same string the headless client writes. Two parsers for one format
 * is two chances to disagree about a secret.
 *
 * ## Why it is one blob rather than three flags
 *
 * Because a person types it once, on a phone, off a screen. Three fields is
 * three chances to paste the wrong one, and a wrong *token* fails loudly while a
 * wrong *secret* fails as a vault that syncs happily and decrypts nothing. The
 * checksum below turns that second case into the first.
 *
 * ## Why the secret is in it at all
 *
 * There is nowhere else for it to be. The server never sees the passphrase or
 * the keys, so the server cannot hand them to a new device; the only thing that
 * knows the secret is a device that already has it. Anyone holding this string
 * has the vault, exactly as if they were holding the passphrase, and the CLI
 * says so when it prints one.
 *
 * ## The two secrets, and why there are still two
 *
 * The server's auth token and the vault's root secret are independent today: the
 * server generates a random token and compares against it, and knows nothing
 * about the key schedule. Folding them together, so the server stores only a
 * hash of the derived auth key and the root secret is the only secret in the
 * system, is written down in docs/features.md as designed and not built. Until
 * it is, a pairing string carries both, which is why this format is
 * length-prefixed and versioned rather than fixed.
 */

import { SECRET_LENGTH, base64urlDecode, base64urlEncode } from "./crypto.ts";

/** Marks the string as ours, and says which layout follows. */
export const PAIRING_PREFIX = "basalt2_";

/**
 * Version 2 dropped the server token.
 *
 * A vault used to have two secrets: a root secret the devices shared, and a
 * server token that had nothing to do with it, and a pairing string had to
 * carry both. The auth key is now another branch of the same HKDF schedule that
 * produces the content and path keys, so the root secret is the whole of it.
 *
 * The prefix carries the version as well as the length byte, so a version 1
 * string pasted into this is refused by the prefix check with something to say
 * rather than by the checksum with nothing.
 */
const VERSION = 2;
const CHECKSUM_BYTES = 4;

/** Everything a device needs to join a vault. */
export interface Pairing {
    /** WebSocket URL of the server, without the path. */
    readonly url: string;
    /**
     * The vault's root secret, from which every key is derived, including the
     * one that authenticates to the server. Anyone holding this has the vault.
     */
    readonly secret: Uint8Array;
    /** Which vault on that server. */
    readonly vaultId: string;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

/** Renders a pairing as the string a person copies. */
export function formatPairing(p: Pairing): string {
    if (p.secret.length !== SECRET_LENGTH) {
        throw new Error(`a root secret is ${SECRET_LENGTH} bytes, not ${p.secret.length}`);
    }
    const parts = [enc.encode(p.url), enc.encode(p.vaultId)];
    for (const part of parts) {
        // One byte of length per field. A url or a vault id longer than this is
        // not a case worth a wider format; it is a case worth an error.
        if (part.length > 255) throw new Error("a pairing field is too long to encode");
    }

    const size = 1 + SECRET_LENGTH + parts.reduce((n, part) => n + 1 + part.length, 0);
    const body = new Uint8Array(size);
    body[0] = VERSION;
    body.set(p.secret, 1);
    let at = 1 + SECRET_LENGTH;
    for (const part of parts) {
        body[at++] = part.length;
        body.set(part, at);
        at += part.length;
    }

    const out = new Uint8Array(size + CHECKSUM_BYTES);
    out.set(body, 0);
    out.set(checksum(body), size);
    return PAIRING_PREFIX + base64urlEncode(out);
}

/**
 * Reads a pairing string, refusing anything it cannot read completely.
 *
 * Every failure here is a thrown error rather than a partial result. A pairing
 * that half-parses is the worst outcome available: it would configure a device
 * with a truncated secret, which derives valid-looking keys that decrypt nothing
 * and leave a vault that looks like it is syncing.
 */
export function parsePairing(input: string): Pairing {
    const text = input.trim();
    if (text.startsWith("basalt1_")) {
        // Named rather than lumped in with rubbish, because somebody will have
        // one written down. The vault it belongs to needs re-pairing: the
        // server no longer takes the token in it, and the root secret in it is
        // in a layout this cannot read.
        throw new Error(
            "this is a version 1 pairing string, from before the server token was folded into the root secret. " +
                "Run basalt invite on a device that is already paired to get a current one."
        );
    }
    if (!text.startsWith(PAIRING_PREFIX)) {
        throw new Error(`not a pairing string: it should start with ${PAIRING_PREFIX}`);
    }

    let raw: Uint8Array;
    try {
        raw = base64urlDecode(text.slice(PAIRING_PREFIX.length));
    } catch {
        throw new Error("this pairing string is damaged: it is not valid base64url");
    }
    if (raw.length < 1 + SECRET_LENGTH + 2 + CHECKSUM_BYTES) {
        throw new Error("this pairing string is too short to be complete");
    }

    const body = raw.subarray(0, raw.length - CHECKSUM_BYTES);
    const given = raw.subarray(raw.length - CHECKSUM_BYTES);
    const want = checksum(body);
    for (let i = 0; i < CHECKSUM_BYTES; i++) {
        if (given[i] !== want[i]) {
            // The whole reason the checksum is here. A mistyped or truncated
            // paste that still decodes would otherwise become a silently wrong
            // secret, and this project's first rule is not to lose a note.
            throw new Error("this pairing string is damaged: it did not survive being copied");
        }
    }

    if (body[0] !== VERSION) {
        throw new Error(`this pairing string is version ${body[0]}, and this device understands ${VERSION}`);
    }

    const secret = body.slice(1, 1 + SECRET_LENGTH);
    let at = 1 + SECRET_LENGTH;
    const field = (what: string): string => {
        if (at >= body.length) throw new Error(`this pairing string ends before its ${what}`);
        const length = body[at++]!;
        if (at + length > body.length) throw new Error(`this pairing string ends inside its ${what}`);
        const value = dec.decode(body.subarray(at, at + length));
        at += length;
        return value;
    };

    const url = field("server address");
    const vaultId = field("vault name");
    if (at !== body.length) throw new Error("this pairing string has more in it than it should");
    if (url === "" || vaultId === "") throw new Error("this pairing string has an empty field");

    return { url, secret, vaultId };
}

/**
 * Enough of a checksum to catch a bad copy, and no more.
 *
 * CRC-32 rather than a hash: this is not protecting against an attacker, who
 * would simply recompute it, but against a paste that lost its last line or a
 * character typed in the wrong order. CRC-32 is good at exactly those and needs
 * no crypto, which keeps this function synchronous and keeps the parser usable
 * from a constructor.
 */
function checksum(body: Uint8Array): Uint8Array {
    let crc = 0xffffffff;
    for (const byte of body) {
        crc ^= byte;
        for (let bit = 0; bit < 8; bit++) {
            crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
        }
    }
    crc = (crc ^ 0xffffffff) >>> 0;
    return new Uint8Array([(crc >>> 24) & 0xff, (crc >>> 16) & 0xff, (crc >>> 8) & 0xff, crc & 0xff]);
}

/* ---------------------------------------------------------------- *
 * What a paired device stores
 * ---------------------------------------------------------------- */

/**
 * A pairing plus this device's name for itself.
 *
 * The name is local: it is what appears in a conflict copy's filename, so it
 * wants to be the thing you would call the machine rather than anything the
 * other devices agreed on.
 */
export interface DeviceConfig extends Pairing {
    readonly device: string;
    /**
     * The server's first-run token, kept only until this device has claimed the
     * vault with it.
     *
     * Absent on every device but the first, and absent on that one too once the
     * claim has gone through. What authenticates after that is derived from the
     * root secret, so there is nothing else to keep.
     */
    readonly bootstrap?: string;
}

/** The stored form, which is JSON on both platforms. */
export function encodeConfig(config: DeviceConfig): Record<string, string> {
    return {
        url: config.url,
        vaultId: config.vaultId,
        device: config.device,
        secret: base64urlEncode(config.secret),
        ...(config.bootstrap ? { bootstrap: config.bootstrap } : {}),
    };
}

/**
 * Reads stored config, refusing anything incomplete.
 *
 * Same reasoning as the pairing string: a config that half-parses gives a device
 * a truncated secret, which derives keys that are perfectly valid and completely
 * wrong. The vault would sync and decrypt nothing. `where` names the file, so
 * the error says which one.
 */
export function decodeConfig(raw: unknown, where: string): DeviceConfig {
    if (typeof raw !== "object" || raw === null) throw new Error(`${where} does not hold a configuration`);
    const record = raw as Record<string, unknown>;
    const str = (key: string): string => {
        const value = record[key];
        if (typeof value !== "string" || value === "") throw new Error(`${where} has no ${key}`);
        return value;
    };
    const secret = base64urlDecode(str("secret"));
    if (secret.length !== SECRET_LENGTH) {
        throw new Error(`${where} holds a ${secret.length} byte secret, and a root secret is ${SECRET_LENGTH}`);
    }
    const bootstrap = record["bootstrap"];
    return {
        url: str("url"),
        vaultId: str("vaultId"),
        device: str("device"),
        secret,
        ...(typeof bootstrap === "string" && bootstrap !== "" ? { bootstrap } : {}),
    };
}

/**
 * Accepts what a person is likely to type as a server address.
 *
 * `http` and `https` because that is what somebody copies out of a browser, and
 * a bare host because that is what somebody types. A bare host gets TLS, because
 * TLS is terminated in front of the server and the plain case is the one worth
 * being explicit about.
 *
 * Here rather than in a shell because both shells need it, and they had a
 * byte-identical copy each. That is the thing `core` exists to prevent: two
 * copies of a rule are two rules, and only one of them had a test.
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
