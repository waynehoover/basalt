import { describe, expect, it } from "vitest";

import { SECRET_LENGTH, base64urlDecode, base64urlEncode, generateSecret } from "./crypto.ts";
import { PAIRING_PREFIX, formatPairing, parsePairing, type Pairing } from "./pairing.ts";

const sample = (over: Partial<Pairing> = {}): Pairing => ({
  url: "ws://laptop.tail1234.ts.net:8384",
  secret: new Uint8Array(SECRET_LENGTH).map((_, i) => (i * 37) & 0xff),
  vaultId: "default",
  ...over,
});

describe("round tripping", () => {
  it("gives back exactly what went in", () => {
    const p = sample();
    const back = parsePairing(formatPairing(p));
    expect(back.url).toBe(p.url);
    expect(back.vaultId).toBe(p.vaultId);
    expect([...back.secret]).toEqual([...p.secret]);
  });

  it("survives a real generated secret, every time", () => {
    // The secret is arbitrary bytes, including zeroes and 0xff, and a length
    // byte read as data or a data byte read as a length would only show up
    // for some of them.
    for (let i = 0; i < 200; i++) {
      const p = sample({ secret: generateSecret() });
      expect([...parsePairing(formatPairing(p)).secret]).toEqual([...p.secret]);
    }
  });

  it("survives the whitespace a paste brings with it", () => {
    const s = formatPairing(sample());
    expect(parsePairing(`  ${s}\n`).url).toBe(sample().url);
  });

  it("carries fields that are not ASCII", () => {
    const p = sample({ vaultId: "notes-café-📓" });
    expect(parsePairing(formatPairing(p)).vaultId).toBe("notes-café-📓");
  });

  it("is one word, so it survives being sent in a message", () => {
    const s = formatPairing(sample());
    expect(s).toMatch(/^basalt2_[A-Za-z0-9_-]+$/);
  });
});

/**
 * Every one of these has to be an error rather than a partial result.
 *
 * A pairing string that half-parses configures a device with a truncated secret.
 * That derives keys which look perfectly valid, seal perfectly valid ciphertext,
 * and decrypt nothing anyone else wrote. The vault would appear to be syncing.
 */
describe("refusing a string it cannot read completely", () => {
  /**
   * Version 1 carried a server token alongside the root secret. Somebody will
   * have one written down, so it is named rather than lumped in with rubbish.
   */
  it("says what to do about a version 1 string", () => {
    expect(() => parsePairing("basalt1_AAAAAAAA")).toThrow(/version 1 pairing string/);
    expect(() => parsePairing("basalt1_AAAAAAAA")).toThrow(/basalt invite/);
  });

  it("refuses something that is not a pairing string at all", () => {
    expect(() => parsePairing("hello")).toThrow(/should start with basalt2_/);
    expect(() => parsePairing("")).toThrow(/should start with basalt2_/);
  });

  it("refuses one that lost its end", () => {
    const s = formatPairing(sample());
    for (const cut of [1, 4, 12, 40]) {
      expect(() => parsePairing(s.slice(0, s.length - cut)), `cut ${cut}`).toThrow();
    }
  });

  it("refuses one with a character changed", () => {
    // The case the checksum exists for. Without it a flipped character
    // inside the secret parses cleanly and is simply the wrong key.
    const s = formatPairing(sample());
    let caught = 0;
    for (let i = PAIRING_PREFIX.length; i < s.length; i++) {
      const ch = s[i] === "A" ? "B" : "A";
      const bad = s.slice(0, i) + ch + s.slice(i + 1);
      try {
        parsePairing(bad);
      } catch {
        caught++;
      }
    }
    const changeable = s.length - PAIRING_PREFIX.length;
    expect(caught, `${caught} of ${changeable} single-character changes refused`).toBe(changeable);
  });

  it("refuses two characters swapped", () => {
    // Transposition is the classic typing error, and the reason this is a
    // CRC rather than a sum of bytes, which would not notice.
    const s = formatPairing(sample());
    let checked = 0;
    for (let i = PAIRING_PREFIX.length; i + 1 < s.length; i++) {
      if (s[i] === s[i + 1]) continue;
      const bad = s.slice(0, i) + s[i + 1] + s[i] + s.slice(i + 2);
      expect(() => parsePairing(bad), `swap at ${i}`).toThrow();
      checked++;
    }
    expect(checked).toBeGreaterThan(50);
  });

  it("refuses a version it does not understand", () => {
    const raw = base64urlDecode(formatPairing(sample()).slice(PAIRING_PREFIX.length));
    raw[0] = 3;
    // Recompute the checksum, so it is the version that is refused rather
    // than the damage.
    const fixed = reChecksum(raw);
    expect(() => parsePairing(PAIRING_PREFIX + base64urlEncode(fixed))).toThrow(/version 3/);
  });

  it("refuses a length that points past the end", () => {
    const raw = base64urlDecode(formatPairing(sample()).slice(PAIRING_PREFIX.length));
    raw[1 + SECRET_LENGTH] = 200; // the token's length byte
    expect(() => parsePairing(PAIRING_PREFIX + base64urlEncode(reChecksum(raw)))).toThrow(
      /ends inside/,
    );
  });

  it("refuses trailing rubbish that decoded cleanly", () => {
    const raw = base64urlDecode(formatPairing(sample()).slice(PAIRING_PREFIX.length));
    const longer = new Uint8Array(raw.length + 3);
    longer.set(raw.subarray(0, raw.length - 4), 0);
    expect(() => parsePairing(PAIRING_PREFIX + base64urlEncode(reChecksum(longer)))).toThrow(
      /more in it/,
    );
  });
});

describe("refusing to make a string it could not read back", () => {
  it("refuses a secret of the wrong length", () => {
    expect(() => formatPairing(sample({ secret: new Uint8Array(8) }))).toThrow(/20 bytes/);
    expect(() => formatPairing(sample({ secret: new Uint8Array(64) }))).toThrow(/20 bytes/);
  });

  it("refuses a field too long for its length byte", () => {
    expect(() => formatPairing(sample({ url: "x".repeat(256) }))).toThrow(/too long/);
  });
});

/** Rewrites the trailing checksum over whatever the body now says. */
function reChecksum(raw: Uint8Array): Uint8Array {
  const body = raw.subarray(0, raw.length - 4);
  let crc = 0xffffffff;
  for (const byte of body) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  crc = (crc ^ 0xffffffff) >>> 0;
  const out = raw.slice();
  out.set(
    [(crc >>> 24) & 0xff, (crc >>> 16) & 0xff, (crc >>> 8) & 0xff, crc & 0xff],
    raw.length - 4,
  );
  return out;
}
