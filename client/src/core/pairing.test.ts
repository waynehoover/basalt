import { describe, expect, it } from "vitest";

import {
  LEGACY_SECRET_LENGTH,
  SECRET_LENGTH,
  base64urlDecode,
  base64urlEncode,
  generateSecret,
} from "./crypto.ts";
import {
  INVITE_PREFIX,
  LEGACY_PAIRING_PREFIX,
  PAIRING_PREFIX,
  formatInvite,
  formatPairing,
  isInvite,
  normaliseUrl,
  parseInvite,
  parsePairing,
  parseSetup,
  type Invite,
  type Pairing,
} from "./pairing.ts";

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
    expect(s).toMatch(/^basalt3_[A-Za-z0-9_-]+$/);
  });

  /**
   * I4 in TODO.md. A secret made now is 32 bytes and travels as `basalt3_`;
   * a 20-byte one from a vault paired before that travels as `basalt2_`, and
   * both are read back exactly. A device holding a 20-byte root prints a
   * version 2 string, so what it prints is what it holds.
   */
  it("carries a 32-byte root as version 3 and a 20-byte root as version 2, and reads both", () => {
    const fresh = sample({ secret: generateSecret() });
    expect(fresh.secret.length).toBe(32);
    const three = formatPairing(fresh);
    expect(three.startsWith(PAIRING_PREFIX)).toBe(true);
    expect([...parsePairing(three).secret]).toEqual([...fresh.secret]);

    const old = sample({ secret: new Uint8Array(LEGACY_SECRET_LENGTH).map((_, i) => i * 7) });
    const two = formatPairing(old);
    expect(two.startsWith(LEGACY_PAIRING_PREFIX)).toBe(true);
    const back = parsePairing(two);
    expect(back.secret.length).toBe(20);
    expect([...back.secret]).toEqual([...old.secret]);
    expect(back.url).toBe(old.url);
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
    expect(() => parsePairing("hello")).toThrow(/should start with basalt3_/);
    expect(() => parsePairing("")).toThrow(/should start with basalt3_/);
  });

  it("tells an invite from a recovery key, in both directions", () => {
    const inv = formatInvite(sampleInvite());
    expect(() => parsePairing(inv)).toThrow(/an invite, not a recovery key/);
    expect(() => parseInvite(formatPairing(sample()))).toThrow(/a recovery key, not an invite/);
    expect(isInvite(inv)).toBe(true);
    expect(isInvite(formatPairing(sample()))).toBe(false);
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
    raw[0] = 4;
    // Recompute the checksum, so it is the version that is refused rather
    // than the damage.
    const fixed = reChecksum(raw);
    expect(() => parsePairing(PAIRING_PREFIX + base64urlEncode(fixed))).toThrow(/version 4/);
  });

  it("refuses a length that points past the end", () => {
    const raw = base64urlDecode(formatPairing(sample()).slice(PAIRING_PREFIX.length));
    raw[1 + SECRET_LENGTH] = 200; // the address's length byte
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
    expect(() => formatPairing(sample({ secret: new Uint8Array(8) }))).toThrow(/32 bytes, or 20/);
    expect(() => formatPairing(sample({ secret: new Uint8Array(64) }))).toThrow(/32 bytes, or 20/);
  });

  it("refuses a field too long for its length byte", () => {
    expect(() => formatPairing(sample({ url: "x".repeat(256) }))).toThrow(/too long/);
  });
});

/**
 * I6 in TODO.md. A hostname is bounded by the length byte and has to be ASCII
 * on the wire. An internationalised one is converted the way every socket
 * would convert it before connecting, so the stored address and the connected
 * address are one string on every device; a host that cannot be converted is
 * refused rather than guessed at.
 */
describe("server addresses that are long or not ASCII", () => {
  it("refuses an address too long to carry", () => {
    const long = "wss://" + "h".repeat(250) + ".example:3003";
    expect(() => formatPairing(sample({ url: long }))).toThrow(/too long/);
    expect(() => formatInvite(sampleInvite({ url: long }))).toThrow(/too long/);
  });

  it("converts an internationalised hostname to punycode, once, on the way in", () => {
    const converted = normaliseUrl("wss://bücher.example:3003");
    expect(converted).toBe("wss://xn--bcher-kva.example:3003");
    // Round trip through a pairing string, and through an invite, unchanged.
    expect(parsePairing(formatPairing(sample({ url: converted }))).url).toBe(converted);
    expect(parseInvite(formatInvite(sampleInvite({ url: converted }))).url).toBe(converted);
    // And an address that was already ASCII is left exactly as it was.
    expect(normaliseUrl("wss://homelab.tailnet.ts.net")).toBe("wss://homelab.tailnet.ts.net");
    expect(normaliseUrl("ws://127.0.0.1:3003")).toBe("ws://127.0.0.1:3003");
  });

  it("refuses a hostname that cannot be made into an address", () => {
    expect(() => normaliseUrl("wss://exa mple.com")).toThrow(/not a server address/);
  });
});

const sampleInvite = (over: Partial<Invite> = {}): Invite => ({
  url: "wss://homelab.tailnet.ts.net",
  vaultId: "default",
  id: new Uint8Array(16).map((_, i) => i * 13),
  key: new Uint8Array(32).map((_, i) => 255 - i),
  ...over,
});

/**
 * I21 in TODO.md. The invite string carries what a new device needs to fetch
 * the root once: where to ask, which vault, the identifier the sealed root is
 * stored under and the key that opens it. None of it is the root, and the key
 * never reaches the server.
 */
describe("the invite string", () => {
  it("gives back exactly what went in", () => {
    const inv = sampleInvite();
    const back = parseInvite(formatInvite(inv));
    expect(back.url).toBe(inv.url);
    expect(back.vaultId).toBe(inv.vaultId);
    expect([...back.id]).toEqual([...inv.id]);
    expect([...back.key]).toEqual([...inv.key]);
  });

  it("is one word with its own prefix", () => {
    expect(formatInvite(sampleInvite())).toMatch(/^basalt3i_[A-Za-z0-9_-]+$/);
    expect(INVITE_PREFIX).toBe("basalt3i_");
  });

  it("refuses one with a character changed or its end lost", () => {
    const s = formatInvite(sampleInvite());
    let caught = 0;
    for (let i = INVITE_PREFIX.length; i < s.length; i++) {
      const ch = s[i] === "A" ? "B" : "A";
      try {
        parseInvite(s.slice(0, i) + ch + s.slice(i + 1));
      } catch {
        caught++;
      }
    }
    expect(caught).toBe(s.length - INVITE_PREFIX.length);
    for (const cut of [1, 4, 12, 40]) {
      expect(() => parseInvite(s.slice(0, s.length - cut)), `cut ${cut}`).toThrow();
    }
  });

  it("refuses a version it does not understand", () => {
    const raw = base64urlDecode(formatInvite(sampleInvite()).slice(INVITE_PREFIX.length));
    raw[0] = 9;
    expect(() => parseInvite(INVITE_PREFIX + base64urlEncode(reChecksum(raw)))).toThrow(
      /version 9/,
    );
  });

  it("refuses an id or key of the wrong length rather than making a string it could not read", () => {
    expect(() => formatInvite(sampleInvite({ id: new Uint8Array(8) }))).toThrow(/16 bytes/);
    expect(() => formatInvite(sampleInvite({ key: new Uint8Array(16) }))).toThrow(/32 bytes/);
  });

  it("refuses something that is not an invite at all", () => {
    expect(() => parseInvite("hello")).toThrow(/should start with basalt3i_/);
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

describe("the line the server prints for the first device", () => {
  it("splits the address from the token at the last #", () => {
    expect(parseSetup("homelab:3003#K7M2PQR4-9XBCDEFGHJKMNPQRSTVWXYZ2")).toEqual({
      url: "wss://homelab:3003",
      token: "K7M2PQR4-9XBCDEFGHJKMNPQRSTVWXYZ2",
    });
    expect(parseSetup("  ws://127.0.0.1:3003#TOKEN \n")).toEqual({
      url: "ws://127.0.0.1:3003",
      token: "TOKEN",
    });
    expect(parseSetup("wss://homelab.tailnet.ts.net#TOKEN").url).toBe(
      "wss://homelab.tailnet.ts.net",
    );
  });

  it("refuses a line with no token, no address, or no #", () => {
    expect(() => parseSetup("homelab:3003")).toThrow(/host:3003#TOKEN/);
    expect(() => parseSetup("homelab:3003#")).toThrow(/token is missing/);
    expect(() => parseSetup("#TOKEN")).toThrow(/server address/);
  });

  it("tells a pairing string apart from a setup line", () => {
    expect(() => parseSetup(formatPairing(sample()))).toThrow(/joins an existing vault/);
    expect(() => parseSetup(formatInvite(sampleInvite()))).toThrow(/an invite from another device/);
  });
});
