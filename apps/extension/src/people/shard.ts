/** a pair room's shard per window (design-social 2.5) */

import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';

/** `HKDF(pairSecret, info "shard" || u64be(epoch))`, 8 bytes as hex */
export const pairShard =
  (secretHex: string) =>
  (epoch: number): Promise<string> => {
    const info = new Uint8Array(13);
    info.set(new TextEncoder().encode('shard'));
    new DataView(info.buffer).setBigUint64(5, BigInt(epoch));
    return Promise.resolve(bytesToHex(hkdf(sha256, hexToBytes(secretHex), undefined, info, 8)));
  };
