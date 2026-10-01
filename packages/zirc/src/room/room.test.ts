import { describe, expect, it } from 'vitest';
import {
  RelayTransport,
  ZidIdentity,
  concat,
  createGuestIdentity,
  createHttpRelayTransport,
  u32be,
} from '@zafu/zid';
import {
  GROUP_ROOM_PLAINTEXT_BYTES,
  Room,
  ROOM_PLAINTEXT_BYTES,
  createRoomSecret,
  encodeInvite,
  hkdfBytes,
  maxBodyBytes,
  parseInvite,
  relayLimitsFor,
  sealedBlobBytes,
  DEFAULT_CHANNEL,
  roomShard,
  roomShardFromSecret,
  type RoomConfig,
  type RoomIdentity,
} from './room';

const SCOPE = 'veil-chat';
/**
 * One window, in seconds - the presence epoch a room's boards are keyed by.
 * `zid` counts epochs from the JAM common era, so a synthetic instant has to sit
 * after it; anchoring to the real clock on a window boundary keeps that true
 * without a constant that rots.
 */
const WINDOW = 300;
const T0 = Math.floor(Date.now() / 1000 / WINDOW) * WINDOW;

/** base64url, for building invite shapes by hand in this suite. */
const b64 = (s: string): string =>
  btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const b64Bytes = (bytes: Uint8Array): string => b64(String.fromCharCode(...bytes));

const toHex = (b: Uint8Array): string =>
  Array.from(b, x => x.toString(16).padStart(2, '0')).join('');

const fromHex = (s: string): Uint8Array => {
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
};

/** copy into an ArrayBuffer-backed view - WebCrypto wants BufferSource. */
const ab = (u: Uint8Array): Uint8Array<ArrayBuffer> => {
  const out = new Uint8Array(new ArrayBuffer(u.length));
  out.set(u);
  return out;
};

/**
 * The relay contract in memory: coordinates keyed by (scope, epoch, shard),
 * entries MERGED by tag - which is the whole reason two members can write to one
 * coordinate with no read-modify-write, so the double has to do it too.
 */
const fakeRelay = () => {
  const coords = new Map<string, Map<string, Uint8Array>>();
  const key = (scope: string, epoch: number, shard: string) => `${scope}|${epoch}|${shard}`;
  const transport: RelayTransport = {
    putBucket: ({ appScope, epoch, shard, entries }) => {
      const coord = coords.get(key(appScope, epoch, shard)) ?? new Map<string, Uint8Array>();
      for (const entry of entries) {
        coord.set(toHex(entry.tag), entry.blob);
      }
      coords.set(key(appScope, epoch, shard), coord);
      return Promise.resolve();
    },
    getBucket: ({ appScope, epoch, shard }) =>
      Promise.resolve(
        [...(coords.get(key(appScope, epoch, shard)) ?? new Map<string, Uint8Array>())].map(
          ([tag, blob]) => ({ tag: fromHex(tag), blob }),
        ),
      ),
  };
  /**
   * The bucket a room actually used. A test about what the relay stores must not
   * re-derive the coordinate: the default is the secret's shard and a public
   * room's is the name's, so the harness resolves what is there. An explicit
   * shard still works and is required when a window holds more than one bucket.
   */
  const found = (
    scope: string,
    epoch: number,
    shard?: string,
  ): { shard: string; coord: Map<string, Uint8Array> } => {
    if (shard) {
      const coord = coords.get(key(scope, epoch, shard));
      if (!coord) {
        throw new Error('no bucket at that coordinate');
      }
      return { shard, coord };
    }
    const held = [...coords.keys()].filter(k => k.startsWith(`${scope}|${epoch}|`));
    const only = held.length === 1 ? held[0] : undefined;
    if (!only) {
      throw new Error(`expected one bucket for ${scope}|${epoch}, found ${held.length}`);
    }
    return { shard: only.slice(`${scope}|${epoch}|`.length), coord: coords.get(only)! };
  };
  const bucket = (scope: string, epoch: number, shard?: string) => found(scope, epoch, shard).coord;
  /** the shard a single-bucket window is stored under, for tests that move it. */
  const shardOf = (scope: string, epoch: number): string => found(scope, epoch).shard;
  /** mutate a stored blob in place, to model a relay - or a network - that lies. */
  const tamper = (scope: string, epoch: number, at: number, shard?: string) => {
    const coord = bucket(scope, epoch, shard);
    const entry = [...coord.entries()][at];
    if (!entry) {
      throw new Error('tamper: nothing stored at that entry');
    }
    const [tag, blob] = entry;
    const next = new Uint8Array(blob);
    const last = next.length - 1;
    next[last] = (next[last] ?? 0) ^ 0xff;
    coord.set(tag, next);
  };
  /** drop one stored entry, to model a relay that withholds what it holds. */
  const omit = (scope: string, epoch: number, at: number, shard?: string) => {
    const coord = bucket(scope, epoch, shard);
    const tag = [...coord.keys()][at];
    if (coord && tag) {
      coord.delete(tag);
    }
  };
  return { transport, tamper, omit, bucket, shardOf };
};

/** a guest identity, deterministic per seed - the same shape the panel passes. */
const guest = (seed: number) =>
  createGuestIdentity({ origin: SCOPE, seed: new Uint8Array(32).fill(seed) });

/** the identity slice a room consumes, with the display name the panel would set. */
const asIdentity = (id: ZidIdentity, name?: string): RoomIdentity => ({
  pubkey: id.pubkey,
  name,
  sign: id.sign,
  verify: id.verify,
});

const openRoom = (
  identity: RoomIdentity,
  opts: Partial<RoomConfig> & { relay: RelayTransport; roomSecret: Uint8Array },
) =>
  new Room(identity, {
    appScope: SCOPE,
    now: () => T0,
    ...opts,
  });

describe('room', () => {
  it('carries a message from one member to another, and back', async () => {
    const { transport } = fakeRelay();
    const secret = createRoomSecret();
    let now = T0;
    const alice = openRoom(asIdentity(guest(1), 'alice'), {
      relay: transport,
      roomSecret: secret,
      now: () => now,
    });
    const bob = openRoom(asIdentity(guest(2), 'bob'), {
      relay: transport,
      roomSecret: secret,
      now: () => now,
    });

    const sent = await alice.send('penumbra fill came through');

    const forBob = await bob.sync();
    expect(forBob.messages).toEqual([
      expect.objectContaining({
        body: 'penumbra fill came through',
        name: 'alice',
        seq: 1,
        prev: '',
      }),
    ]);
    expect(forBob.messages[0]!.hash).toBe(sent.hash);
    expect(forBob.dropped).toEqual([]);

    now = T0 + 1; // a second later, as one member replying to another does
    await bob.send('saw it, thanks');

    const forAlice = await alice.sync();
    expect(forAlice.messages.map(m => [m.name, m.body])).toEqual([
      ['alice', 'penumbra fill came through'],
      ['bob', 'saw it, thanks'],
    ]);
    expect(forAlice.dropped).toEqual([]);
  });

  it('shows nothing to a reader who has the coordinate but not the secret', async () => {
    const { transport } = fakeRelay();
    const secret = createRoomSecret();
    const alice = openRoom(asIdentity(guest(1), 'alice'), {
      relay: transport,
      roomSecret: secret,
      // public, so the room sits on the name coordinate: a stranger really can
      // walk up to this board. Reaching it is what buys them nothing.
      public: true,
    });
    await alice.send('private');

    // Eve reaches the same relay coordinate - pinned shard - with her own secret.
    const eve = openRoom(asIdentity(guest(9), 'eve'), {
      relay: transport,
      roomSecret: createRoomSecret(),
      shard: await roomShard(SCOPE, DEFAULT_CHANNEL),
    });

    const seen = await eve.sync();
    expect(seen.messages).toEqual([]);
    expect(seen.present).toEqual([]);
    // and she is told there is something she cannot read, rather than nothing
    expect(seen.sealed).toBe(1);
  });

  it('drops a record whose signature is not its author s', async () => {
    const { transport } = fakeRelay();
    const secret = createRoomSecret();
    const aliceId = guest(1);
    const alice = openRoom(asIdentity(aliceId, 'alice'), { relay: transport, roomSecret: secret });
    const bob = openRoom(asIdentity(guest(2), 'bob'), {
      relay: transport,
      roomSecret: secret,
    });
    await alice.send('honest');

    // A forger claiming alice's pubkey, signing with a key that is not hers.
    const other = guest(7);
    const impostor = openRoom(
      { pubkey: aliceId.pubkey, name: 'alice', sign: other.sign, verify: other.verify },
      { relay: transport, roomSecret: secret },
    );
    await impostor.send('not alice');

    const seen = await bob.sync();
    expect(seen.messages.map(m => m.body)).toEqual(['honest']);
    expect(seen.dropped).toEqual([expect.objectContaining({ reason: 'bad signature' })]);
  });

  it('carries a direct message to its named recipient, not into the public lane', () => {
    return (async () => {
      const { transport } = fakeRelay();
      const secret = createRoomSecret();
      const aliceId = guest(1);
      const bobId = guest(2);
      const carolId = guest(3);
      const alice = openRoom(asIdentity(aliceId, 'alice'), {
        relay: transport,
        roomSecret: secret,
      });
      const bob = openRoom(asIdentity(bobId, 'bob'), { relay: transport, roomSecret: secret });
      const carol = openRoom(asIdentity(carolId, 'carol'), {
        relay: transport,
        roomSecret: secret,
      });

      await alice.send('everyone can read this');
      await alice.sendDirect(bobId.pubkey, 'this one is for bob');

      const seenByBob = await bob.sync();
      expect(seenByBob.messages.map(m => [m.kind, m.body])).toEqual([
        ['msg', 'everyone can read this'],
        ['dm', 'this one is for bob'],
      ]);
      expect(seenByBob.messages[1]!.to).toBe(bobId.pubkey);

      // carol's client reads every public record and nothing of the private one,
      // because it only tries the key for messages addressed to carol - not
      // because the key is unavailable to her. She can derive it (the next test
      // proves it); the DM lane is private against non-members, not members.
      const seenByCarol = await carol.sync();
      expect(seenByCarol.messages.map(m => [m.kind, m.body])).toEqual([
        ['msg', 'everyone can read this'],
      ]);
      expect(seenByCarol.dropped).toEqual([]);
    })();
  });

  it('shows that any member can derive a peer s direct-message key', async () => {
    // The DM key is HKDF(roomSecret, ..., recipientPubkey) and every member holds
    // the room secret, so the lane is private against non-members and the relay,
    // NOT against fellow members. This pins that claim to the code.
    const { transport, shardOf } = fakeRelay();
    const secret = createRoomSecret();
    const aliceId = guest(1);
    const bobId = guest(2);
    const alice = openRoom(asIdentity(aliceId, 'alice'), { relay: transport, roomSecret: secret });
    const epoch = alice.currentEpoch();

    await alice.sendDirect(bobId.pubkey, 'just between us');
    // the shard the room itself wrote to, which the key below has to bind
    const shard = shardOf(SCOPE, epoch);

    // a member reconstructs exactly the key bob's own client would: the room
    // secret, this window's coordinates, and bob's public key. (The room keeps
    // `shardHash` in a 32-byte buffer, so the 8-byte shard is zero-padded.)
    const appScopeHash = new Uint8Array(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(SCOPE)),
    );
    const shardHash = new Uint8Array(32);
    shardHash.set(fromHex(shard));
    const raw = await hkdfBytes(
      secret,
      'veil-room-dm-v1',
      concat([appScopeHash, shardHash, u32be(epoch), fromHex(bobId.pubkey)]),
      32,
    );
    const key = await crypto.subtle.importKey('raw', ab(raw), 'AES-GCM', false, ['decrypt']);
    const aadBytes = concat([
      Uint8Array.of(0x01),
      appScopeHash,
      shardHash,
      u32be(epoch),
      Uint8Array.of(0x04),
    ]);

    const stored = await transport.getBucket({ appScope: SCOPE, epoch, shard });
    let opened: string | null = null;
    for (const entry of stored) {
      if (entry.blob[0] !== 0x01) {
        continue;
      }
      try {
        const plaintext = new Uint8Array(
          await crypto.subtle.decrypt(
            {
              name: 'AES-GCM',
              iv: ab(entry.blob.subarray(1, 13)),
              additionalData: ab(aadBytes),
            },
            key,
            ab(entry.blob.subarray(13)),
          ),
        );
        opened = new TextDecoder().decode(plaintext);
      } catch {
        // not this key - try the next entry
      }
    }
    expect(opened).toContain('just between us');
  });

  it('marks an action as an action', async () => {
    const { transport } = fakeRelay();
    const secret = createRoomSecret();
    const alice = openRoom(asIdentity(guest(1), 'alice'), { relay: transport, roomSecret: secret });
    const bob = openRoom(asIdentity(guest(2), 'bob'), { relay: transport, roomSecret: secret });

    await alice.send('waves', { kind: 'action' });
    const seen = await bob.sync();
    expect(seen.messages).toEqual([
      expect.objectContaining({ kind: 'action', body: 'waves', name: 'alice' }),
    ]);
  });

  it('refuses a direct message to itself, and a malformed recipient', async () => {
    const { transport } = fakeRelay();
    const aliceId = guest(1);
    const alice = openRoom(asIdentity(aliceId, 'alice'), {
      relay: transport,
      roomSecret: createRoomSecret(),
    });
    await expect(alice.sendDirect(aliceId.pubkey, 'note to self')).rejects.toThrow(
      /needs a recipient/,
    );
    await expect(alice.sendDirect('ab', 'to nobody')).rejects.toThrow(/64-char public key/);
  });

  it('lets a visitor with no room key read the plain lane and nothing else', async () => {
    const { transport } = fakeRelay();
    const secret = createRoomSecret();
    let now = T0;
    const member = openRoom(asIdentity(guest(1), 'member'), {
      relay: transport,
      roomSecret: secret,
      // the room is on the name coordinate, which is how the visitor finds it
      public: true,
      now: () => now,
    });
    // the visitor holds a different secret and reaches the same coordinate by
    // name: no key for the room, so the sealed lane is closed to them - which is
    // the point.
    const visitor = openRoom(asIdentity(guest(2), 'visitor'), {
      relay: transport,
      roomSecret: createRoomSecret(),
      public: true,
      now: () => now,
    });

    await member.send('sealed to the room');
    now = T0 + 1; // a moment later, as one person answering another
    await visitor.send('anyone can read this', { plain: true });
    await visitor.announce('visitor', { plain: true });

    const seenByVisitor = await visitor.sync();
    expect(seenByVisitor.messages.map(m => [m.plain, m.body])).toEqual([
      [true, 'anyone can read this'],
    ]);
    // the count a visitor needs to see: there is a conversation they cannot read
    expect(seenByVisitor.sealed).toBe(1);
    expect(seenByVisitor.present.map(p => [p.plain, p.name])).toEqual([[true, 'visitor']]);

    const seenByMember = await member.sync();
    expect(seenByMember.messages.map(m => [m.plain ?? false, m.body])).toEqual([
      [false, 'sealed to the room'],
      [true, 'anyone can read this'],
    ]);
    expect(seenByMember.sealed).toBe(0);
  });

  it('refuses a plain record replayed from a past window', async () => {
    const { transport, shardOf } = fakeRelay();
    const secret = createRoomSecret();
    let now = T0;
    const alice = openRoom(asIdentity(guest(1), 'alice'), {
      relay: transport,
      roomSecret: secret,
      now: () => now,
    });
    await alice.send('written last window, in the clear', { plain: true });
    const shard = shardOf(SCOPE, alice.currentEpoch());
    const [entry] = await transport.getBucket({
      appScope: SCOPE,
      epoch: alice.currentEpoch(),
      shard,
    });

    // the relay carries the same bytes forward and serves them as this window's:
    // a plain record signs its own window, so the reader can tell.
    now = T0 + WINDOW;
    await transport.putBucket({
      appScope: SCOPE,
      epoch: alice.currentEpoch(),
      shard,
      entries: [{ tag: entry!.tag, blob: entry!.blob }],
    });

    const bob = openRoom(asIdentity(guest(2), 'bob'), {
      relay: transport,
      roomSecret: secret,
      now: () => now,
    });
    const seen = await bob.sync(1);
    expect(seen.messages).toEqual([]);
    expect(seen.dropped).toEqual([
      expect.objectContaining({ reason: 'plain record from another window' }),
    ]);
  });

  it('refuses plain presence replayed from a past window', async () => {
    const { transport, shardOf } = fakeRelay();
    const secret = createRoomSecret();
    let now = T0;
    const alice = openRoom(asIdentity(guest(1), 'alice'), {
      relay: transport,
      roomSecret: secret,
      now: () => now,
    });
    await alice.announce('alice', { plain: true });
    const shard = shardOf(SCOPE, alice.currentEpoch());
    const [entry] = await transport.getBucket({
      appScope: SCOPE,
      epoch: alice.currentEpoch(),
      shard,
    });

    now = T0 + WINDOW;
    // the relay is not limited to serving the bytes verbatim: it rewrites the
    // window field to the current one. The unsigned presence record cannot prove
    // its window that way - the old stable tag still names the old window.
    const replay = new Uint8Array(entry!.blob);
    replay.set(u32be(alice.currentEpoch()), 3);
    await transport.putBucket({
      appScope: SCOPE,
      epoch: alice.currentEpoch(),
      shard,
      entries: [{ tag: entry!.tag, blob: replay }],
    });

    const bob = openRoom(asIdentity(guest(2), 'bob'), {
      relay: transport,
      roomSecret: secret,
      now: () => now,
    });
    const seen = await bob.sync(1);
    expect(seen.present).toEqual([]);
    expect(seen.dropped).toEqual([
      expect.objectContaining({ reason: 'plain presence tag mismatch' }),
    ]);
  });

  it('continues a persisted chain head across a fresh session', async () => {
    const { transport } = fakeRelay();
    const secret = createRoomSecret();
    const aliceId = guest(1);
    const alice = openRoom(asIdentity(aliceId, 'alice'), { relay: transport, roomSecret: secret });
    await alice.send('one');
    const carried = alice.chainHead();

    // a reload, a second tab, a second device: starts from the persisted head
    // instead of restarting at seq 0.
    const resumed = openRoom(asIdentity(aliceId, 'alice'), {
      relay: transport,
      roomSecret: secret,
      head: carried,
    });
    await resumed.sync();
    const next = await resumed.send('two');
    expect(next.seq).toBe(2);
    expect(next.prev).toBe(carried.hash);

    const bob = openRoom(asIdentity(guest(2), 'bob'), { relay: transport, roomSecret: secret });
    const seen = await bob.sync();
    expect(seen.messages.map(m => m.body)).toEqual(['one', 'two']);
    expect(seen.dropped).toEqual([]);
  });

  it('refuses a relay that rolls this author s chain head back', async () => {
    const { transport, omit } = fakeRelay();
    const secret = createRoomSecret();
    const aliceId = guest(1);
    const alice = openRoom(asIdentity(aliceId, 'alice'), { relay: transport, roomSecret: secret });
    await alice.send('one');
    await alice.send('two');
    const carried = alice.chainHead();

    // a withholding relay drops the author's newest record...
    omit(SCOPE, alice.currentEpoch(), 1);

    const resumed = openRoom(asIdentity(aliceId, 'alice'), {
      relay: transport,
      roomSecret: secret,
      head: carried,
    });
    const seen = await resumed.sync();
    // ...and the session refuses to adopt the lower head it is handed: doing so
    // would re-sign a (seq, prev) pair this author already used.
    expect(resumed.chainHead()).toEqual(carried);
    expect(seen.dropped).toEqual([
      expect.objectContaining({
        reason: `chain head rollback: room holds seq 1, this author is at 2`,
      }),
    ]);
  });

  it('reports a corroborated gap above the author s head instead of adopting it', async () => {
    const { transport, omit } = fakeRelay();
    const secret = createRoomSecret();
    const aliceId = guest(1);
    const alice = openRoom(asIdentity(aliceId, 'alice'), { relay: transport, roomSecret: secret });
    await alice.send('one');
    await alice.send('two');
    await alice.send('three');
    // a session that only ever persisted the head after seq 1
    const carried = { seq: 1, hash: (await alice.sync(1)).messages[0]!.hash };

    // the relay serves seq 3 without seq 2, so the reply cannot link to the head
    omit(SCOPE, alice.currentEpoch(), 1);

    const resumed = openRoom(asIdentity(aliceId, 'alice'), {
      relay: transport,
      roomSecret: secret,
      head: carried,
    });
    const seen = await resumed.sync();
    expect(resumed.chainHead()).toEqual(carried);
    expect(seen.dropped).toEqual([
      expect.objectContaining({
        reason: `chain head gap: no record links to this author's head at seq 1`,
      }),
    ]);
  });

  it('refuses to send a direct message in the clear', async () => {
    const { transport } = fakeRelay();
    const secret = createRoomSecret();
    const aliceId = guest(1);
    const bobId = guest(2);
    const alice = openRoom(asIdentity(aliceId, 'alice'), { relay: transport, roomSecret: secret });

    // a dm is sealed or it is not a dm; there is no plaintext direct message
    await expect(alice.send('psst', { plain: true, kind: 'msg' })).resolves.toBeTruthy();
    const bob = openRoom(asIdentity(bobId, 'bob'), { relay: transport, roomSecret: secret });
    const seen = await bob.sync();
    expect(seen.messages.map(m => [m.plain, m.body])).toEqual([[true, 'psst']]);
  });

  it('shows nothing for a record tampered with in flight', async () => {
    const { transport, tamper } = fakeRelay();
    const secret = createRoomSecret();
    const alice = openRoom(asIdentity(guest(1), 'alice'), {
      relay: transport,
      roomSecret: secret,
    });
    const bob = openRoom(asIdentity(guest(2), 'bob'), {
      relay: transport,
      roomSecret: secret,
    });
    await alice.send('honest');
    tamper(SCOPE, alice.currentEpoch(), 0);

    const seen = await bob.sync();
    expect(seen.messages).toEqual([]);
  });

  it('reports a rewritten chain rather than passing it off as history', async () => {
    const { transport } = fakeRelay();
    const secret = createRoomSecret();
    const alice = openRoom(asIdentity(guest(1), 'alice'), {
      relay: transport,
      roomSecret: secret,
    });
    const bob = openRoom(asIdentity(guest(2), 'bob'), {
      relay: transport,
      roomSecret: secret,
    });

    const first = await alice.send('one', { seq: 1 });
    await alice.send('two', { seq: 2, prev: 'ff'.repeat(32) }); // an unlinked rewrite

    const seen = await bob.sync();
    expect(seen.messages.map(m => m.body)).toEqual(['one', 'two']);
    expect(seen.messages[0]!.hash).toBe(first.hash);
    expect(seen.dropped).toEqual([expect.objectContaining({ reason: 'chain break after seq 1' })]);
  });

  it('writes the same number of bytes for a word and for a paragraph', async () => {
    const { transport, shardOf } = fakeRelay();
    const secret = createRoomSecret();
    const alice = openRoom(asIdentity(guest(1), 'alice'), {
      relay: transport,
      roomSecret: secret,
    });
    await alice.send('hi');
    await alice.send('x'.repeat(400));
    await alice.announce();

    const stored = await transport.getBucket({
      appScope: SCOPE,
      epoch: alice.currentEpoch(),
      shard: shardOf(SCOPE, alice.currentEpoch()),
    });
    const sizes = stored.map(e => e.blob.length);
    expect(sizes.length).toBe(3);
    expect(new Set(sizes).size).toBe(1);
  });

  it('finds earlier windows and returns them oldest first', async () => {
    const { transport } = fakeRelay();
    const secret = createRoomSecret();
    let now = T0;
    const alice = openRoom(asIdentity(guest(1), 'alice'), {
      relay: transport,
      roomSecret: secret,
      now: () => now,
    });
    const bob = openRoom(asIdentity(guest(2), 'bob'), {
      relay: transport,
      roomSecret: secret,
      now: () => now,
    });

    const firstEpoch = alice.currentEpoch();
    await alice.send('in the first window');
    now = T0 + WINDOW;
    expect(bob.currentEpoch()).toBe(firstEpoch + 1); // the clock moved exactly one window
    await bob.send('in the second');

    const both = await alice.sync();
    expect(both.messages.map(m => m.body)).toEqual(['in the first window', 'in the second']);

    const currentOnly = await alice.sync(1);
    expect(currentOnly.messages.map(m => m.body)).toEqual(['in the second']);
  });

  it('announces presence once per window however often it refreshes', async () => {
    const { transport } = fakeRelay();
    const secret = createRoomSecret();
    const aliceId = guest(1);
    const alice = openRoom(asIdentity(aliceId, 'alice'), { relay: transport, roomSecret: secret });
    const bob = openRoom(asIdentity(guest(2), 'bob'), {
      relay: transport,
      roomSecret: secret,
    });

    await alice.announce('alice');
    await alice.announce('alice');
    await alice.announce('alice');

    const seen = await bob.sync();
    expect(seen.present).toEqual([
      expect.objectContaining({ author: aliceId.pubkey, name: 'alice' }),
    ]);
  });

  it('refuses an oversized message instead of truncating it', async () => {
    const { transport } = fakeRelay();
    const alice = openRoom(asIdentity(guest(1), 'alice'), {
      relay: transport,
      roomSecret: createRoomSecret(),
    });
    const limit = maxBodyBytes('alice');
    await expect(alice.send('x'.repeat(limit + 1))).rejects.toThrow(/the limit is/);
    await expect(alice.send('x'.repeat(limit))).resolves.toBeTruthy();
  });

  it('round-trips an invite and refuses a malformed one', () => {
    const secret = createRoomSecret();
    const code = encodeInvite({
      appScope: SCOPE,
      channel: '#penumbra',
      secret,
      endpoint: 'https://bouncer.veil.example',
      token: 'friend-token',
    });

    const parsed = parseInvite(code);
    expect(parsed.appScope).toBe(SCOPE);
    expect(toHex(parsed.secret)).toBe(toHex(secret));
    expect(parsed.endpoint).toBe('https://bouncer.veil.example');
    expect(parsed.token).toBe('friend-token');

    // an invite that names no relay is still an invite: a site can supply one
    const plain = parseInvite(encodeInvite({ appScope: SCOPE, channel: '#penumbra', secret }));
    expect(plain.endpoint).toBeUndefined();
    expect(plain.token).toBeUndefined();

    // the shape written before channels existed: scope.secret.endpoint.token, no
    // channel field at all - so it means the default channel
    const legacy = parseInvite(
      `zroom1:${b64(SCOPE)}.${b64Bytes(secret)}.${b64('http://127.0.0.1:8098')}.${b64('friend-token')}`,
    );
    expect(legacy.appScope).toBe(SCOPE);
    expect(legacy.channel).toBe(DEFAULT_CHANNEL);
    expect(toHex(legacy.secret)).toBe(toHex(secret));
    expect(legacy.endpoint).toBe('http://127.0.0.1:8098');
    expect(legacy.token).toBe('friend-token');

    // a public room says so, and the marker shifts the positional fields along
    const open = parseInvite(
      encodeInvite({
        appScope: SCOPE,
        channel: '#penumbra',
        secret,
        public: true,
        endpoint: 'https://bouncer.veil.example',
        token: 'friend-token',
      }),
    );
    expect(open.public).toBe(true);
    expect(open.endpoint).toBe('https://bouncer.veil.example');
    expect(open.token).toBe('friend-token');

    // public and ungated, which is the point of the flag: the marker is one
    // reserved character, so it never reads as an endpoint
    const openOnly = parseInvite(
      encodeInvite({ appScope: SCOPE, channel: '#penumbra', secret, public: true }),
    );
    expect(openOnly.public).toBe(true);
    expect(openOnly.endpoint).toBeUndefined();
    expect(openOnly.token).toBeUndefined();

    // a sealed invite says nothing: absent means the default, not `false`
    expect(parseInvite(code).public).toBeUndefined();

    // a token with no endpoint keeps its slot instead of landing in the relay's
    const tokenOnly = parseInvite(
      encodeInvite({ appScope: SCOPE, channel: '#penumbra', secret, token: 'friend-token' }),
    );
    expect(tokenOnly.endpoint).toBeUndefined();
    expect(tokenOnly.token).toBe('friend-token');

    expect(() => parseInvite('nope')).toThrow(/must start with/);
    // a truncated invite is refused, whatever shape it claims to be
    expect(() => parseInvite('zroom2:only-scope')).toThrow(/missing its scope or secret/);
    expect(() =>
      parseInvite(`zroom2:${code.slice(7).split('.')[0]}.${code.slice(7).split('.')[1]}.AAAA`),
    ).toThrow(/not 32 bytes/);
  });
});

/**
 * The coordinate a room reads and writes. Its default is the sealed mode: the
 * shard comes from the room secret, so a name is not a board anybody can find by
 * guessing it. `public: true` moves the room to the name coordinate on purpose -
 * a reader holding no key finds it by typing the name - at the cost of a
 * guessable address. Both are asserted through what a reader sees, not through
 * the field that holds the shard.
 */
describe('room coordinate', () => {
  const secretOf = (fill: number): Uint8Array => new Uint8Array(32).fill(fill);
  const shardFor = (
    identity: RoomIdentity,
    opts: Partial<RoomConfig> & { relay: RelayTransport; roomSecret: Uint8Array },
  ) => openRoom(identity, { ...opts, now: () => T0 });

  it('gives a sealed room a board of its own, so one name means one room per secret', async () => {
    const { transport } = fakeRelay();
    const alice = shardFor(asIdentity(guest(1), 'alice'), {
      relay: transport,
      roomSecret: secretOf(1),
    });
    const bob = shardFor(asIdentity(guest(2), 'bob'), {
      relay: transport,
      roomSecret: secretOf(2),
    });
    // unsealed on purpose: a plain line crosses any board both rooms share, so
    // bob's silence is the coordinate and not the seal
    await alice.send('hello', { plain: true });
    expect((await bob.sync(1)).messages).toHaveLength(0);

    // pinned to the secret-derived coordinate, the line is there - including for
    // a reader whose own secret is bob's
    const bySecret = shardFor(asIdentity(guest(3), 'carol'), {
      relay: transport,
      roomSecret: secretOf(2),
      shard: await roomShardFromSecret(SCOPE, secretOf(1)),
    });
    expect((await bySecret.sync(1)).messages.map(m => m.body)).toEqual(['hello']);

    // and it is NOT on the name coordinate: a reader pinned to the name sees
    // nothing, which is exactly what a name-guesser gets
    const byName = shardFor(asIdentity(guest(4), 'dave'), {
      relay: transport,
      roomSecret: secretOf(2),
      shard: await roomShard(SCOPE, DEFAULT_CHANNEL),
    });
    expect((await byName.sync(1)).messages).toHaveLength(0);
  });

  it('puts a public room on the name coordinate, where a keyless reader finds it', async () => {
    const { transport } = fakeRelay();
    const alice = shardFor(asIdentity(guest(1), 'alice'), {
      relay: transport,
      roomSecret: secretOf(1),
      public: true,
    });
    await alice.send('hello', { plain: true });

    // a visitor's shape: another secret, no pin, the same name - and it reads
    const visitor = shardFor(asIdentity(guest(2), 'bob'), {
      relay: transport,
      roomSecret: secretOf(9),
      public: true,
    });
    expect((await visitor.sync(1)).messages.map(m => m.body)).toEqual(['hello']);

    // while a sealed room of the same name is somewhere else and sees nothing
    const sealed = shardFor(asIdentity(guest(3), 'carol'), {
      relay: transport,
      roomSecret: secretOf(9),
    });
    expect((await sealed.sync(1)).messages).toHaveLength(0);
  });

  it('lets a pinned shard win over the mode, so a caller can address any writer', async () => {
    const { transport } = fakeRelay();
    const secret = secretOf(5);
    // sealed, yet pinned onto a stranger's board by name - the pin is explicit
    // and the mode must not quietly derive a different coordinate under it
    const pinned = shardFor(asIdentity(guest(1), 'alice'), {
      relay: transport,
      roomSecret: secret,
      shard: await roomShard(SCOPE, DEFAULT_CHANNEL),
    });
    await pinned.send('hello', { plain: true });

    const byName = shardFor(asIdentity(guest(2), 'bob'), {
      relay: transport,
      roomSecret: secret,
      shard: await roomShard(SCOPE, DEFAULT_CHANNEL),
    });
    expect((await byName.sync(1)).messages.map(m => m.body)).toEqual(['hello']);
  });
});

describe("room: plaintextBytes (blocker 1 - zirc rooms need more than chat's 1 KiB)", () => {
  /** both fetch mocks below only ever receive a string url/body; narrow instead of `String()`-coercing an object. */
  const asUrl = (input: RequestInfo | URL): string =>
    typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const asText = (body: BodyInit | null | undefined): string =>
    typeof body === 'string' ? body : '';

  it('a 4096-byte room round-trips a body close to its larger budget', async () => {
    const { transport } = fakeRelay();
    const secret = createRoomSecret();
    const alice = openRoom(asIdentity(guest(1), 'alice'), {
      relay: transport,
      roomSecret: secret,
      plaintextBytes: GROUP_ROOM_PLAINTEXT_BYTES,
    });
    const bob = openRoom(asIdentity(guest(2), 'bob'), {
      relay: transport,
      roomSecret: secret,
      plaintextBytes: GROUP_ROOM_PLAINTEXT_BYTES,
    });

    const budget = maxBodyBytes('alice', '', undefined, GROUP_ROOM_PLAINTEXT_BYTES);
    expect(budget).toBeGreaterThan(maxBodyBytes('alice')); // bigger than the 1 KiB default
    const body = 'x'.repeat(budget);
    await alice.send(body);

    const synced = await bob.sync(1);
    expect(synced.messages.map(m => m.body)).toEqual([body]);
  });

  it('a budget-exceeding body is refused with a clear error, not truncated', async () => {
    const { transport } = fakeRelay();
    const room = openRoom(asIdentity(guest(1), 'alice'), {
      relay: transport,
      roomSecret: createRoomSecret(),
      plaintextBytes: GROUP_ROOM_PLAINTEXT_BYTES,
    });
    const budget = maxBodyBytes('alice', '', undefined, GROUP_ROOM_PLAINTEXT_BYTES);
    await expect(room.send('x'.repeat(budget + 1))).rejects.toThrow(/room: message is/);
  });

  it('a reader at the 1024-byte default still opens records from another 1024-byte room', async () => {
    // plaintextBytes only changes how MUCH a room pads to, never the decode
    // path - a default-sized room's own messages are unaffected by the feature.
    const { transport } = fakeRelay();
    const secret = createRoomSecret();
    const alice = openRoom(asIdentity(guest(1), 'alice'), { relay: transport, roomSecret: secret });
    const bob = openRoom(asIdentity(guest(2), 'bob'), { relay: transport, roomSecret: secret });
    await alice.send('hello from the default room');
    expect((await bob.sync(1)).messages.map(m => m.body)).toEqual(['hello from the default room']);
  });

  it('relayLimitsFor sizes a transport large enough for the room it describes', () => {
    // the historical bug, reproduced in numbers: a 1024-byte (chat) room's
    // sealed blob is already 1053 bytes - 1404 base64 chars - bigger than
    // `@zafu/zid`'s 1024-char discovery default. relayLimitsFor must clear it.
    const chat = relayLimitsFor(ROOM_PLAINTEXT_BYTES);
    const sealedChat = sealedBlobBytes(ROOM_PLAINTEXT_BYTES);
    expect(sealedChat).toBe(1053);
    const chatBase64 = Math.ceil(sealedChat / 3) * 4;
    expect(chatBase64).toBeGreaterThan(1024); // the bug this closes
    expect(chat.maxEntryBase64).toBeGreaterThanOrEqual(chatBase64);

    const group = relayLimitsFor(GROUP_ROOM_PLAINTEXT_BYTES);
    const sealedGroup = sealedBlobBytes(GROUP_ROOM_PLAINTEXT_BYTES);
    expect(sealedGroup).toBe(4125);
    const groupBase64 = Math.ceil(sealedGroup / 3) * 4;
    expect(group.maxEntryBase64).toBeGreaterThanOrEqual(groupBase64);
    expect(group.maxEntryBase64).toBeGreaterThan(chat.maxEntryBase64);
  });

  it('a real HTTP transport sized by relayLimitsFor round-trips a 1404-char room record end to end', async () => {
    // exactly the failure mode the design doc measured: a sealed 1053-byte
    // room blob, 1404 base64 characters, against the real wire shape
    // `createHttpRelayTransport` speaks (not the in-memory fake relay).
    const coords = new Map<string, { tag: string; blob: string }[]>();
    const key = (appScope: string, epoch: number, shard: string) => `${appScope}|${epoch}|${shard}`;
    const fetchMock = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = asUrl(input);
      if (init?.method === 'POST') {
        const req = JSON.parse(asText(init?.body)) as {
          appScope: string;
          epoch: number;
          shard: string;
          entries: { tag: string; blob: string }[];
        };
        const k = key(req.appScope, req.epoch, req.shard);
        const existing = coords.get(k) ?? [];
        const byTag = new Map(existing.map(e => [e.tag, e] as const));
        for (const e of req.entries) {
          byTag.set(e.tag, e);
        }
        coords.set(k, [...byTag.values()]);
        return new Response(null, { status: 204 });
      }
      const u = new URL(url);
      const entries =
        coords.get(
          key(
            u.searchParams.get('appScope') ?? '',
            Number(u.searchParams.get('epoch')),
            u.searchParams.get('shard') ?? '',
          ),
        ) ?? [];
      return new Response(JSON.stringify({ entries }), { status: 200 });
    }) as typeof fetch;

    const limits = relayLimitsFor(GROUP_ROOM_PLAINTEXT_BYTES);
    const relay = createHttpRelayTransport({
      endpoint: 'https://relay.example/group',
      fetch: fetchMock,
      ...limits,
    });

    const secret = createRoomSecret();
    const alice = openRoom(asIdentity(guest(1), 'alice'), {
      relay,
      roomSecret: secret,
      plaintextBytes: GROUP_ROOM_PLAINTEXT_BYTES,
    });
    const bob = openRoom(asIdentity(guest(2), 'bob'), {
      relay,
      roomSecret: secret,
      plaintextBytes: GROUP_ROOM_PLAINTEXT_BYTES,
    });

    await alice.send('a group record riding a real sealed 4 KiB room');
    const synced = await bob.sync(1);
    expect(synced.messages.map(m => m.body)).toEqual([
      'a group record riding a real sealed 4 KiB room',
    ]);
    expect(synced.dropped).toHaveLength(0);
  });

  it("plaintextBytes and relayLimitsFor work the same way for a PUBLIC room (zitadel's replacement)", async () => {
    // the coordinator asked explicitly: size and retention changes must not be
    // sealed-room-only. A public room's coordinate comes from the channel
    // NAME instead of the secret (RoomConfig.public), but the record size and
    // the transport limits it needs are the same arithmetic either way - this
    // is the same real-transport harness as the sealed case above, just with
    // `public: true` and an unsealed (`plain`) send, since a public room's
    // whole point is that a keyless visitor can read it.
    const coords = new Map<string, { tag: string; blob: string }[]>();
    const key = (appScope: string, epoch: number, shard: string) => `${appScope}|${epoch}|${shard}`;
    const fetchMock = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = asUrl(input);
      if (init?.method === 'POST') {
        const req = JSON.parse(asText(init?.body)) as {
          appScope: string;
          epoch: number;
          shard: string;
          entries: { tag: string; blob: string }[];
        };
        const k = key(req.appScope, req.epoch, req.shard);
        const existing = coords.get(k) ?? [];
        const byTag = new Map(existing.map(e => [e.tag, e] as const));
        for (const e of req.entries) {
          byTag.set(e.tag, e);
        }
        coords.set(k, [...byTag.values()]);
        return new Response(null, { status: 204 });
      }
      const u = new URL(url);
      const entries =
        coords.get(
          key(
            u.searchParams.get('appScope') ?? '',
            Number(u.searchParams.get('epoch')),
            u.searchParams.get('shard') ?? '',
          ),
        ) ?? [];
      return new Response(JSON.stringify({ entries }), { status: 200 });
    }) as typeof fetch;

    const relay = createHttpRelayTransport({
      endpoint: 'https://relay.example/public-group',
      fetch: fetchMock,
      ...relayLimitsFor(GROUP_ROOM_PLAINTEXT_BYTES),
    });

    const secret = createRoomSecret(); // irrelevant to the coordinate here, still needed to seal DMs
    const alice = openRoom(asIdentity(guest(1), 'alice'), {
      relay,
      roomSecret: secret,
      plaintextBytes: GROUP_ROOM_PLAINTEXT_BYTES,
      public: true,
    });
    // a visitor with no room secret at all - the point of a public room -
    // still reads it, as long as it was built with the same size and limits.
    const visitor = openRoom(asIdentity(guest(2), 'bob'), {
      relay,
      roomSecret: createRoomSecret(),
      plaintextBytes: GROUP_ROOM_PLAINTEXT_BYTES,
      public: true,
    });

    await alice.send('a public group-sized announcement', { plain: true });
    const synced = await visitor.sync(1);
    expect(synced.messages.map(m => m.body)).toEqual(['a public group-sized announcement']);
    expect(synced.dropped).toHaveLength(0);
  });

  it('an oversize record is reported in `dropped`, never silently missing', async () => {
    // a transport built with discovery's unchanged defaults cannot carry this
    // room's 4 KiB records - every entry is refused, and the room must say so.
    const coords = new Map<string, { tag: string; blob: string }[]>();
    const key = (appScope: string, epoch: number, shard: string) => `${appScope}|${epoch}|${shard}`;
    const fetchMock = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = asUrl(input);
      if (init?.method === 'POST') {
        const req = JSON.parse(asText(init?.body)) as {
          appScope: string;
          epoch: number;
          shard: string;
          entries: { tag: string; blob: string }[];
        };
        const k = key(req.appScope, req.epoch, req.shard);
        coords.set(k, [...(coords.get(k) ?? []), ...req.entries]);
        return new Response(null, { status: 204 });
      }
      const u = new URL(url);
      const entries =
        coords.get(
          key(
            u.searchParams.get('appScope') ?? '',
            Number(u.searchParams.get('epoch')),
            u.searchParams.get('shard') ?? '',
          ),
        ) ?? [];
      return new Response(JSON.stringify({ entries }), { status: 200 });
    }) as typeof fetch;

    // one transport instance to publish with no ceiling at all (bypassing the
    // bug on the write side), another - discovery's own defaults - to read.
    const writer = createHttpRelayTransport({
      endpoint: 'https://relay.example/group',
      fetch: fetchMock,
      maxEntryBase64: 1024 * 1024,
      maxBodyBytes: 1024 * 1024,
    });
    const readerWithDiscoveryDefaults = createHttpRelayTransport({
      endpoint: 'https://relay.example/group',
      fetch: fetchMock,
    });

    const secret = createRoomSecret();
    const alice = openRoom(asIdentity(guest(1), 'alice'), {
      relay: writer,
      roomSecret: secret,
      plaintextBytes: GROUP_ROOM_PLAINTEXT_BYTES,
    });
    const bob = openRoom(asIdentity(guest(2), 'bob'), {
      relay: readerWithDiscoveryDefaults,
      roomSecret: secret,
      plaintextBytes: GROUP_ROOM_PLAINTEXT_BYTES,
    });

    await alice.send('this must not vanish');
    const synced = await bob.sync(1);

    expect(synced.messages).toHaveLength(0); // the entry never reached bob
    expect(synced.dropped.some(d => d.kind === 'oversize')).toBe(true); // but it is reported
  });
});

describe('room: Room.syncSince (blocker 2 - catching up past historyWindows)', () => {
  it('reads only the requested range, even across hundreds of injected windows', async () => {
    const { transport, bucket } = fakeRelay();
    let now = T0;
    const room = openRoom(asIdentity(guest(1), 'alice'), {
      relay: transport,
      roomSecret: createRoomSecret(),
      now: () => now,
    });

    const startEpoch = room.currentEpoch();
    await room.send('day 1');
    // jump the clock forward 200 windows (~16.7 h), as if the member were away
    // - within the 288-window (24 h) cap, so both windows are read.
    now += WINDOW * 200;
    const laterEpoch = room.currentEpoch();
    await room.send('day 2 (today)', { epoch: laterEpoch });
    // the old window's bucket still exists on this fake relay (it never sweeps),
    // standing in for the per-scope retention a group room would get.
    expect(bucket(SCOPE, startEpoch).size).toBe(1);

    const caughtUp = await room.syncSince(startEpoch, 288);
    expect(caughtUp.messages.map(m => m.body).sort()).toEqual(['day 1', 'day 2 (today)']);
  });

  it('caps how far back it reaches, even if the caller asks for more', async () => {
    const { transport, bucket } = fakeRelay();
    let now = T0;
    const room = openRoom(asIdentity(guest(1), 'alice'), {
      relay: transport,
      roomSecret: createRoomSecret(),
      now: () => now,
    });

    const oldEpoch = room.currentEpoch();
    await room.send('ancient');
    now += WINDOW * 1000;
    const recentEpoch = room.currentEpoch();
    await room.send('recent', { epoch: recentEpoch });
    expect(bucket(SCOPE, oldEpoch).size).toBe(1);

    // sinceEpoch is 1000 windows back, but maxWindows caps the walk at 10.
    const capped = await room.syncSince(oldEpoch, 10);
    expect(capped.messages.map(m => m.body)).toEqual(['recent']);
  });

  it('never runs on its own: constructing a Room makes no relay call until a method is invoked', async () => {
    let calls = 0;
    const counting: RelayTransport = {
      putBucket: async req => {
        calls += 1;
        await fakeRelay().transport.putBucket(req);
      },
      getBucket: async req => {
        calls += 1;
        return fakeRelay().transport.getBucket(req);
      },
    };

    const room = new Room(asIdentity(guest(1), 'alice'), {
      appScope: SCOPE,
      roomSecret: createRoomSecret(),
      relay: counting,
      now: () => T0,
    });
    expect(calls).toBe(0); // the constructor alone touched the relay zero times

    // restoring from a persisted head is the same story: still zero calls.
    const restored = new Room(asIdentity(guest(1), 'alice'), {
      appScope: SCOPE,
      roomSecret: createRoomSecret(),
      relay: counting,
      now: () => T0,
      head: room.chainHead(),
    });
    expect(calls).toBe(0);
    void restored;

    // only an explicit call (open/sync/send/announce) talks to the relay -
    // never extension start, unlock, or popup open, which this constructor
    // stands in for.
    await room.sync(1);
    expect(calls).toBeGreaterThan(0);
  });
});
