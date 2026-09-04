/** SPIKE, not shipped. Building a spike schedule without a server or a vault. */

import { deriveSchedule } from "../core/crypto.ts";
import { deriveChunkIdKey, type SpikeSchedule } from "./chunkid.ts";

/** The data key the spike's fixtures use. Fixed, and not a secret. */
export const SPIKE_DATA_KEY = new Uint8Array(32).map((_, i) => (i * 7 + 3) & 0xff);

/** Another vault's data key, for the cross-vault correlation test. */
export const OTHER_DATA_KEY = new Uint8Array(32).map((_, i) => (i * 11 + 5) & 0xff);

export async function spikeKeys(dataKey: Uint8Array = SPIKE_DATA_KEY): Promise<SpikeSchedule> {
  const schedule = await deriveSchedule(dataKey);
  return { ...schedule, chunkid: await deriveChunkIdKey(dataKey) };
}
