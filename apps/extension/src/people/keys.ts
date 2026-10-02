/** a derived XID key as the room identity zirc signs with */

import { ed25519 } from '@noble/curves/ed25519';
import { bytesToHex } from '@noble/hashes/utils';
import type { RoomIdentity } from '@zafu/zirc/room';
import { shortXid, type XidKeys } from '../state/identity';

export const identityOf = (k: Pick<XidKeys, 'pubkey' | 'xid' | 'seed'>): RoomIdentity => ({
  pubkey: k.pubkey,
  name: shortXid(k.xid),
  sign: data => Promise.resolve(bytesToHex(ed25519.sign(data, k.seed))),
  verify,
});

export const verify = (data: Uint8Array, sig: string, pubkey: string): Promise<boolean> => {
  try {
    return Promise.resolve(ed25519.verify(sig, data, pubkey));
  } catch {
    return Promise.resolve(false);
  }
};

/** a key that signs once and is forgotten: reading a door before you have a room key */
export const ephemeralIdentity = (): RoomIdentity => {
  const seed = ed25519.utils.randomPrivateKey();
  const pubkey = bytesToHex(ed25519.getPublicKey(seed));
  return {
    pubkey,
    name: pubkey.slice(0, 8),
    sign: data => Promise.resolve(bytesToHex(ed25519.sign(data, seed))),
    verify,
  };
};
