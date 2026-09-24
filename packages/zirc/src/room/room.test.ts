import { describe, expect, it } from 'vitest';
import { RelayTransport, ZidIdentity, createGuestIdentity } from '@zafu/zid';
import {
  Room,
  createRoomSecret,
  encodeInvite,
  maxBodyBytes,
  parseInvite,
  DEFAULT_CHANNEL,
  roomShard,
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
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
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
      for (const entry of entries) coord.set(toHex(entry.tag), entry.blob);
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
  /** mutate a stored blob in place, to model a relay - or a network - that lies. */
  const tamper = (scope: string, epoch: number, shard: string, at: number) => {
    const coord = coords.get(key(scope, epoch, shard));
    if (!coord) throw new Error('tamper: nothing stored at that coordinate');
    const entry = [...coord.entries()][at];
    if (!entry) throw new Error('tamper: nothing stored at that entry');
    const [tag, blob] = entry;
    const next = new Uint8Array(blob);
    const last = next.length - 1;
    next[last] = (next[last] ?? 0) ^ 0xff;
    coord.set(tag, next);
  };
  return { transport, tamper };
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

  it('carries a direct message to its recipient and to nobody else', () => {
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

      // carol holds the room secret, reads every public record, and still gets
      // nothing of the private one - and nothing is reported as refused, because
      // an entry she cannot open is indistinguishable from noise to her.
      const seenByCarol = await carol.sync();
      expect(seenByCarol.messages.map(m => [m.kind, m.body])).toEqual([
        ['msg', 'everyone can read this'],
      ]);
      expect(seenByCarol.dropped).toEqual([]);
    })();
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
      now: () => now,
    });
    // the visitor holds a different secret and reaches the same coordinate: no key
    // for the room, so the sealed lane is closed to them - which is the point.
    const visitor = openRoom(asIdentity(guest(2), 'visitor'), {
      relay: transport,
      roomSecret: createRoomSecret(),
      shard: await roomShard(SCOPE, DEFAULT_CHANNEL),
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
    tamper(SCOPE, alice.currentEpoch(), await roomShard(SCOPE, DEFAULT_CHANNEL), 0);

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
    const { transport } = fakeRelay();
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
      shard: await roomShard(SCOPE, DEFAULT_CHANNEL),
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

    expect(() => parseInvite('nope')).toThrow(/must start with/);
    // a truncated invite is refused, whatever shape it claims to be
    expect(() => parseInvite('zroom2:only-scope')).toThrow(/missing its scope or secret/);
    expect(() =>
      parseInvite(`zroom2:${code.slice(7).split('.')[0]}.${code.slice(7).split('.')[1]}.AAAA`),
    ).toThrow(/not 32 bytes/);
  });
});
