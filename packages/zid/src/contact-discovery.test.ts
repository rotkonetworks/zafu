import { describe, expect, it } from 'vitest';
import { x25519 } from '@noble/curves/ed25519';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import {
  jamTimeslot,
  presenceEpoch,
  rendezvousTag,
  JAM_COMMON_ERA,
  JAM_SLOT_DURATION,
  PRESENCE_EPOCH_SLOTS,
  RENDEZVOUS_TAG_BYTES,
} from './contact-discovery';

// two parties' static contact-KA keys (X25519)
const priv = (n: number) => new Uint8Array(32).fill(n);
const aPriv = priv(1);
const bPriv = priv(2);
const aPub = bytesToHex(x25519.getPublicKey(aPriv));
const bPub = bytesToHex(x25519.getPublicKey(bPriv));

// static-static DH: both sides derive the same pairwise root secret
const sAB = x25519.getSharedSecret(aPriv, hexToBytes(bPub));
const sBA = x25519.getSharedSecret(bPriv, hexToBytes(aPub));

describe('presence epoch (JAM time)', () => {
  it('timeslot is 0 at JAM Common Era and advances one per slot duration', () => {
    expect(jamTimeslot(JAM_COMMON_ERA)).toBe(0);
    expect(jamTimeslot(JAM_COMMON_ERA + JAM_SLOT_DURATION)).toBe(1);
    expect(jamTimeslot(JAM_COMMON_ERA + 10 * JAM_SLOT_DURATION)).toBe(10);
  });

  it('groups slots into presence epochs', () => {
    const oneEpochSecs = PRESENCE_EPOCH_SLOTS * JAM_SLOT_DURATION;
    expect(presenceEpoch(JAM_COMMON_ERA)).toBe(0);
    expect(presenceEpoch(JAM_COMMON_ERA + oneEpochSecs - 1)).toBe(0);
    expect(presenceEpoch(JAM_COMMON_ERA + oneEpochSecs)).toBe(1);
  });
});

describe('rendezvous tag', () => {
  it('both parties derive the identical tag from the shared secret (non-interactive)', () => {
    // to find A, either side computes the tag under A's publisher pubkey
    const tagFromA = rendezvousTag(sAB, 'poker.zk.bot', 42, aPub);
    const tagFromB = rendezvousTag(sBA, 'poker.zk.bot', 42, aPub);
    expect(bytesToHex(tagFromA)).toBe(bytesToHex(tagFromB));
    expect(tagFromA.length).toBe(RENDEZVOUS_TAG_BYTES);
  });

  it('rotates per epoch (unlinkable across epochs)', () => {
    const e1 = rendezvousTag(sAB, 'poker.zk.bot', 42, aPub);
    const e2 = rendezvousTag(sAB, 'poker.zk.bot', 43, aPub);
    expect(bytesToHex(e1)).not.toBe(bytesToHex(e2));
  });

  it('is scoped per app (same friends, different app => different tag)', () => {
    const poker = rendezvousTag(sAB, 'poker.zk.bot', 42, aPub);
    const dex = rendezvousTag(sAB, 'dex.rotko.net', 42, aPub);
    expect(bytesToHex(poker)).not.toBe(bytesToHex(dex));
  });

  it('direction is set by publisher pubkey (A-beacon != B-beacon)', () => {
    const aBeacon = rendezvousTag(sAB, 'poker.zk.bot', 42, aPub);
    const bBeacon = rendezvousTag(sAB, 'poker.zk.bot', 42, bPub);
    expect(bytesToHex(aBeacon)).not.toBe(bytesToHex(bBeacon));
  });

  it('a different pair yields a different tag', () => {
    const cPriv = priv(3);
    const cPub = bytesToHex(x25519.getPublicKey(cPriv));
    const sAC = x25519.getSharedSecret(aPriv, hexToBytes(cPub));
    const ab = rendezvousTag(sAB, 'poker.zk.bot', 42, aPub);
    const ac = rendezvousTag(sAC, 'poker.zk.bot', 42, aPub);
    expect(bytesToHex(ab)).not.toBe(bytesToHex(ac));
  });
});
