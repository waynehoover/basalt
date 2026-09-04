/**
 * CRC-32, the one implementation.
 *
 * Two things in this client need to notice that bytes arrived damaged and
 * neither is defending against an attacker, who would simply recompute the
 * check: a pairing string that lost its last character to a bad paste, and a
 * journal record whose tail a crash cut off. CRC-32 is good at exactly those,
 * needs no crypto, and stays synchronous, which is what lets a parser run from
 * a constructor.
 *
 * Not a hash. Anything here that has to resist tampering uses the entry MAC
 * instead; see docs/design.md.
 */
export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** The same, big-endian, for a format that carries it as bytes. */
export function crc32Bytes(bytes: Uint8Array): Uint8Array {
  const crc = crc32(bytes);
  return new Uint8Array([(crc >>> 24) & 0xff, (crc >>> 16) & 0xff, (crc >>> 8) & 0xff, crc & 0xff]);
}
