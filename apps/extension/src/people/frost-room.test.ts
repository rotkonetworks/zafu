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
import { beforeAll, describe, expect, test } from 'vitest';
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
  type FrostCalls,
  type FrostStatus,
  type Seat,
} from './frost-room';
import type { PeopleRoom, Thread } from './vault';

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
});
