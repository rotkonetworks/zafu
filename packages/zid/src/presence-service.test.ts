import { describe, expect, it } from 'vitest';
import { bytesToHex } from '@noble/hashes/utils';
import { x25519 } from '@noble/curves/ed25519';
import { ContactRelay, type PresenceEntry, type RelayTransport } from './contact-relay';
import { createPresenceService, type DiscoveryPeer } from './presence-service';
import type { PresenceRecord } from './presence-blob';

class MemRelay implements RelayTransport {
  store = new Map<string, PresenceEntry[]>();
  private key(a: string, e: number, s: string) {
    return `${a}|${e}|${s}`;
  }
  async putBucket(req: {
    appScope: string;
    epoch: number;
    shard: string;
    entries: PresenceEntry[];
  }) {
    this.store.set(this.key(req.appScope, req.epoch, req.shard), req.entries);
  }
  async getBucket(req: { appScope: string; epoch: number; shard: string }) {
    return this.store.get(this.key(req.appScope, req.epoch, req.shard)) ?? [];
  }
}

const APP = 'poker.zk.bot';
const EPOCH = 100;
const BLOB = 64; // sealed size for a 35-byte record: 1(ver)+12(nonce)+35+16(tag)
const PAD = 8;

// two peers' contact-KA keys + their (symmetric) shared root secret.
const aPriv = new Uint8Array(32).fill(11);
const bPriv = new Uint8Array(32).fill(22);
const aPub = bytesToHex(x25519.getPublicKey(aPriv));
const bPub = bytesToHex(x25519.getPublicKey(bPriv));
const sharedAB = x25519.getSharedSecret(aPriv, x25519.getPublicKey(bPriv));

const relayFor = (t: MemRelay) =>
  new ContactRelay(t, { appOrigin: APP, padTo: PAD, blobBytes: BLOB });

const svcA = (t: MemRelay) => createPresenceService(relayFor(t), APP, aPub);
const svcB = (t: MemRelay) => createPresenceService(relayFor(t), APP, bPub);

const peerB: DiscoveryPeer = { id: 'B', friendPubHex: bPub, rootSecret: sharedAB };
const peerA: DiscoveryPeer = { id: 'A', friendPubHex: aPub, rootSecret: sharedAB };

const record = (caps: number): PresenceRecord => ({
  sessionPub: new Uint8Array(32).fill(0xa5),
  caps,
});

describe('PresenceService — end-to-end publish + discover', () => {
  it('B finds A present and decrypts A’s presence record', async () => {
    const t = new MemRelay();
    await svcA(t).publishSelf(record(7), [peerB], EPOCH);
    const present = await svcB(t).findPresent([peerA], EPOCH);
    expect(present).toHaveLength(1);
    expect(present[0]!.id).toBe('A');
    expect(present[0]!.record.caps).toBe(7);
    expect(bytesToHex(present[0]!.record.sessionPub)).toBe(bytesToHex(record(7).sessionPub));
  });

  it('a peer with the wrong root secret is not found', async () => {
    const t = new MemRelay();
    await svcA(t).publishSelf(record(1), [peerB], EPOCH);
    const wrongPeerA: DiscoveryPeer = {
      id: 'A',
      friendPubHex: aPub,
      rootSecret: new Uint8Array(32).fill(9),
    };
    const present = await svcB(t).findPresent([wrongPeerA], EPOCH);
    expect(present).toHaveLength(0);
  });

  it('publish is padded to a constant F (relay cannot count friends)', async () => {
    const t = new MemRelay();
    await svcA(t).publishSelf(record(3), [peerB], EPOCH);
    const bucket = await t.getBucket({ appScope: APP, epoch: EPOCH, shard: '' });
    expect(bucket.length).toBe(PAD);
    for (const e of bucket) {
      expect(e.blob.length).toBe(BLOB); // real + dummy same size
    }
  });

  it('is app-scoped: presence in one app is not discoverable in another', async () => {
    const t = new MemRelay();
    await svcA(t).publishSelf(record(2), [peerB], EPOCH);
    const otherApp = createPresenceService(
      new ContactRelay(t, { appOrigin: 'dex.rotko.net', padTo: PAD, blobBytes: BLOB }),
      'dex.rotko.net',
      bPub,
    );
    const present = await otherApp.findPresent([peerA], EPOCH);
    expect(present).toHaveLength(0);
  });
});
