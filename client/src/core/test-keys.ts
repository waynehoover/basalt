/**
 * One data key for the whole suite, so a test can know a vault's keys before
 * the vault exists.
 *
 * Every vault seals its content under a random data key that the first device
 * makes and the server hands back in `ready`. That is right, and it means a
 * test cannot derive the keys it is going to need until it has connected. Most
 * of these tests want the opposite order: seal a path, forge an entry, then
 * see what the engine makes of it.
 *
 * So the fixtures claim their vaults with a fixed data key instead of a random
 * one. The wrapping is still real and still random, because it uses a random
 * nonce, and the server still stores whatever the claiming device offered; what
 * is fixed is only the key underneath, so `testKeys(secret)` and the engine's
 * own keys after `ready` come out identical.
 *
 * Imported only by tests and the fixtures they share, like test-server.ts, so
 * none of this reaches a shipped bundle.
 */

import { deriveRootKeys, deriveSchedule, wrapDataKey, type Schedule } from "./crypto.ts";

/**
 * The data key every test vault is claimed with. Not random, and not a secret.
 *
 * Exported since protocol 4, because a device holds the data key itself rather
 * than a root that unwraps one: a fixture building an engine hands it this.
 */
export const TEST_DATA_KEY = new Uint8Array(32).map((_, i) => (i * 7 + 3) & 0xff);

/** The fixed data key wrapped under a root, which is what a claim carries. */
export async function testWrapped(secret: Uint8Array): Promise<string> {
  return wrapDataKey((await deriveRootKeys(secret)).wrap, TEST_DATA_KEY);
}

/**
 * The keys a device on a vault claimed by these fixtures has.
 *
 * The root is no longer part of the answer: every content key hangs off the
 * data key, and the root only ever wrapped it. The parameter stays so the
 * hundreds of call sites reading `testKeys(SECRET)` keep saying which vault
 * they mean, and it is deliberately ignored: two roots holding one data key
 * seal identically, which is the whole point of the data key.
 */
export async function testKeys(_secret?: Uint8Array): Promise<Schedule> {
  return deriveSchedule(TEST_DATA_KEY);
}

/**
 * Another vault's keys, for the cases about a peer that is not ours.
 *
 * A different root is not enough to make a different vault: two roots holding
 * one data key seal identically, which is the whole point of the data key.
 * What makes another vault is another data key, so this takes one.
 */
export async function otherVaultKeys(seed: number): Promise<Schedule> {
  return deriveSchedule(new Uint8Array(32).fill(seed));
}
