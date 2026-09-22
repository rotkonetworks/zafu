import { describe, expect, it } from 'vitest';
import { bytesToHex } from '@noble/hashes/utils';
import { rendezvousTag, RENDEZVOUS_TAG_BYTES } from './contact-discovery';
import {
  ContactRelay,
  expectedFriendTags,
  matchBucket,
  type PresenceEntry,
  type RelayTransport,
  type RandomBytes,
} from './contact-relay';

// In-memory blind relay: a dumb KV store keyed by (appScope, epoch, shard),
// CONFORMING to the wire contract in relay-http.ts: a PUT MERGES its entries into
// the coordinate keyed by tag, it does not replace the batch. A coordinate holds
// one padded batch per publisher, so a replacing store would drop everyone but
// the last writer - see the "two publishers" test below, which is the property
// that makes that difference observable.
class MemRelay implements RelayTransport {
  store = new Map<string, Map<string, Uint8Array>>();
  private key(a: string, e: number, s: string) {
    return `${a}|${e}|${s}`;
  }
  async putBucket(req: {
    appScope: string;
    epoch: number;
    shard: string;
    entries: PresenceEntry[];
  }) {
    const at = this.key(req.appScope, req.epoch, req.shard);
    const bucket = this.store.get(at) ?? new Map<string, Uint8Array>();
    for (const e of req.entries) {
      bucket.set(bytesToHex(e.tag), e.blob);
    }
    this.store.set(at, bucket);
  }
  async getBucket(req: { appScope: string; epoch: number; shard: string }) {
    const bucket = this.store.get(this.key(req.appScope, req.epoch, req.shard));
    if (bucket === undefined) {
      return [];
    }
    return [...bucket].map(([tag, blob]) => ({
      tag: Uint8Array.from(Buffer.from(tag, 'hex')),
      blob,
    }));
  }
}

// deterministic, distinct-per-call bytes so dummy tags don't collide.
const counterRng = (): RandomBytes => {
  let c = 1;
  return (n: number) => {
    const b = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      b[i] = (c + i) & 0xff;
    }
    c += n + 7;
    return b;
  };
};

const APP = 'poker.zk.bot';
const EPOCH = 100;
const BLOB = 48;
const PAD = 8;

const secret = (n: number) => new Uint8Array(32).fill(n);
const blob = (n: number) => new Uint8Array(BLOB).fill(n);
const pub = (h: string) => h.repeat(32);

const relay = (t: MemRelay) =>
  new ContactRelay(t, { appOrigin: APP, padTo: PAD, blobBytes: BLOB, randomBytes: counterRng() });

describe('ContactRelay - padding (invariant 2: hide friend count)', () => {
  it('always writes exactly padTo entries regardless of real count', async () => {
    for (const realN of [0, 1, 3]) {
      const t = new MemRelay();
      const entries: PresenceEntry[] = [];
      for (let i = 0; i < realN; i++) {
        entries.push({ tag: rendezvousTag(secret(i + 1), APP, EPOCH, pub('ab')), blob: blob(9) });
      }
      const out = await relay(t).publishPresence(entries, EPOCH);
      expect(out.perShard).toBe(PAD);
      expect(out.realCount).toBe(realN);
      const bucket = await t.getBucket({ appScope: APP, epoch: EPOCH, shard: '' });
      expect(bucket.length).toBe(PAD); // relay sees a constant F, not your friend count
    }
  });

  it('real and dummy entries are shape-indistinguishable (same tag/blob lengths)', async () => {
    const t = new MemRelay();
    await relay(t).publishPresence(
      [{ tag: rendezvousTag(secret(1), APP, EPOCH, pub('cd')), blob: blob(1) }],
      EPOCH,
    );
    const bucket = await t.getBucket({ appScope: APP, epoch: EPOCH, shard: '' });
    for (const e of bucket) {
      expect(e.tag.length).toBe(RENDEZVOUS_TAG_BYTES);
      expect(e.blob.length).toBe(BLOB);
    }
  });

  it('fails loudly on a wrong-size blob (indistinguishability break)', async () => {
    const t = new MemRelay();
    await expect(
      relay(t).publishPresence(
        [{ tag: rendezvousTag(secret(1), APP, EPOCH, pub('cd')), blob: new Uint8Array(BLOB - 1) }],
        EPOCH,
      ),
    ).rejects.toThrow(/blob must be exactly/);
  });

  it('rejects more reals than padTo', async () => {
    const t = new MemRelay();
    const entries = Array.from({ length: PAD + 1 }, (_, i) => ({
      tag: rendezvousTag(secret(i + 1), APP, EPOCH, pub('ef')),
      blob: blob(2),
    }));
    await expect(relay(t).publishPresence(entries, EPOCH)).rejects.toThrow(/exceeds padTo/);
  });
});

describe('ContactRelay - discovery (invariant 1: whole-bucket local match)', () => {
  it('finds a present friend and returns their blob', async () => {
    const t = new MemRelay();
    const s = secret(5);
    const aPub = pub('a1');
    const aBlob = blob(7);
    // A publishes presence under the tag B expects (A announces with A's own pub)
    await relay(t).publishPresence(
      [{ tag: rendezvousTag(s, APP, EPOCH, aPub), blob: aBlob }],
      EPOCH,
    );
    // B discovers A
    const present = await relay(t).discover(
      [{ id: 'A', friendPubHex: aPub, rootSecret: s }],
      EPOCH,
    );
    expect(present).toHaveLength(1);
    expect(present[0]!.id).toBe('A');
    expect(bytesToHex(present[0]!.blob)).toBe(bytesToHex(aBlob));
  });

  it('does not match a non-friend (wrong secret => wrong tag)', async () => {
    const t = new MemRelay();
    await relay(t).publishPresence(
      [{ tag: rendezvousTag(secret(5), APP, EPOCH, pub('a1')), blob: blob(7) }],
      EPOCH,
    );
    const present = await relay(t).discover(
      [{ id: 'stranger', friendPubHex: pub('a1'), rootSecret: secret(99) }],
      EPOCH,
    );
    expect(present).toHaveLength(0);
  });

  it('finds BOTH publishers when two write the same coordinate', async () => {
    // The contract-critical case: two publishers' padded batches coexist at one
    // (appScope, epoch, shard). A relay that replaced the coordinate would pass
    // every single-publisher test and still only ever surface one friend.
    const t = new MemRelay();
    const sA = secret(5);
    const sB = secret(6);
    const pubA = pub('a1');
    const pubB = pub('b1');
    await relay(t).publishPresence(
      [{ tag: rendezvousTag(sA, APP, EPOCH, pubA), blob: blob(7) }],
      EPOCH,
    );
    await relay(t).publishPresence(
      [{ tag: rendezvousTag(sB, APP, EPOCH, pubB), blob: blob(8) }],
      EPOCH,
    );

    const present = await relay(t).discover(
      [
        { id: 'A', friendPubHex: pubA, rootSecret: sA },
        { id: 'B', friendPubHex: pubB, rootSecret: sB },
      ],
      EPOCH,
    );
    expect(present.map(p => p.id).sort()).toEqual(['A', 'B']);
  });

  it('re-publishing an epoch does not duplicate a friend', async () => {
    const t = new MemRelay();
    const s = secret(5);
    const aPub = pub('a1');
    const entry = { tag: rendezvousTag(s, APP, EPOCH, aPub), blob: blob(7) };
    await relay(t).publishPresence([entry], EPOCH);
    await relay(t).publishPresence([entry], EPOCH);

    const present = await relay(t).discover(
      [{ id: 'A', friendPubHex: aPub, rootSecret: s }],
      EPOCH,
    );
    expect(present).toHaveLength(1);
  });

  it('expectedFriendTags/matchBucket compose the same as discover', () => {
    const s = secret(3);
    const p = pub('bb');
    const expected = expectedFriendTags([{ id: 'X', friendPubHex: p, rootSecret: s }], APP, EPOCH);
    const tag = rendezvousTag(s, APP, EPOCH, p);
    const found = matchBucket([{ tag, blob: blob(4) }], expected);
    expect(found).toHaveLength(1);
    expect(found[0]!.id).toBe('X');
  });
});
