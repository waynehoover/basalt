/**
 * The pairing string.
 *
 * "One binary, one pairing string" is the promise in the README, and this is the
 * string. Everything a device needs to join a vault is in it: where the server
 * is, which vault, and the vault's root secret, which is also what
 * authenticates to the server.
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
 * The auth key is a branch of the same HKDF schedule the root produces, and the
 * server stores only its hash, so the root is the only secret this string
 * carries. The format stays length-prefixed and versioned because it once
 * carried two.
 *
 * One secret in the string is not one secret in the system, since protocol 4. A
 * vault also has a data key, which the root wraps and every paired device
 * holds, and each device has a secret of its own. Neither is ever in here: this
 * string is the recovery key, and what it buys is a registrar session that can
 * register a device and hand it the data key.
 */

import { crc32Bytes } from "./crc32.ts";
import {
  DATA_KEY_LENGTH,
  DEVICE_SECRET_LENGTH,
  SECRET_LENGTH,
  base64urlDecode,
  base64urlEncode,
  randomBytes,
} from "./crypto.ts";

/**
 * Marks the string as ours, and says which layout follows.
 *
 * This string is the vault's recovery key: shown once to the person who starts
 * the vault, to write down, and reprinted only on request. Adding a device goes
 * through a single-use invite instead, below, so the root secret never has to
 * be pasted anywhere to add a phone.
 */
export const PAIRING_PREFIX = "basalt3_";

/** Marks a single-use invite, which is not a pairing string and does not carry the root. */
export const INVITE_PREFIX = "basalt3i_";

/**
 * The one layout there is: a version byte, a 32-byte root, the address and the
 * vault, and a checksum.
 *
 * Versions 1 and 2 are gone with the protocols that made them. The byte and
 * the versioned prefix stay, so that the next change is refused by name rather
 * than by the checksum with nothing to say.
 */
const VERSION = 3;
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
  const body = frame(VERSION, p.secret, [p.url, p.vaultId]);
  return PAIRING_PREFIX + base64urlEncode(withChecksum(body));
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
  } catch (err) {
    // The decoder's own reason, not a summary of it. It refuses a stray
    // character, a length that leaves a dangling sextet and unused bits that
    // are not zero, and those are three different things to have happened to a
    // string somebody is holding in their hand.
    throw new Error(`this ${what} is damaged: ${(err as Error).message}`);
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
  if (text.startsWith(INVITE_PREFIX)) {
    throw new Error(
      "this is an invite, not a recovery key. It adds a device: give it to basalt pair, or to the Basalt panel on the new device.",
    );
  }
  if (!text.startsWith(PAIRING_PREFIX)) {
    throw new Error(`not a pairing string: it should start with ${PAIRING_PREFIX}`);
  }

  const body = unframe(text, PAIRING_PREFIX, "pairing string", 1 + SECRET_LENGTH + 2);
  if (body[0] !== VERSION) {
    throw new Error(
      `this pairing string is version ${body[0]}, and this device understands ${VERSION}`,
    );
  }
  const secret = body.slice(1, 1 + SECRET_LENGTH);
  const [url, vaultId] = fields(body, 1 + SECRET_LENGTH, "pairing string", [
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
 * What one device hands the next: the vault's data key, once, and no root.
 *
 * The data key is sealed under `key` and stored on the server under `id` with
 * an expiry. The string carries `id` so the new device can ask, `key` so it
 * can open what it is given, and the address and vault so it knows where to
 * ask. The key never reaches the server, so a stolen disk holds blobs it
 * cannot open, and the id is unguessable, so a stranger cannot redeem one by
 * trying.
 *
 * The data key and not the root, since protocol 4. The issuing device holds no
 * root and so has none to seal, and an invite that carried one would hand the
 * newcomer the credential that registers devices and rewraps the vault, which
 * is everything revoking a device is meant to take back. Redeeming registers
 * the new device's own row in the same transaction that spends the invite.
 * docs/protocol.md, "Adding a device with a single-use invite".
 */
export interface Invite {
  /** WebSocket URL of the server, without the path. */
  readonly url: string;
  readonly vaultId: string;
  /** A random 128-bit identifier, which the server stores the sealed data key under. */
  readonly id: Uint8Array;
  /** A random 256-bit key, which the data key is sealed under. Never sent to the server. */
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
  if (text.startsWith(PAIRING_PREFIX)) {
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
 * character typed in the wrong order. Shared with the index journal, which
 * needs the same question answered about a record a crash cut short; see
 * core/crc32.ts.
 */
const checksum = crc32Bytes;

/* ---------------------------------------------------------------- *
 * What a paired device stores
 * ---------------------------------------------------------------- */

/**
 * How a device identifies its own row in the vault's device list.
 *
 * Sixteen random bytes, base64url, chosen here rather than by the server. The
 * server cannot check that the bytes were random and does not try; what makes
 * a collision safe is the primary key refusing the second registration. See
 * docs/protocol.md, "The device list".
 */
export const DEVICE_ID_BYTES = 16;

/**
 * A fresh device id.
 *
 * Base64url's alphabet includes `-`, and an id beginning with one is a word a
 * command line reads as an option: `basalt revoke -Xy...` was refused with "no
 * such option" rather than revoking anything. `basalt revoke` accepts `--`
 * before an id for the ones that arrive from elsewhere, and this makes sure
 * none arrives from here. One character of entropy is given up out of 128 bits,
 * which is not a bound anybody was relying on: what makes a collision safe is
 * the primary key refusing the second registration.
 */
export function generateDeviceId(): string {
  for (;;) {
    const id = base64urlEncode(randomBytes(DEVICE_ID_BYTES));
    if (!id.startsWith("-")) return id;
  }
}

/**
 * What a paired device stores.
 *
 * A device holds `deviceId`, `deviceSecret` and `dataKey`, and nothing else.
 * That is the whole of per-device credentials: the secret connects as this one
 * device and can be revoked on its own, the data key reads and writes content,
 * and the root secret, which registers devices and rewraps the data key, is
 * not here. A stolen laptop therefore cannot register itself again, cannot add
 * a device, and cannot show anybody the recovery key.
 *
 * The one exception is `secret`, and it is a vault being started rather than a
 * device: see the field. Every other way in leaves a finished device or leaves
 * nothing, because a config with a root and no credential is not a device this
 * client can use and `deviceCredential` refuses it by name.
 *
 * The name is local: it is what appears in a conflict copy's filename, so it
 * wants to be the thing you would call the machine rather than anything the
 * other devices agreed on. It is also the label the device's row carries, and
 * it is never an identity: two laptops may both be called laptop.
 */
export interface DeviceConfig {
  /** WebSocket URL of the server, without the path. */
  readonly url: string;
  /** Which vault on that server. */
  readonly vaultId: string;
  readonly device: string;

  /**
   * This device's row in the vault's device list, and the credential for it.
   *
   * Optional in the type and not in practice: they are written together, in
   * the one save that records a finished device, and every path that connects
   * goes through `deviceCredential` first. They are optional because the file
   * on disk may predate that save, and a config that will not decode is a
   * config whose recovery key cannot be read back out of it (rule 2).
   */
  readonly deviceId?: string;
  readonly deviceSecret?: Uint8Array;
  /**
   * The vault's data key, unwrapped.
   *
   * Held directly rather than as the wrapping the server returns, because the
   * key that would unwrap it comes from the root and a paired device does not
   * have one. Every content key derives from this; docs/protocol.md, "Crypto".
   */
  readonly dataKey?: Uint8Array;

  /**
   * The vault's root secret, held only while this device is starting a vault.
   *
   * It is here for one reason. Starting a vault binds the server, for good, to
   * the key this secret derives, and a secret that claimed a server without
   * reaching the disk first is a vault nobody can ever open; so it is written
   * down before the claim goes out and replaced by this device's own
   * credential the moment there is one. Its absence afterwards is what makes
   * revoking this device mean anything: with it, the device would re-derive
   * the vault's credential and register itself again.
   *
   * A config that still holds it and has no credential is not a device. It is
   * a vault that was started here and never joined, and `deviceCredential`
   * refuses it in those words and hands the recovery key back rather than
   * leaving somebody with an unopenable vault; core/pairing.test.ts, "hands
   * the recovery key back when the root is all that is left".
   */
  readonly secret?: Uint8Array;
}

/**
 * Raised when a config holds nothing to connect with.
 *
 * Its own class because a shell has to tell it apart from a refusal by a
 * server. Nothing was asked of anybody: `basalt status` reports such a device
 * as neither reachable nor refused (rule 7), and calling it "not authorised"
 * sent somebody hunting a server problem that was not there.
 */
export class NoCredential extends Error {}

/**
 * The credential a paired device connects with, or a refusal naming what is
 * missing and what to do about it.
 *
 * Refused rather than defaulted. A config missing one of the three is not a
 * device with less state, it is a device that never finished joining the
 * vault, and the callers of this are the ones that would otherwise connect as
 * nobody or seal under a key nothing else derives (rule 2).
 *
 * A config still holding the root is the one case worth more than a refusal.
 * It is a pairing that never registered a row, and if the vault was started
 * here then the secret in it is the only copy of the recovery key there is:
 * printing it is the difference between a vault somebody can get back into and
 * a vault nobody can. Nothing is disclosed by it that whoever can read this
 * config does not already hold.
 */
export function deviceCredential(config: DeviceConfig): {
  deviceId: string;
  deviceSecret: Uint8Array;
  dataKey: Uint8Array;
} {
  const missing: string[] = [];
  if (config.deviceId === undefined) missing.push("a device id");
  if (config.deviceSecret === undefined) missing.push("a device secret");
  if (config.dataKey === undefined) missing.push("the vault's data key");
  if (missing.length > 0 || !config.deviceId || !config.deviceSecret || !config.dataKey) {
    if (config.secret !== undefined) {
      throw new NoCredential(
        "this device holds the vault's recovery key and never registered itself with the " +
          "vault, so there is no credential here to connect with. If the vault was started " +
          "here, this is the only copy of its recovery key there is:\n\n" +
          `  ${formatPairing({ url: config.url, vaultId: config.vaultId, secret: config.secret })}\n\n` +
          "Write it down, then unlink this vault and pair again with it.",
      );
    }
    throw new NoCredential(
      `this device has no credential for the vault: it is missing ${missing.join(", ")}. ` +
        `Pair this vault again with an invite from another device, or with the vault's ` +
        `recovery key.`,
    );
  }
  return { deviceId: config.deviceId, deviceSecret: config.deviceSecret, dataKey: config.dataKey };
}

/** The stored form, which is JSON on both platforms. */
export function encodeConfig(config: DeviceConfig): Record<string, string> {
  return {
    url: config.url,
    vaultId: config.vaultId,
    device: config.device,
    ...(config.deviceId ? { deviceId: config.deviceId } : {}),
    ...(config.deviceSecret ? { deviceSecret: base64urlEncode(config.deviceSecret) } : {}),
    ...(config.dataKey ? { dataKey: base64urlEncode(config.dataKey) } : {}),
    ...(config.secret ? { secret: base64urlEncode(config.secret) } : {}),
  };
}

/**
 * Reads stored config, refusing anything incomplete.
 *
 * Same reasoning as the pairing string: a config that half-parses gives a device
 * a truncated key, which derives keys that are perfectly valid and completely
 * wrong. The vault would sync and decrypt nothing. `where` names the file, so
 * the error says which one.
 *
 * What is *not* refused here is a config that is incomplete in a way that is
 * still readable: a root with no credential, or a credential missing a part.
 * Refusing to decode those would be refusing to read the one thing worth
 * reading out of them, which is the recovery key. `deviceCredential` is where
 * an unusable config is refused, at the moment something tries to connect with
 * it, and it says what is missing and what to do.
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
  const config: DeviceConfig = {
    url: str("url"),
    vaultId: str("vaultId"),
    device: str("device"),
    ...deviceId(record, where),
    ...key(record, "deviceSecret", DEVICE_SECRET_LENGTH, "a device secret", where),
    ...key(record, "dataKey", DATA_KEY_LENGTH, "a data key", where),
    ...key(record, "secret", SECRET_LENGTH, "a root secret", where),
  };
  if (config.secret === undefined && config.deviceId === undefined) {
    // Neither credential, which is not a state anything here writes: a config
    // is saved with the root while a vault is being started, and with a
    // device id and its key once there is one. Rule 2, again: a file that
    // cannot be read as a pairing is not an unpaired vault, and treating it
    // as one would pair over it and replace the keys it was holding.
    throw new Error(
      `${where} holds neither the vault's recovery key nor this device's own credential, ` +
        `so there is nothing in it to connect with`,
    );
  }
  return config;
}

/** The device id: absent, or base64url within the server's bound. */
function deviceId(record: Record<string, unknown>, where: string): { deviceId?: string } {
  const value = record["deviceId"];
  if (value === undefined || value === null) return {};
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(value)) {
    throw new Error(
      `${where} holds a deviceId that is not base64url of at most 64 characters, ` +
        `which is not an id any server would answer to`,
    );
  }
  return { deviceId: value };
}

/**
 * One of the three stored keys: absent, or exactly the length it must be.
 *
 * Length-checked rather than merely decoded, because keying material that is
 * short by a byte still derives keys. They are the wrong keys, and the vault
 * syncs and decrypts nothing, which is the failure the whole of this file is
 * shaped around.
 */
function key(
  record: Record<string, unknown>,
  field: string,
  length: number,
  what: string,
  where: string,
): Record<string, Uint8Array> {
  const value = record[field];
  if (value === undefined || value === null) return {};
  if (typeof value !== "string" || value === "") {
    throw new Error(`${where} holds a ${field} that is not a string`);
  }
  const bytes = base64urlDecode(value);
  if (bytes.length !== length) {
    throw new Error(
      `${where} holds a ${bytes.length} byte ${field}, and ${what} is ${length} bytes`,
    );
  }
  return { [field]: bytes };
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
  if (text.startsWith(PAIRING_PREFIX)) {
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
