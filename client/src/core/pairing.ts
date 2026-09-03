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
 * ## One secret
 *
 * The auth key is a branch of the same HKDF schedule that produces the content
 * and path keys, and the server stores only its hash, so the root secret is the
 * only secret in the system and this string carries nothing else. The format
 * stays length-prefixed and versioned because it once carried two.
 */

import {
  LEGACY_SECRET_LENGTH,
  SECRET_LENGTH,
  base64urlDecode,
  base64urlEncode,
  isSecretLength,
} from "./crypto.ts";

/**
 * Marks the string as ours, and says which layout follows.
 *
 * Since protocol 3 this string is the vault's recovery key: shown once to the
 * person who starts the vault, to write down, and reprinted only on request.
 * Adding a device goes through a single-use invite instead, below, so the
 * root secret no longer has to be pasted anywhere to add a phone.
 */
export const PAIRING_PREFIX = "basalt3_";

/** The prefix of a version 2 string, which carries a 20-byte root and is still accepted. */
export const LEGACY_PAIRING_PREFIX = "basalt2_";

/** Marks a single-use invite, which is not a pairing string and does not carry the root. */
export const INVITE_PREFIX = "basalt3i_";

/**
 * Version 2 dropped the server token; version 3 widened the root to 32 bytes.
 *
 * A vault used to have two secrets: a root secret the devices shared, and a
 * server token that had nothing to do with it, and a pairing string had to
 * carry both. The auth key is now another branch of the same HKDF schedule
 * that produces the content and path keys, so the root secret is the whole of
 * it. Version 3 changed only the root's length; a version 2 string still
 * parses and still opens its vault, for as long as the project exists.
 *
 * The prefix carries the version as well as the length byte, so a version 1
 * string pasted into this is refused by the prefix check with something to say
 * rather than by the checksum with nothing.
 */
const VERSION = 3;
const LEGACY_VERSION = 2;
const CHECKSUM_BYTES = 4;

/** The root length each version carries. */
function secretLengthFor(version: number): number | undefined {
  if (version === VERSION) return SECRET_LENGTH;
  if (version === LEGACY_VERSION) return LEGACY_SECRET_LENGTH;
  return undefined;
}

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

/**
 * Renders a pairing as the string a person copies.
 *
 * The version follows the secret: a 32-byte root is a `basalt3_` string and a
 * 20-byte one, from a vault paired before version 3, is a `basalt2_` string.
 * A device holding a version 2 root prints a version 2 string, so the root it
 * prints is the root it holds and nothing is silently re-encoded.
 */
export function formatPairing(p: Pairing): string {
  if (!isSecretLength(p.secret.length)) {
    throw new Error(
      `a root secret is ${SECRET_LENGTH} bytes, or ${LEGACY_SECRET_LENGTH} from a version 2 pairing, not ${p.secret.length}`,
    );
  }
  const version = p.secret.length === SECRET_LENGTH ? VERSION : LEGACY_VERSION;
  const prefix = version === VERSION ? PAIRING_PREFIX : LEGACY_PAIRING_PREFIX;
  const body = frame(version, p.secret, [p.url, p.vaultId]);
  return prefix + base64urlEncode(withChecksum(body));
}

/**
 * Lays out a version byte, fixed bytes, and length-prefixed fields.
 *
 * Shared by the pairing string and the invite string, which have the same
 * shape and differ in what the fixed bytes are.
 */
function frame(version: number, fixed: Uint8Array, fields: readonly string[]): Uint8Array {
  const parts = fields.map((f) => enc.encode(f));
  for (const part of parts) {
    // One byte of length per field. A url or a vault id longer than this is
    // not a case worth a wider format; it is a case worth an error.
    if (part.length > 255) throw new Error("a pairing field is too long to encode");
  }
  const size = 1 + fixed.length + parts.reduce((n, part) => n + 1 + part.length, 0);
  const body = new Uint8Array(size);
  body[0] = version;
  body.set(fixed, 1);
  let at = 1 + fixed.length;
  for (const part of parts) {
    body[at++] = part.length;
    body.set(part, at);
    at += part.length;
  }
  return body;
}

function withChecksum(body: Uint8Array): Uint8Array {
  const out = new Uint8Array(body.length + CHECKSUM_BYTES);
  out.set(body, 0);
  out.set(checksum(body), body.length);
  return out;
}

/**
 * Decodes a prefixed, checksummed body, refusing damage before reading it.
 *
 * `what` names the kind of string in every error, because the same damage to
 * an invite and to a recovery key is reported to the same person.
 */
function unframe(text: string, prefix: string, what: string, minimum: number): Uint8Array {
  let raw: Uint8Array;
  try {
    raw = base64urlDecode(text.slice(prefix.length));
  } catch {
    throw new Error(`this ${what} is damaged: it is not valid base64url`);
  }
  if (raw.length < minimum + CHECKSUM_BYTES) {
    throw new Error(`this ${what} is too short to be complete`);
  }
  const body = raw.subarray(0, raw.length - CHECKSUM_BYTES);
  const given = raw.subarray(raw.length - CHECKSUM_BYTES);
  const want = checksum(body);
  for (let i = 0; i < CHECKSUM_BYTES; i++) {
    if (given[i] !== want[i]) {
      // The whole reason the checksum is here. A mistyped or truncated
      // paste that still decodes would otherwise become a silently wrong
      // secret, and this project's first rule is not to lose a note.
      throw new Error(`this ${what} is damaged: it did not survive being copied`);
    }
  }
  return body;
}

/** Reads length-prefixed fields from `at` to the end of a body, and no further. */
function fields(body: Uint8Array, at: number, what: string, names: readonly string[]): string[] {
  const out: string[] = [];
  for (const name of names) {
    if (at >= body.length) throw new Error(`this ${what} ends before its ${name}`);
    const length = body[at++]!;
    if (at + length > body.length) throw new Error(`this ${what} ends inside its ${name}`);
    out.push(dec.decode(body.subarray(at, at + length)));
    at += length;
  }
  if (at !== body.length) throw new Error(`this ${what} has more in it than it should`);
  return out;
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
        "Run basalt invite on a device that is already paired to get a current one.",
    );
  }
  if (text.startsWith(INVITE_PREFIX)) {
    throw new Error(
      "this is an invite, not a recovery key. It adds a device: give it to basalt pair, or to the Basalt panel on the new device.",
    );
  }
  const prefix = text.startsWith(PAIRING_PREFIX)
    ? PAIRING_PREFIX
    : text.startsWith(LEGACY_PAIRING_PREFIX)
      ? LEGACY_PAIRING_PREFIX
      : undefined;
  if (prefix === undefined) {
    throw new Error(
      `not a pairing string: it should start with ${PAIRING_PREFIX} (or ${LEGACY_PAIRING_PREFIX} from an older vault)`,
    );
  }

  const body = unframe(text, prefix, "pairing string", 1 + LEGACY_SECRET_LENGTH + 2);
  const secretLength = secretLengthFor(body[0]!);
  if (secretLength === undefined) {
    throw new Error(
      `this pairing string is version ${body[0]}, and this device understands ${LEGACY_VERSION} and ${VERSION}`,
    );
  }
  if (body.length < 1 + secretLength + 2) {
    throw new Error("this pairing string is too short to be complete");
  }
  const secret = body.slice(1, 1 + secretLength);
  const [url, vaultId] = fields(body, 1 + secretLength, "pairing string", [
    "server address",
    "vault name",
  ]) as [string, string];
  if (url === "" || vaultId === "") throw new Error("this pairing string has an empty field");

  return { url: normaliseUrl(url), secret, vaultId };
}

/** Whether a string is an invite rather than a recovery key, by its prefix. */
export function isInvite(input: string): boolean {
  return input.trim().startsWith(INVITE_PREFIX);
}

/* ---------------------------------------------------------------- *
 * Invites
 * ---------------------------------------------------------------- */

/**
 * What one device hands the next: not the root, but the way to fetch it once.
 *
 * The root secret is sealed under `key` and stored on the server under `id`
 * with an expiry. The string carries `id` so the new device can ask, `key` so
 * it can open what it is given, and the address and vault so it knows where
 * to ask. The key never reaches the server, so a stolen disk holds blobs it
 * cannot open, and the id is unguessable, so a stranger cannot redeem one by
 * trying. docs/protocol.md, "Adding a device with a single-use invite".
 */
export interface Invite {
  /** WebSocket URL of the server, without the path. */
  readonly url: string;
  readonly vaultId: string;
  /** A random 128-bit identifier, which the server stores the sealed root under. */
  readonly id: Uint8Array;
  /** A random 256-bit key, which the root is sealed under. Never sent to the server. */
  readonly key: Uint8Array;
}

const INVITE_VERSION = 1;
export const INVITE_ID_LENGTH = 16;
export const INVITE_KEY_LENGTH = 32;

/** Renders an invite as the string a person copies. */
export function formatInvite(inv: Invite): string {
  if (inv.id.length !== INVITE_ID_LENGTH) {
    throw new Error(`an invite id is ${INVITE_ID_LENGTH} bytes, not ${inv.id.length}`);
  }
  if (inv.key.length !== INVITE_KEY_LENGTH) {
    throw new Error(`an invite key is ${INVITE_KEY_LENGTH} bytes, not ${inv.key.length}`);
  }
  const fixed = new Uint8Array(INVITE_ID_LENGTH + INVITE_KEY_LENGTH);
  fixed.set(inv.id, 0);
  fixed.set(inv.key, INVITE_ID_LENGTH);
  const body = frame(INVITE_VERSION, fixed, [inv.url, inv.vaultId]);
  return INVITE_PREFIX + base64urlEncode(withChecksum(body));
}

/**
 * Reads an invite string, refusing anything it cannot read completely.
 *
 * The same rule as `parsePairing`, for the same reason: a half-read invite
 * key opens nothing, and the failure would be reported far from here as an
 * unseal that did not work.
 */
export function parseInvite(input: string): Invite {
  const text = input.trim();
  if (text.startsWith(PAIRING_PREFIX) || text.startsWith(LEGACY_PAIRING_PREFIX)) {
    throw new Error("this is a recovery key, not an invite; basalt pair takes either");
  }
  if (!text.startsWith(INVITE_PREFIX)) {
    throw new Error(`not an invite: it should start with ${INVITE_PREFIX}`);
  }
  const fixedLength = INVITE_ID_LENGTH + INVITE_KEY_LENGTH;
  const body = unframe(text, INVITE_PREFIX, "invite", 1 + fixedLength + 2);
  if (body[0] !== INVITE_VERSION) {
    throw new Error(
      `this invite is version ${body[0]}, and this device understands ${INVITE_VERSION}`,
    );
  }
  const id = body.slice(1, 1 + INVITE_ID_LENGTH);
  const key = body.slice(1 + INVITE_ID_LENGTH, 1 + fixedLength);
  const [url, vaultId] = fields(body, 1 + fixedLength, "invite", [
    "server address",
    "vault name",
  ]) as [string, string];
  if (url === "" || vaultId === "") throw new Error("this invite has an empty field");
  return { url: normaliseUrl(url), vaultId, id, key };
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
  if (typeof raw !== "object" || raw === null)
    throw new Error(`${where} does not hold a configuration`);
  const record = raw as Record<string, unknown>;
  const str = (key: string): string => {
    const value = record[key];
    if (typeof value !== "string" || value === "") throw new Error(`${where} has no ${key}`);
    return value;
  };
  const secret = base64urlDecode(str("secret"));
  if (!isSecretLength(secret.length)) {
    throw new Error(
      `${where} holds a ${secret.length} byte secret, and a root secret is ${SECRET_LENGTH} bytes, or ${LEGACY_SECRET_LENGTH} from a version 2 pairing`,
    );
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
  let url: string;
  if (text.startsWith("ws://") || text.startsWith("wss://")) url = text;
  else if (text.startsWith("http://")) url = "ws://" + text.slice("http://".length);
  else if (text.startsWith("https://")) url = "wss://" + text.slice("https://".length);
  else if (text.includes("://"))
    throw new Error(`a server address is ws:// or wss://, not ${text.split("://")[0]}://`);
  else url = "wss://" + text;
  return asciiHost(url);
}

/**
 * Puts an internationalised hostname into the form the wire carries.
 *
 * A hostname with characters outside ASCII is legal to type and illegal on
 * the wire; every WebSocket implementation converts it to punycode before
 * connecting, and the server logs and compares what it was sent. The pairing
 * string is copied between devices as text, so it has to carry the form every
 * device agrees on. The URL parser does the conversion (IDNA, to `xn--`), the
 * same one the socket would apply, and does it here so the stored address and
 * the connected address are one string. A host the parser cannot make sense of
 * is refused as not an address.
 */
function asciiHost(url: string): string {
  // Cheap path, and the common one: nothing to convert.
  // eslint-disable-next-line no-control-regex
  if (/^[\x21-\x7e]*$/.test(url)) return url;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`${url} is not a server address this device can connect to`);
  }
  if (!/^[\x21-\x7e]*$/.test(parsed.hostname)) {
    throw new Error(
      `the hostname in ${url} has characters outside ASCII that cannot be converted; ` +
        `give it in punycode (xn--...) instead`,
    );
  }
  // Rebuilt from the parts rather than from `href`, which appends a slash
  // to a bare host and would make the same address two different strings.
  const port = parsed.port === "" ? "" : `:${parsed.port}`;
  const path = parsed.pathname === "/" ? "" : parsed.pathname;
  return `${parsed.protocol}//${parsed.hostname}${port}${path}${parsed.search}`;
}

/**
 * What the server prints for the first device: `host:3003#TOKEN`.
 *
 * One line, so it can be pasted whole. The server has no root secret to put in
 * a real pairing string, so the first device gets the address and the
 * bootstrap token instead and makes the secret itself. Both shells accept the
 * line as printed, because it used to be two fields and the line had to be
 * split by hand, which is a step nobody should have to be told about.
 *
 * Everything before the last `#` is the address and goes through
 * `normaliseUrl`, so `homelab:3003`, `ws://127.0.0.1:3003` and
 * `wss://homelab.tailnet.ts.net` all work. Everything after it is the token.
 */
export function parseSetup(input: string): { url: string; token: string } {
  const text = input.trim();
  if (
    text.startsWith(PAIRING_PREFIX) ||
    text.startsWith(LEGACY_PAIRING_PREFIX) ||
    text.startsWith("basalt1_")
  ) {
    throw new Error(
      "that is a recovery key from another device. It joins an existing vault; " +
        "to start a new one, paste the line the server printed, like host:3003#TOKEN",
    );
  }
  if (text.startsWith(INVITE_PREFIX)) {
    throw new Error(
      "that is an invite from another device. It joins an existing vault; " +
        "to start a new one, paste the line the server printed, like host:3003#TOKEN",
    );
  }
  const hash = text.lastIndexOf("#");
  if (hash < 0) {
    throw new Error(
      "a server setup line looks like host:3003#TOKEN, exactly as the server printed it",
    );
  }
  const url = normaliseUrl(text.slice(0, hash));
  const token = text.slice(hash + 1).trim();
  if (token === "") throw new Error("the server's token is missing after the #");
  return { url, token };
}
