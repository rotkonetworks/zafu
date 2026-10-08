/**
 * Shared wallets made inside a group room with no leader (#110), with the
 * real FROST wasm on a fake relay: a roster binds only with every member's
 * signature, the viewing-key secret comes from every member's
 * commit-then-reveal, and every member derives the same wallet. A member who
 * says two things, reveals what it did not commit to, or is shown
 * differently to different devices stops it, and nothing is saved. A relay
 * that withholds or reorders only costs time. A wallet an older zafu made
 * still signs.
 *
 * @vitest-environment node
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { beforeAll, describe, expect, test, vi } from 'vitest';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import type { RelayTransport } from '@zafu/zid';
import { commitOf, genesisId, r1Id, rosterId, sortKeys } from '@zafu/zirc/leaderless';
import { encodeOrchardUnifiedAddress } from '@repo/wallet/networks/zcash/unified-address';
import { deriveRoomKeys } from '../state/identity';
import { groupId } from './groups';
import { comeIn, peopleWallet, realPake, relayBoard } from './door.test-util';
import {
  advance,
  frostOps,
  keepMine,
  majority,
  mismatched,
  packFrost,
  foldFrost,
  missingOf,
  MISSING_S,
  restartOf,
  type FrostCalls,
  type FrostIo,
  type Keygen,
  propId,
  readBody,
  type FrostBody,
  type FrostStatus,
  type Seat,
} from './frost-room';
import { keygensOf } from './lx';
import type { PeopleRoom } from './vault';
import { advanceSign, decline, proposalsOf, seal, type SignCalls } from './room-sign';

// Real FROST rounds and real sealed room messages: several seconds per test on
// a busy CI runner, well past the 5s default.
vi.setConfig({ testTimeout: 90_000, hookTimeout: 60_000 });

type Wasm = typeof import('@repo/zcash-wasm');
let W: Wasm;
let frost: FrostCalls;

beforeAll(async () => {
  // the wasm glue's thread-pool helper reads `self` at import; nothing here spawns threads
  (globalThis as { self?: unknown }).self ??= Object.assign(globalThis, { addEventListener() {} });
  const require = createRequire(import.meta.url);
  W = (await import('@repo/zcash-wasm')) as Wasm;
  W.initSync({ module: readFileSync(require.resolve('@repo/zcash-wasm/wasm')) });
  frost = {
    part1: async (n, k) => JSON.parse(W.frost_dkg_part1(n, k)),
    part2: async (s, b) => JSON.parse(W.frost_dkg_part2(s, JSON.stringify(b))),
    part3: async (s, b, p) =>
      JSON.parse(W.frost_dkg_part3(s, JSON.stringify(b), JSON.stringify(p))),
    ufvk: async (pkp, sk) => W.frost_derive_ufvk(pkp, sk, true),
    address: async (pkp, sk) =>
      encodeOrchardUnifiedAddress(hexToBytes(W.frost_derive_address_from_sk(pkp, sk, 0)), true),
  };
});

type PropBody = Extract<FrostBody, { t: 'prop' }>;
/** a payment body under its own id */
const propOf = (p: Omit<PropBody, 't' | 'id'>): PropBody => ({ t: 'prop', id: propId(p), ...p });

const PHRASES = [
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
  'legal winner thank year wave sausage worth useful legal winner thank yellow',
  'letter advice cage absurd amount doctor acoustic avoid letter advice cage above',
  'zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong',
];

const wallet = (n: number, transport: () => RelayTransport, clock: { t: number }) => {
  const base = peopleWallet(`w${n}`, PHRASES[n]!, transport, clock);
  const { service, me } = base;
  const seats: Seat[] = [];
  const room = (G: string) => base.room(groupId(G))!;
  const io = (G: string): FrostIo => ({
    post: bodies => frostOps['frost-post']({ roomId: groupId(G), bodies }, service),
    keep: (id, patch) => frostOps['frost-keep']({ roomId: groupId(G), id, patch }, service),
    save: async seat => void seats.push(seat),
  });
  return {
    ...base,
    seats,
    room,
    io,
    post: async (G: string, bodies: string[]) =>
      frostOps['frost-post']({ roomId: groupId(G), bodies }, service),
    /** the wallets being made in the room, as this member reads them */
    keygens: (G: string) => keygensOf(room(G)),
    /** this member's turn: read the room, do what can be done now, in the newest setup it is in */
    turn: async (G: string): Promise<FrostStatus> => {
      await service.check();
      const r = room(G);
      const k = me(G);
      let last: FrostStatus = 'idle';
      for (const c of keygensOf(r)) {
        const s = await advance(c, r.frost?.mine?.[c.id], k, frost, io(G), r.name);
        if (c.members.includes(k.pubkey)) {
          last = s;
        }
      }
      return last;
    },
  };
};
type Member = ReturnType<typeof wallet>;

const clockAt = () => ({ t: Date.UTC(2026, 9, 8, 12) });

/** a creator and `n - 1` people who came in by codes; `want`: made as a k-of-n shared wallet */
const group = async (n: number, want?: { k: number }, transports?: (() => RelayTransport)[]) => {
  const board = relayBoard();
  const clock = clockAt();
  const ws = Array.from({ length: n }, (_, i) => wallet(i, transports?.[i] ?? board, clock));
  const [first, ...rest] = ws;
  const { id, code } = (await first!.op('group-create', {
    name: 'studio',
    ...(want ? { k: want.k, n } : {}),
  })) as unknown as { id: string; code: string };
  const G = id.slice(2);
  const pake = await realPake();
  // one code per person
  for (const [i, w] of rest.entries()) {
    const next = i ? ((await first!.op('group-renew', { G })) as { code: string }).code : code;
    await comeIn(first!, w, next, G, clock, pake);
  }
  for (let i = 0; i < 2; i++) {
    for (const w of ws) {
      await w.service.check();
    }
  }
  expect(first!.room(G).group?.members).toHaveLength(n);
  return { ws, G, clock };
};

/** everyone takes turns until nobody can do more */
const run = async (ws: Member[], G: string, rounds = 8) => {
  let last: FrostStatus[] = [];
  for (let i = 0; i < rounds; i++) {
    last = [];
    for (const w of ws) {
      last.push(await w.turn(G));
    }
    if (last.every(s => s === 'done')) {
      break;
    }
  }
  return last;
};

const keysOf = (ws: Member[], G: string) => ws.map(w => w.me(G).pubkey);

/** "make it a shared wallet" from a chat: a fresh genesis and its roster, signed by its proposer */
const propose = async (w: Member, G: string, members: string[], k: number) => {
  await w.op('lx-wallet', { roomId: groupId(G), members, k });
};

/** each other member taps "agree and make keys" on the newest wallet it is asked into */
const agreeAll = async (ws: Member[], G: string) => {
  for (const w of ws) {
    await w.service.check();
    const c = w.keygens(G).at(-1);
    if (c && !c.agreed.has(w.me(G).pubkey) && c.members.includes(w.me(G).pubkey)) {
      await w.op('lx-agree', { roomId: groupId(G), id: c.id });
    }
  }
};

const expectOneWallet = (ws: Member[], k: number) => {
  const seats = ws.map(w => w.seats);
  seats.forEach(s => expect(s).toHaveLength(1));
  const [first] = seats[0]!;
  for (const [s] of seats) {
    expect(s!.address).toBe(first!.address);
    expect(s!.publicKeyPackage).toBe(first!.publicKeyPackage);
    // the viewing key is derived from sk: the same key on every device is the same sk
    expect(s!.orchardFvk).toBe(first!.orchardFvk);
    expect(s).toMatchObject({ threshold: k, maxSigners: ws.length, label: 'studio' });
  }
  expect(first!.address).toMatch(/^u1/);
  // each device holds its own share
  expect(new Set(seats.map(([s]) => s!.keyPackage)).size).toBe(ws.length);
  return first!;
};

describe('a shared wallet made by codes, with no leader', () => {
  test.each([
    [3, 2],
    [4, 3],
  ])('%i members, %i to send: nobody taps, one wallet, the same sk everywhere', async (n, k) => {
    const { ws, G } = await group(n, { k });
    expect(majority(n)).toBe(k);
    // every member signed the roster of all of them by itself: typing the code was the yes
    for (const w of ws) {
      const [c] = w.keygens(G);
      expect(c).toMatchObject({ k, bound: true, rival: false, byCode: true });
      expect(c!.members).toEqual(sortKeys(keysOf(ws, G)));
      expect(c!.id).toBe(rosterId({ G: genesisId(c!.G), members: c!.members }));
    }
    expect(await run(ws, G)).toEqual(ws.map(() => 'done'));
    expectOneWallet(ws, k);
    // the round secrets leave the room once the seat is saved
    for (const w of ws) {
      const mine = Object.values(w.room(G).frost?.mine ?? {})[0];
      expect(mine).toMatchObject({ saved: true });
      for (const secret of ['s1', 'si', 'kp', 'bx']) {
        expect(mine).not.toHaveProperty(secret);
      }
    }
  });

  test('out of order: members take their turns in any order and make one wallet', async () => {
    const { ws, G } = await group(3, { k: 2 });
    const orders = [
      [2, 0, 1],
      [1, 2, 0],
      [0, 2, 1],
      [2, 1, 0],
    ];
    let last: FrostStatus[] = ['idle'];
    for (let i = 0; i < 8 && !last.every(s => s === 'done'); i++) {
      last = [];
      for (const j of orders[i % orders.length]!) {
        last.push(await ws[j]!.turn(G));
      }
    }
    expect(last).toEqual(['done', 'done', 'done']);
    expectOneWallet(ws, 2);
  });

  test('a relay that withholds one member from another only costs time', async () => {
    const board = relayBoard();
    const held = new Set<string>();
    let holding = false;
    const member: () => RelayTransport = () => {
      const t = board();
      return {
        ...t,
        putBucket: async req => {
          if (holding) {
            req.entries.forEach(e => held.add(bytesToHex(e.tag)));
          }
          return t.putBucket(req);
        },
      };
    };
    const reader: () => RelayTransport = () => {
      const t = board();
      return {
        ...t,
        getBucket: async req => (await t.getBucket(req)).filter(e => !held.has(bytesToHex(e.tag))),
      };
    };
    // the relay shows member 0 everything except what member 2 says while held
    const { ws, G } = await group(3, { k: 2 }, [reader, board, member]);
    const [a, b, m] = ws as [Member, Member, Member];
    expect(await run([a, b], G, 1)).toEqual(['waiting', 'waiting']);
    holding = true;
    expect(await m.turn(G)).toBe('waiting');
    holding = false;
    // a never sees m's round two: it waits, and so does everyone who needs a's word
    expect(await run(ws, G, 4)).toEqual(['waiting', 'waiting', 'waiting']);
    expect(ws.every(w => w.seats.length === 0)).toBe(true);
    void b;
    // the relay hands it over at last: the same wallet everywhere, nothing forked
    held.clear();
    expect(await run([a, ...ws.slice(1)], G)).toEqual(['done', 'done', 'done']);
    expectOneWallet(ws, 2);
  });
});

describe('a shared wallet made from a chat', () => {
  test("nobody's device makes a share until its person agrees: agreeing is signing the roster", async () => {
    const { ws, G } = await group(3);
    await propose(ws[0]!, G, keysOf(ws, G), 2);
    expect(await run(ws, G, 2)).toEqual(['idle', 'idle', 'idle']);
    for (const w of ws.slice(1)) {
      const [c] = w.keygens(G);
      expect(c).toMatchObject({ bound: false, byCode: false, by: ws[0]!.me(G).pubkey });
      expect([...c!.agreed]).toEqual([ws[0]!.me(G).pubkey]);
      expect(c!.r1.size).toBe(0);
    }
    await agreeAll(ws.slice(1, 2), G);
    expect(await run(ws, G, 2)).toEqual(['idle', 'idle', 'idle']);
    await agreeAll(ws.slice(2), G);
    expect(await run(ws, G)).toEqual(['done', 'done', 'done']);
    expectOneWallet(ws, 2);
  });

  test('a member agrees to one roster per wallet, never two', async () => {
    const { ws, G } = await group(3);
    const [a, b] = ws as [Member, Member];
    await propose(a, G, keysOf(ws, G), 2);
    await agreeAll([b], G);
    const c = b.keygens(G)[0]!;
    // the same wallet with another roster: b already signed one for it
    await expect(
      b.op('lx-agree', {
        roomId: groupId(G),
        id: rosterId({ G: genesisId(c.G), members: [b.me(G).pubkey] }),
      }),
    ).rejects.toThrow();
    expect(b.room(G).group?.signed?.r?.[genesisId(c.G)]).toBe(c.id);
  });

  test('someone who never comes: start again without them, as a new wallet', async () => {
    const { ws, G } = await group(3);
    const [a, b, gone] = ws as [Member, Member, Member];
    await propose(a, G, keysOf(ws, G), 2);
    await agreeAll([b], G);
    // the third never opens zafu: the roster waits for their word, nothing is lost
    expect(await run([a, b], G, 3)).toEqual(['idle', 'idle']);
    const c = a.keygens(G)[0]!;
    expect(missingOf(c, c.at + 10)).toEqual([]);
    expect(missingOf(c, c.at + MISSING_S + 1)).toEqual([gone.me(G).pubkey]);
    const next = restartOf(c, [gone.me(G).pubkey])!;
    expect(next.k).toBe(2);
    await propose(a, G, next.members, next.k);
    await agreeAll([b], G);
    expect(await run([a, b], G)).toEqual(['done', 'done']);
    expect(a.seats[0]!.address).toBe(b.seats[0]!.address);
    expect(a.seats[0]).toMatchObject({ threshold: 2, maxSigners: 2 });
    // when they come back, the wallet is not theirs to join, and the first one never binds
    expect(await gone.turn(G)).toBe('idle');
    expect(gone.seats).toEqual([]);
  });

  test('starting again keeps the threshold where it fits, never below two', () => {
    const c = { k: 3, members: ['a', 'b', 'c', 'd'] };
    expect(restartOf(c, ['d'])).toEqual({ members: ['a', 'b', 'c'], k: 3 });
    expect(restartOf(c, ['c', 'd'])).toEqual({ members: ['a', 'b'], k: 2 });
    expect(restartOf(c, ['b', 'c', 'd'])).toBeUndefined();
  });
});

describe('what stops a key setup, with nothing saved', () => {
  test('a member who says two round-one broadcasts stops it', async () => {
    const { ws, G } = await group(3, { k: 2 });
    const m = ws[2]!;
    expect(await run(ws, G, 1)).toEqual(['waiting', 'waiting', 'waiting']);
    // m says round one again, with another polynomial, for the slower ones to use
    await m.service.check();
    const c = m.keygens(G)[0]!;
    const other = await frost.part1(3, 2);
    const own = c.r1.get(m.me(G).pubkey)!;
    await m.post(
      G,
      await packFrost({ t: 'r1', v: 2, id: c.id, b: other.broadcast, x: own.x, c: own.c }),
    );
    expect(await run(ws, G)).toEqual(['mismatch', 'mismatch', 'mismatch']);
    for (const w of ws) {
      expect(w.seats).toEqual([]);
      const seen = w.keygens(G)[0]!;
      expect([...seen.split]).toEqual([m.me(G).pubkey]);
      expect(mismatched(seen)).toBe(true);
    }
  });

  test('a member who reveals an s_i other than the one it committed to stops it', async () => {
    const { ws, G } = await group(3, { k: 2 });
    const m = ws[2]!;
    expect(await run(ws, G, 1)).toEqual(['waiting', 'waiting', 'waiting']);
    // m's device lies about its share of the viewing-key secret after committing
    const c = m.keygens(G)[0]!;
    await m.service.api.updateRoom(groupId(G), r => ({
      ...r,
      frost: {
        ...r.frost!,
        mine: { ...r.frost!.mine, [c.id]: { ...r.frost!.mine![c.id], si: 'ee'.repeat(32) } },
      },
    }));
    const last = await run(ws, G);
    expect(last.slice(0, 2)).toEqual(['mismatch', 'mismatch']);
    for (const w of ws) {
      expect(w.seats).toEqual([]);
    }
  });

  test('a member shown differently to two devices: they never make keys from it', async () => {
    // A is handed one round one from M, B another; neither sees both, so only h1 tells
    const [A, B, M] = PHRASES.slice(0, 3).map(ph => deriveRoomKeys(ph, 0, 'aa'.repeat(16)));
    const members = sortKeys([A!.pubkey, B!.pubkey, M!.pubkey]);
    const R = 'c'.repeat(64);
    const at = (k: string) => members.indexOf(k);
    const s = { a: 'a1'.repeat(32), b: 'b1'.repeat(32), m: 'c1'.repeat(32) };
    const [pa, pb, x, y] = [
      await frost.part1(3, 2),
      await frost.part1(3, 2),
      await frost.part1(3, 2),
      await frost.part1(3, 2),
    ];
    const rec = (k: string, b: string, xw: string, si: string) => {
      const r = { b, x: xw, c: commitOf(R, at(k), si) };
      return { ...r, id: r1Id({ R, member: k, ...r }) };
    };
    const keygen = (mb: string): Keygen => ({
      id: R,
      G: { purpose: 'wallet', t: 2, n: 3, salt: 'aa'.repeat(16), creator: A!.pubkey },
      k: 2,
      members,
      by: A!.pubkey,
      at: 1,
      last: 1,
      agreed: new Set(members),
      byCode: true,
      bound: true,
      rival: false,
      r1: new Map([
        [A!.pubkey, rec(A!.pubkey, pa!.broadcast, A!.xwingPublicKey, s.a)],
        [B!.pubkey, rec(B!.pubkey, pb!.broadcast, B!.xwingPublicKey, s.b)],
        [M!.pubkey, rec(M!.pubkey, mb, M!.xwingPublicKey, s.m)],
      ]),
      r2: new Map(),
      fvk: new Map(),
      split: new Set(),
    });
    const kept: Record<string, Record<string, unknown>> = {
      a: { s1: pa!.secret, b1: pa!.broadcast, si: s.a },
      b: { s1: pb!.secret, b1: pb!.broadcast, si: s.b },
    };
    const saved: Seat[] = [];
    const part3 = vi.fn(frost.part3);
    const calls = { ...frost, part3 };
    const ioOf = (who: 'a' | 'b'): FrostIo => ({
      post: async () => undefined,
      keep: async (_id, patch) => (kept[who] = keepMine(kept[who], patch) as never),
      save: async seat => void saved.push(seat),
    });
    const ca = keygen(x!.broadcast);
    const cb = keygen(y!.broadcast);
    expect(await advance(ca, kept['a'], A!, calls, ioOf('a'), 'studio')).toBe('waiting');
    expect(await advance(cb, kept['b'], B!, calls, ioOf('b'), 'studio')).toBe('waiting');
    const ha = kept['a']!['h1'] as string;
    const hb = kept['b']!['h1'] as string;
    expect(hb).not.toBe(ha);
    const r2 = (who: 'a' | 'b') => ({
      p: kept[who]!['p2'] as string[],
      s: kept[who]!['bx'] as string[],
      h1: kept[who]!['h1'] as string,
      id: 'r2',
    });
    ca.r2.set(B!.pubkey, r2('b')).set(M!.pubkey, { p: ['00'], s: ['', '', ''], h1: ha, id: 'm' });
    cb.r2.set(A!.pubkey, r2('a')).set(M!.pubkey, { p: ['00'], s: ['', '', ''], h1: hb, id: 'm' });
    expect(await advance(ca, kept['a'], A!, calls, ioOf('a'), 'studio')).toBe('mismatch');
    expect(await advance(cb, kept['b'], B!, calls, ioOf('b'), 'studio')).toBe('mismatch');
    expect(mismatched(ca)).toBe(true);
    expect(part3).not.toHaveBeenCalled();
    expect(saved).toEqual([]);
  });

  test('an unbound roster makes no keys at all', async () => {
    const { ws, G } = await group(3);
    await propose(ws[0]!, G, keysOf(ws, G), 2);
    await ws[0]!.service.check();
    const c = ws[0]!.keygens(G)[0]!;
    expect(c.bound).toBe(false);
    const io = ws[0]!.io(G);
    const part1 = vi.fn(frost.part1);
    expect(await advance(c, undefined, ws[0]!.me(G), { ...frost, part1 }, io, 'studio')).toBe(
      'idle',
    );
    expect(part1).not.toHaveBeenCalled();
  });
});

describe('the wallet it makes', () => {
  test('is compared as a commitment: the viewing key and the s_i are never said in the room', async () => {
    const { ws, G } = await group(2, { k: 2 });
    expect(await run(ws, G)).toEqual(['done', 'done']);
    const ufvk = ws[0]!.seats[0]!.orchardFvk;
    expect(ufvk).toMatch(/^uview/);
    for (const w of ws) {
      const msgs = w.room(G).frost?.msgs ?? [];
      expect(JSON.stringify(msgs)).not.toContain(ufvk);
      const fvks = msgs.filter(m => m.body.t === 'fvk');
      expect(fvks).toHaveLength(2);
      expect(new Set(fvks.map(m => (m.body as { h: string }).h)).size).toBe(1);
    }
  });

  test('signs a payment: proposed, sealed by two, declined by one, signed in the room', async () => {
    const { ws, G } = await group(3, { k: 2 });
    expect(await run(ws, G)).toEqual(['done', 'done', 'done']);
    await pay(
      ws,
      G,
      ws.map(w => w.seats[0]!),
    );
  });
});

const callsOf = (s: Seat, sent: string[][]): SignCalls => ({
  round1: async () => JSON.parse(W.frost_sign_round1(s.ephemeralSeed, s.keyPackage)),
  sign: async (n, h, alpha, cm) =>
    W.frost_spend_sign_round2_signed(
      s.ephemeralSeed,
      s.keyPackage,
      n,
      h,
      alpha,
      JSON.stringify(cm),
    ),
  aggregate: async (h, alpha, cm, sh) =>
    W.frost_spend_aggregate(s.publicKeyPackage, h, alpha, JSON.stringify(cm), JSON.stringify(sh)),
  complete: async (_p, sigs) => (sent.push(sigs), 'ab'.repeat(32)),
});

/** a 2-of-3 payment through the room's records, from these seats */
const pay = async (ws: Member[], G: string, seats: Seat[]) => {
  const [a, b, c] = ws as [Member, Member, Member];
  const seat = seats[0]!;
  const wallet = { ceremony: seat.ceremony, members: seat.members, threshold: 2 };
  const sent: string[][] = [];
  // two spends: two alphas, one share each per signer
  const alphas = ['01'.padEnd(64, '0'), '02'.padEnd(64, '0')];
  const prop = propOf({
    w: seat.ceremony,
    by: a.me(G).pubkey,
    to: 'u1someone',
    amt: '125000000',
    fee: '10000',
    sighash: bytesToHex(crypto.getRandomValues(new Uint8Array(32))),
    alphas,
    si: [0, 1],
    pczt: 'aa',
  });
  await a.post(G, await packFrost(prop));
  await seal(prop, callsOf(seat, sent), a.io(G));
  const view = async (w: Member) => {
    await w.service.check();
    const r = w.room(G);
    return { p: proposalsOf(r.frost?.msgs, wallet)[0]!, mine: r.frost?.mine?.[prop.id] };
  };
  {
    const { p } = await view(b);
    expect(p).toMatchObject({ by: a.me(G).pubkey, amt: '125000000' });
    await seal(p, callsOf(seats[1]!, sent), b.io(G));
    await decline((await view(c)).p, c.io(G));
  }
  let status = '';
  for (let i = 0; i < 6 && status !== 'sent'; i++) {
    for (const [j, w] of [a, b, c].entries()) {
      const { p, mine } = await view(w);
      const s = await advanceSign(
        p,
        wallet,
        mine,
        w.me(G).pubkey,
        callsOf(seats[j]!, sent),
        w.io(G),
      );
      if (w === a) {
        status = s;
      }
    }
  }
  expect(status).toBe('sent');
  // one aggregated signature per spend, each verified by frost against the group key
  expect(sent).toHaveLength(1);
  expect(sent[0]!.map(x => x.length)).toEqual([128, 128]);
  const { p, mine: bMine } = await view(b);
  expect(p.set).toEqual([a.me(G).pubkey, b.me(G).pubkey]);
  expect(p.no).toEqual(new Set([c.me(G).pubkey]));
  expect(p.sent).toBe('ab'.repeat(32));
  // a nonce signs once: gone from the device the moment its share left
  expect(bMine).toMatchObject({ released: true });
  expect(bMine).not.toHaveProperty('n');
};

describe('a wallet an older zafu made', () => {
  test('still signs: payments read the saved seat, never how its keys were made', async () => {
    const { ws, G } = await group(3);
    // keys made the old way: a 16-byte ceremony id, a viewing-key secret one member sampled
    const ceremony = 'ce'.repeat(16);
    const members = keysOf(ws, G);
    const r1 = await Promise.all(ws.map(() => frost.part1(3, 2)));
    const r2 = await Promise.all(
      r1.map((r, i) =>
        frost.part2(
          r.secret,
          r1.filter((_, j) => j !== i).map(x => x.broadcast),
        ),
      ),
    );
    const sk = W.frost_sample_fvk_sk();
    const seats: Seat[] = await Promise.all(
      ws.map(async (_, i) => {
        const r = await frost.part3(
          r2[i]!.secret,
          r1.filter((_, j) => j !== i).map(x => x.broadcast),
          r2.filter((_, j) => j !== i).flatMap(x => x.peer_packages),
        );
        return {
          ceremony,
          members,
          label: 'studio',
          threshold: 2,
          maxSigners: 3,
          address: await frost.address(r.public_key_package, sk),
          orchardFvk: await frost.ufvk(r.public_key_package, sk),
          keyPackage: r.key_package,
          publicKeyPackage: r.public_key_package,
          ephemeralSeed: r.ephemeral_seed,
        };
      }),
    );
    // an older zafu's key records still in the room are read only as "older"
    await ws[0]!.post(
      G,
      await packFrost({ t: 'start', id: ceremony, k: 2, m: members, label: 'x' } as never),
    );
    await ws[1]!.service.check();
    expect(ws[1]!.room(G).frost!.msgs.some(m => m.body.t === 'old')).toBe(true);
    expect(ws[1]!.keygens(G)).toEqual([]);
    await pay(ws, G, seats);
  });
});

describe('room records a peer can write', () => {
  const key = 'b'.repeat(64);
  const sig = 'a'.repeat(128);
  const roster = { G: 'd'.repeat(64), members: sortKeys([key, 'c'.repeat(64)]) };
  const rs = { t: 'rs', v: 2, id: rosterId(roster), r: roster, k: key, sig };

  test.each([
    ['a roster under an id that is not its own', { ...rs, id: 'e'.repeat(64) }],
    ['a roster out of order', { ...rs, r: { ...roster, members: [...roster.members].reverse() } }],
    ['a roster signature that is not hex', { ...rs, sig: 'x'.repeat(128) }],
    ['a genesis under an id that is not its own', { t: 'g', v: 2, id: 'e'.repeat(64), g: {} }],
    ['a join whose id is not its invite', { t: 'join', v: 2, id: 'e'.repeat(64), j: {}, js: sig }],
    ['an r1 without its commitment', { t: 'r1', v: 2, id: 'e'.repeat(64), b: 'aa', x: 'bb' }],
    ['an r2 without its reveals', { t: 'r2', v: 2, id: 'e'.repeat(64), p: ['aa'], h1: key }],
    ['an fvk with the viewing key in it', { t: 'fvk', v: 2, id: key, u: 'uview1...' }],
    ['a set naming someone twice', { t: 'set', id: 'a'.repeat(32), m: [key, key] }],
    ['a sent that is not a txid', { t: 'sent', id: 'a'.repeat(32), tx: 'nope' }],
    ['no id', { t: 'no' }],
    ['null', null],
    ['an array', [rs]],
    [
      'an invite under an id that is not its own',
      {
        t: 'i',
        v: 2,
        id: 'e'.repeat(64),
        i: { G: key, owner: key, plate: 7, salt: 'a'.repeat(32), expiry: 1 },
        sig,
      },
    ],
    [
      'a rotation whose roster is not the one it names',
      {
        t: 'rot',
        v: 2,
        id: 'e'.repeat(64),
        rot: { R: 'e'.repeat(64), from: key, to: key },
        r: roster,
        k: key,
        sig,
      },
    ],
    [
      'a join whose proof is not hex',
      { t: 'join', v: 2, id: key, j: { I: key, joiner: key, th: key }, js: sig, jm: 'zz' },
    ],
    ['a bundle with nothing readable in it', { t: 'all', v: 2, id: 'a'.repeat(32), items: [{}] }],
  ])('%s is not read', (_name, body) => {
    expect(readBody(body)).toBeUndefined();
  });

  test('what is read is built again from the checked fields only', () => {
    expect(readBody({ ...rs, more: '<b>', r: { ...roster, evil: 1 } })).toEqual(rs);
  });

  test("an older zafu's key records are read as that, and nothing more", () => {
    for (const t of ['start', 'sk', 'r1', 'r2', 'fvk']) {
      expect(readBody({ t, id: 'a'.repeat(32), m: [key] })).toEqual({
        t: 'old',
        id: 'a'.repeat(32),
      });
    }
  });

  test('a payment said under an id that is not its own is not read', () => {
    const p = propOf({
      w: 'a'.repeat(64),
      by: key,
      to: 'u1someone',
      amt: '100',
      fee: '10',
      sighash: '0'.repeat(64),
      alphas: ['1'.repeat(64)],
      si: [0],
      pczt: 'aa',
    });
    expect(readBody(p)).toEqual(p);
    expect(readBody({ ...p, to: 'u1mallory' })).toBeUndefined();
    expect(readBody({ ...p, by: 'c'.repeat(64) })).toBeUndefined();
  });

  test('malformed records are dropped as they arrive', async () => {
    const room = { id: 'g:x', kind: 'group' } as PeopleRoom;
    const records = (
      await Promise.all([packFrost({ ...rs, id: 'e'.repeat(64) } as never), packFrost(rs as never)])
    ).flat();
    const fold = await foldFrost(
      room,
      records.map((body, i) => ({ author: key, ts: 1, body, hash: String(i) }) as never),
    );
    expect(fold!(room).frost!.msgs.map(m => m.body)).toEqual([rs]);
  });
});
