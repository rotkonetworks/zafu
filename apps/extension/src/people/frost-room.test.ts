/**
 * Shared wallets made inside a group room, with the real FROST wasm: three and
 * four members on a fake relay make one wallet and all derive the same
 * address; a member who never comes is left out by starting again without
 * them; a threshold changed after the first start replaces it.
 *
 * @vitest-environment node
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { beforeAll, describe, expect, test, vi } from 'vitest';
import { scryptAsync } from '@noble/hashes/scrypt';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import type { RelayTransport } from '@zafu/zid';
import { encodeOrchardUnifiedAddress } from '@repo/wallet/networks/zcash/unified-address';
import { deriveRoomKeys } from '../state/identity';
import { chain, createPeopleService } from './service';
import { createGroups, doorId, groupId } from './groups';
import { identityOf } from './keys';
import {
  advance,
  allowedIn,
  ceremonyOf,
  COURT,
  frostOps,
  majority,
  packFrost,
  startBody,
  foldFrost,
  missingOf,
  MISSING_S,
  restartOf,
  type Ceremony,
  type FrostCalls,
  type FrostIo,
  type FrostStatus,
  type Seat,
} from './frost-room';
import type { PeopleRoom, Thread } from './vault';
import { advanceSign, decline, proposalsOf, seal, type SignCalls } from './room-sign';

// Real FROST rounds and real sealed room messages: several seconds per test on
// a busy CI runner, well past the 5s default.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

// The door code's scrypt (N 2^16, 64 MiB) is paid by the founder and by every
// joiner, so it was most of each test's set-up time. These tests are about the
// wallet made in the room, not the door's cost; groups.test.ts keeps the real
// one. Same scrypt and salt, a cheap N: still one secret per code everywhere.
vi.mock('./door', async importOriginal => {
  const door = await importOriginal<typeof import('./door')>();
  return {
    ...door,
    doorSecret: (code: string) =>
      scryptAsync(
        new TextEncoder().encode(door.normalizeCode(code)),
        new TextEncoder().encode('zafu-group-door-v2'),
        { ...door.DOOR_KDF, N: 2 ** 4 },
      ),
  };
});

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
    sampleSk: async () => W.frost_sample_fvk_sk(),
    ufvk: async (pkp, sk) => W.frost_derive_ufvk(pkp, sk, true),
    address: async (pkp, sk) =>
      encodeOrchardUnifiedAddress(hexToBytes(W.frost_derive_address_from_sk(pkp, sk, 0)), true),
  };
});

const relayBoard = () => {
  const board = new Map<string, Map<string, Uint8Array>>();
  return (): RelayTransport => ({
    putBucket: async req => {
      const k = `${req.appScope}|${req.epoch}|${req.shard}`;
      const coord = board.get(k) ?? new Map();
      req.entries.forEach(e => coord.set(bytesToHex(e.tag), e.blob));
      board.set(k, coord);
    },
    getBucket: async req =>
      [...(board.get(`${req.appScope}|${req.epoch}|${req.shard}`)?.entries() ?? [])].map(
        ([tag, blob]) => ({ tag: hexToBytes(tag), blob }),
      ),
  });
};

const PHRASES = [
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
  'legal winner thank year wave sausage worth useful legal winner thank yellow',
  'letter advice cage absurd amount doctor acoustic avoid letter advice cage above',
  'zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong',
];

const wallet = (n: number, transport: () => RelayTransport, clock: { t: number }) => {
  const walletId = `w${n}`;
  const phrase = PHRASES[n]!;
  let rooms: PeopleRoom[] = [];
  let threads: Record<string, Thread> = {};
  const keys = async (_w: string, gen: number, G: string) => deriveRoomKeys(phrase, gen, G);
  const groups = createGroups({
    walletId: async () => walletId,
    keys,
    generation: async () => 0,
    relay: async () => 'https://relay.example',
    gate: async () => 'on',
    transport,
    now: () => clock.t,
  });
  const service = createPeopleService(
    {
      readRooms: async () => structuredClone(rooms),
      writeRooms: async r => ((rooms = structuredClone(r)), true),
      readThreads: async () => structuredClone(threads),
      writeThreads: async t => ((threads = structuredClone(t)), true),
      walletId: async () => walletId,
      identity: async room => identityOf(await keys(walletId, room.signer.gen, room.signer.G!)),
      gate: async () => 'on',
      transport,
      status: () => undefined,
      now: () => clock.t,
    },
    { ...groups.handlers, group: chain(groups.handlers.group, foldFrost) },
  );
  const op = (name: keyof typeof groups.ops, args: Record<string, unknown>) =>
    groups.ops[name](args, service) as Promise<never>;
  const seats: Seat[] = [];
  const me = (G: string) => deriveRoomKeys(phrase, 0, G);
  const room = (G: string) => rooms.find(r => r.id === groupId(G))!;
  return {
    service,
    op,
    seats,
    me,
    room,
    post: async (G: string, bodies: string[]) =>
      frostOps['frost-post']({ roomId: groupId(G), bodies }, service),
    io: (G: string): FrostIo => ({
      post: bodies => frostOps['frost-post']({ roomId: groupId(G), bodies }, service),
      keep: (id, patch) => frostOps['frost-keep']({ roomId: groupId(G), id, patch }, service),
      save: async seat => void seats.push(seat),
    }),
    /** this member's turn: read the room, do what can be done now */
    turn: async (G: string): Promise<FrostStatus> => {
      await service.check();
      const r = room(G);
      const k = me(G);
      const c = ceremonyOf(r.frost?.msgs, allowedIn(r, k.pubkey));
      return advance(c, c && r.frost?.mine?.[c.id], k, frost, {
        post: bodies => frostOps['frost-post']({ roomId: r.id, bodies }, service),
        keep: (id, patch) => frostOps['frost-keep']({ roomId: r.id, id, patch }, service),
        save: async seat => void seats.push(seat),
      });
    },
  };
};

/** a founder and `n - 1` people it allowed, all reading the same group */
const group = async (n: number) => {
  const transport = relayBoard();
  const clock = { t: Date.UTC(2026, 9, 4, 12) };
  const ws = Array.from({ length: n }, (_, i) => wallet(i, transport, clock));
  const [founder, ...rest] = ws;
  const { id, code } = (await founder!.op('group-create', { name: 'studio' })) as unknown as {
    id: string;
    code: string;
  };
  const G = id.slice(2);
  for (const w of rest) {
    await w.op('door-ask', { code });
  }
  await founder!.service.open();
  for (const w of rest) {
    await founder!.op('group-allow', { G, key: w.me(G).pubkey });
  }
  for (const w of rest) {
    await w.service.open();
    await w.service.settled();
    await w.service.check();
  }
  expect(founder!.room(G).group?.members).toHaveLength(n);
  expect(founder!.room(doorId(G))).toBeUndefined();
  return { ws, G, clock };
};

/** everyone takes turns until nobody can do more */
const run = async (ws: ReturnType<typeof wallet>[], G: string, rounds = 8) => {
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

const start = async (
  w: ReturnType<typeof wallet>,
  G: string,
  members: string[],
  k: number,
  replaces?: string,
) => w.post(G, await packFrost(startBody(members, k, 'studio', { replaces })));

const current = (w: ReturnType<typeof wallet>, G: string) =>
  ceremonyOf(w.room(G).frost?.msgs, allowedIn(w.room(G), w.me(G).pubkey))!;

describe('a shared wallet made in its group room', () => {
  test.each([
    [3, 2],
    [4, 3],
  ])('%i members, %i to send: one wallet, the same address everywhere', async (n, k) => {
    const { ws, G } = await group(n);
    expect(majority(n)).toBe(k);
    await start(
      ws[0]!,
      G,
      ws.map(w => w.me(G).pubkey),
      k,
    );
    expect(await run(ws, G)).toEqual(ws.map(() => 'done'));

    const seats = ws.map(w => w.seats);
    seats.forEach(s => expect(s).toHaveLength(1));
    const [first] = seats[0]!;
    for (const [s] of seats) {
      expect(s!.address).toBe(first!.address);
      expect(s!.publicKeyPackage).toBe(first!.publicKeyPackage);
      expect(s!.orchardFvk).toBe(first!.orchardFvk);
      expect(s).toMatchObject({ threshold: k, maxSigners: n, label: 'studio' });
    }
    expect(first!.address).toMatch(/^u1/);
    // each device holds its own share
    expect(new Set(seats.map(([s]) => s!.keyPackage)).size).toBe(n);
    // the round secrets leave the room once the seat is saved
    for (const w of ws) {
      const mine = Object.values(w.room(G).frost?.mine ?? {})[0];
      expect(mine).toMatchObject({ saved: true });
      expect(mine).not.toHaveProperty('s1');
      expect(mine).not.toHaveProperty('kp');
    }
  });

  test('someone who never comes: start again without them', async () => {
    const { ws, G } = await group(3);
    const [a, b, gone] = ws;
    await start(
      a!,
      G,
      ws.map(w => w.me(G).pubkey),
      2,
    );
    // the third member never opens zafu: the other two wait, nothing is lost
    expect(await run([a!, b!], G, 3)).toEqual(['waiting', 'waiting']);
    const c = ceremonyOf(a!.room(G).frost?.msgs, () => true)!;
    expect(c.members.filter(m => !c.r1.has(m))).toEqual([gone!.me(G).pubkey]);

    await start(a!, G, [a!.me(G).pubkey, b!.me(G).pubkey], 2, c.id);
    expect(await run([a!, b!], G)).toEqual(['done', 'done']);
    expect(a!.seats[0]!.address).toBe(b!.seats[0]!.address);
    expect(a!.seats[0]).toMatchObject({ threshold: 2, maxSigners: 2 });
    // when they come back, the wallet is not theirs to join
    expect(await gone!.turn(G)).toBe('idle');
    expect(gone!.seats).toEqual([]);
  });

  test('the starter goes quiet after round one: another member starts again without them', async () => {
    const { ws, G } = await group(3);
    const [a, b, c] = ws;
    await start(
      a!,
      G,
      ws.map(w => w.me(G).pubkey),
      2,
    );
    // the starter answers its own start, then never comes back: no viewing key is sent
    expect(await a!.turn(G)).toBe('waiting');
    expect(await run([b!, c!], G, 2)).toEqual(['waiting', 'waiting']);
    await b!.service.check();
    const cer = current(b!, G);
    expect(cer.sk).toBeUndefined();
    // the card shows the ones behind once the ceremony stands still
    expect(missingOf(cer, cer.last + 10)).toEqual([]);
    const gone = missingOf(cer, cer.last + MISSING_S + 1);
    // only the starter holds it up: the others did all they could without it
    expect(gone).toEqual([a!.me(G).pubkey]);
    const next = restartOf(cer, gone)!;
    expect(next).toEqual({ members: [b!.me(G).pubkey, c!.me(G).pubkey], k: 2 });
    await b!.post(
      G,
      await packFrost(startBody(next.members, next.k, 'studio', { replaces: cer.id })),
    );
    expect(await run([b!, c!], G)).toEqual(['done', 'done']);
    expect(b!.seats[0]!.address).toBe(c!.seats[0]!.address);
    expect(await a!.turn(G)).toBe('idle');
  });

  test('starting again keeps the threshold where it fits, never below two', () => {
    const c = { k: 3, members: ['a', 'b', 'c', 'd'] } as Ceremony;
    expect(restartOf(c, ['d'])).toEqual({ members: ['a', 'b', 'c'], k: 3 });
    expect(restartOf(c, ['c', 'd'])).toEqual({ members: ['a', 'b'], k: 2 });
    expect(restartOf(c, ['b', 'c', 'd'])).toBeUndefined();
    expect(restartOf({ k: 2, members: ['a', 'b', COURT] } as Ceremony, [COURT])).toEqual({
      members: ['a', 'b'],
      k: 2,
    });
  });

  test('the threshold changed after the first start: the new start replaces it', async () => {
    const { ws, G } = await group(3);
    const members = ws.map(w => w.me(G).pubkey);
    await start(ws[0]!, G, members, 2);
    // one member already answered the first start
    expect(await ws[1]!.turn(G)).toBe('waiting');
    await start(ws[0]!, G, members, 3, current(ws[1]!, G).id);
    expect(await run(ws, G)).toEqual(['done', 'done', 'done']);
    for (const w of ws) {
      expect(w.seats).toHaveLength(1);
      expect(w.seats[0]).toMatchObject({ threshold: 3, maxSigners: 3 });
    }
    expect(new Set(ws.map(w => w.seats[0]!.address)).size).toBe(1);
  });

  test('a deal waits for the other side to agree to its terms', async () => {
    const { ws, G } = await group(2);
    const [a, b] = ws;
    const deal = { amount: '125000000', what: 'logo design', payer: 'proposer' as const };
    await a!.post(
      G,
      await packFrost(startBody([a!.me(G).pubkey, b!.me(G).pubkey], 2, deal.what, { deal })),
    );
    expect(await run(ws, G, 2)).toEqual(['waiting', 'waiting']);
    const c = current(b!, G);
    expect(c.deal).toEqual(deal);
    expect(c.r1.has(b!.me(G).pubkey)).toBe(false);
    await frostOps['frost-keep']({ roomId: groupId(G), id: c.id, patch: { ok: true } }, b!.service);
    expect(await run(ws, G)).toEqual(['done', 'done']);
    expect(a!.seats[0]).toMatchObject({ threshold: 2, maxSigners: 2, label: 'logo design' });
    expect(a!.seats[0]!.address).toBe(b!.seats[0]!.address);
  });

  test('a start naming someone outside the room, or zafu court, is read as such', async () => {
    const { ws, G } = await group(2);
    const [a, b] = ws;
    const outsider = deriveRoomKeys(PHRASES[3]!, 0, G).pubkey;
    await start(a!, G, [a!.me(G).pubkey, outsider], 2);
    expect(ceremonyOf(b!.room(G).frost?.msgs, allowedIn(b!.room(G), b!.me(G).pubkey))).toBe(
      undefined,
    );
    await b!.service.check();
    expect(
      ceremonyOf(b!.room(G).frost?.msgs, allowedIn(b!.room(G), b!.me(G).pubkey)),
    ).toBeUndefined();

    // the court is a seat that waits for its service: nobody finishes without it
    await start(a!, G, [a!.me(G).pubkey, b!.me(G).pubkey, COURT], 2);
    expect(await run(ws, G, 3)).toEqual(['waiting', 'waiting']);
  });

  test('a payment from it: proposed, sealed by two, declined by one, signed in the room', async () => {
    const { ws, G } = await group(3);
    const [a, b, c] = ws;
    await start(
      a!,
      G,
      ws.map(w => w.me(G).pubkey),
      2,
    );
    expect(await run(ws, G)).toEqual(['done', 'done', 'done']);
    const seat = a!.seats[0]!;
    const wallet = { ceremony: seat.ceremony, members: seat.members, threshold: 2 };
    const sent: string[][] = [];
    const callsOf = (s: Seat): SignCalls => ({
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
        W.frost_spend_aggregate(
          s.publicKeyPackage,
          h,
          alpha,
          JSON.stringify(cm),
          JSON.stringify(sh),
        ),
      complete: async (_p, sigs) => (sent.push(sigs), 'ab'.repeat(32)),
    });
    // two spends: two alphas, one share each per signer
    const alphas = ['01'.padEnd(64, '0'), '02'.padEnd(64, '0')];
    const prop = {
      t: 'prop' as const,
      id: 'f'.repeat(32),
      w: seat.ceremony,
      to: 'u1someone',
      amt: '125000000',
      fee: '10000',
      sighash: bytesToHex(crypto.getRandomValues(new Uint8Array(32))),
      alphas,
      si: [0, 1],
      pczt: 'aa',
    };
    await a!.post(G, await packFrost(prop));
    await seal(prop, callsOf(seat), a!.io(G));
    const view = async (w: ReturnType<typeof wallet>) => {
      await w.service.check();
      const r = w.room(G);
      return { p: proposalsOf(r.frost?.msgs, wallet)[0]!, mine: r.frost?.mine?.[prop.id] };
    };
    {
      const { p } = await view(b!);
      expect(p).toMatchObject({ by: a!.me(G).pubkey, amt: '125000000' });
      expect([...p.commits.keys()]).toEqual([a!.me(G).pubkey]);
      await seal(p, callsOf(b!.seats[0]!), b!.io(G));
      await decline((await view(c!)).p, c!.io(G));
    }
    let status = '';
    for (let i = 0; i < 6 && status !== 'sent'; i++) {
      for (const w of [a!, b!, c!]) {
        const { p, mine } = await view(w);
        const s = await advanceSign(p, wallet, mine, w.me(G).pubkey, callsOf(w.seats[0]!), w.io(G));
        if (w === a) {
          status = s;
        }
      }
    }
    expect(status).toBe('sent');
    // one aggregated signature per spend, each verified by frost against the group key
    expect(sent).toHaveLength(1);
    expect(sent[0]!.map(x => x.length)).toEqual([128, 128]);
    const { p, mine: bMine } = await view(b!);
    expect(p.set).toEqual([a!.me(G).pubkey, b!.me(G).pubkey]);
    expect(p.no).toEqual(new Set([c!.me(G).pubkey]));
    expect(p.sent).toBe('ab'.repeat(32));
    // a nonce signs once: gone from the device the moment its share left
    expect(bMine).toMatchObject({ released: true });
    expect(bMine).not.toHaveProperty('n');
    expect((await view(c!)).mine).toMatchObject({ no: true });
  });
});
