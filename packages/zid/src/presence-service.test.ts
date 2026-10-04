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
const BLOB = 64; // sealed size for a 35-byte record: 12(nonce)+[1(ver)+35]+16(tag)
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

describe('PresenceService - end-to-end publish + discover', () => {
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

  it('withdraw takes this epoch back at once: the tag stays, nothing opens', async () => {
    // the real relay merges by tag (minirelay ON CONFLICT DO UPDATE)
    const t = new MemRelay();
    const merged = new Map<string, PresenceEntry>();
    t.putBucket = async req => {
      for (const e of req.entries) {
        merged.set(bytesToHex(e.tag), e);
      }
      t.store.set(`${req.appScope}|${req.epoch}|${req.shard}`, [...merged.values()]);
    };
    await svcA(t).publishSelf(record(1), [peerB], EPOCH);
    expect(await svcB(t).findPresent([peerA], EPOCH)).toHaveLength(1);
    await svcA(t).withdrawSelf([peerB], EPOCH);
    expect(await svcB(t).findPresent([peerA], EPOCH)).toHaveLength(0);
  });
});

describe('PresenceService - real, dummy and withdraw blobs look alike', () => {
  /** one 64-entry batch of each kind, as the relay receives it */
  const batches = async () => {
    const t = new MemRelay();
    const relay = new ContactRelay(t, { appOrigin: APP, padTo: 64, blobBytes: BLOB });
    const svc = createPresenceService(relay, APP, aPub);
    // 64 distinct friends, so the real batch is all real entries
    const peers: DiscoveryPeer[] = Array.from({ length: 64 }, (_, i) => {
      const priv = new Uint8Array(32).fill(i + 1);
      const pub = x25519.getPublicKey(priv);
      return {
        id: String(i),
        friendPubHex: bytesToHex(pub),
        rootSecret: x25519.getSharedSecret(aPriv, pub),
      };
    });
    const grab = () => [...t.store.values()].flat().map(e => e.blob);
    await svc.publishSelf(record(1), peers, EPOCH);
    const real = grab();
    t.store.clear();
    await svc.publishSelf(record(1), [], EPOCH);
    const dummy = grab();
    t.store.clear();
    await svc.withdrawSelf(peers, EPOCH);
    const withdraw = grab();
    return { real, dummy, withdraw };
  };

  it('every blob is 64 bytes and no byte position is constant in any kind', async () => {
    const { real, dummy, withdraw } = await batches();
    for (const set of [real, dummy, withdraw]) {
      expect(set).toHaveLength(64);
      expect(set.every(b => b.length === BLOB)).toBe(true);
      // 64 uniform bytes take about 56 distinct values per position; a
      // version byte (the old leak) takes one. 20 is far from both.
      const narrowest = Math.min(
        ...Array.from({ length: BLOB }, (_, i) => new Set(set.map(b => b[i])).size),
      );
      expect(narrowest).toBeGreaterThan(20);
    }
  });

  it('the first byte of a real blob is spread like a dummy one', async () => {
    const { real, dummy } = await batches();
    // the old wire made every real first byte 0x01: count how many match it
    const ones = (set: Uint8Array[]) => set.filter(b => b[0] === 0x01).length;
    expect(ones(real)).toBeLessThan(5);
    expect(ones(dummy)).toBeLessThan(5);
  });
});
