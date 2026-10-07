/**
 * The people relay service against a fake relay: what it reads, what it
 * writes, and above all when it does nothing at all.
 *
 * @vitest-environment node
 */

import { afterEach, describe, expect, test, vi } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import type { RelayTransport } from '@zafu/zid';
import { GROUP_ROOM_PLAINTEXT_BYTES } from '@zafu/zirc/room';
import { presenceEpoch } from '@zafu/zid';
import {
  createPeopleService,
  PASS_BUDGET,
  RETENTION_MS,
  RETENTION_WINDOWS,
  shares,
  T3_MS,
  TICK_WINDOWS,
  threadKey,
  type Gate,
  type PeopleStatus,
} from './service';
import { landed, type PeopleRoom, type Thread, type ThreadItem } from './vault';

/** one relay, many readers: entries merged by tag per coordinate */
const fakeRelay = () => {
  const board = new Map<string, Map<string, Uint8Array>>();
  const calls: string[] = [];
  /** every write attempted, landed or not */
  const puts: { epoch: number; tag: string; blob: string }[] = [];
  /** 'down': a write fails; 'lost': it lands but its answer never comes back */
  const state = { put: 'up' as 'up' | 'down' | 'lost' };
  const transport = (): RelayTransport => ({
    putBucket: async req => {
      calls.push(`put ${req.epoch}`);
      for (const e of req.entries) {
        puts.push({ epoch: req.epoch, tag: bytesToHex(e.tag), blob: bytesToHex(e.blob) });
      }
      if (state.put === 'down') {
        throw new Error('fetch failed');
      }
      const k = `${req.appScope}|${req.epoch}|${req.shard}`;
      const coord = board.get(k) ?? new Map();
      for (const e of req.entries) {
        coord.set(bytesToHex(e.tag), e.blob);
      }
      board.set(k, coord);
      if (state.put === 'lost') {
        throw new Error('the answer was lost');
      }
    },
    getBucket: async req => {
      calls.push(`get ${req.epoch}`);
      const coord = board.get(`${req.appScope}|${req.epoch}|${req.shard}`);
      return [...(coord?.entries() ?? [])].map(([tag, blob]) => ({ tag: hexToBytes(tag), blob }));
    },
  });
  return { transport, calls, puts, state };
};

const SECRET = bytesToHex(new Uint8Array(32).fill(7));

const roomRec = (walletId: string, n = 0): PeopleRoom => ({
  id: n ? `g:${String(n).padStart(32, '0')}` : 'g:00112233445566778899aabbccddeeff',
  walletId,
  kind: 'group',
  name: 'treasury',
  appScope: 'zafu-group-v1',
  secret: n ? bytesToHex(new Uint8Array(32).fill(n)) : SECRET,
  size: GROUP_ROOM_PLAINTEXT_BYTES,
  relay: 'https://relay.example',
  signer: { gen: 0, G: '00112233445566778899aabbccddeeff' },
  joined: true,
  createdAt: 0,
});

/** one device: its own vault, its own key, one shared relay */
const device = (
  walletId: string,
  relay: ReturnType<typeof fakeRelay>,
  opts: {
    gate?: Gate;
    rooms?: PeopleRoom[];
    clock?: { t: number };
    /** the same vault as another device: zafu closed and opened again */
    store?: Store;
    seed?: Uint8Array;
    handlers?: Parameters<typeof createPeopleService>[1];
  } = {},
) => {
  const seed = opts.seed ?? ed25519.utils.randomPrivateKey();
  const pubkey = bytesToHex(ed25519.getPublicKey(seed));
  const store: Store = opts.store ?? { rooms: opts.rooms ?? [roomRec(walletId)], threads: {} };
  const statuses: PeopleStatus[] = [];
  const transport = vi.fn(() => relay.transport());
  const gate = vi.fn(async () => opts.gate ?? 'on');
  const clock = opts.clock ?? { t: Date.UTC(2026, 9, 3, 12) };
  const writes = { threads: 0 };
  const service = createPeopleService(
    {
      readRooms: async () => structuredClone(store.rooms),
      writeRooms: async r => ((store.rooms = structuredClone(r)), true),
      readThreads: async () => structuredClone(store.threads),
      writeThreads: async t => ((store.threads = structuredClone(t)), writes.threads++, true),
      walletId: async () => walletId,
      identity: async () => ({
        pubkey,
        name: walletId,
        sign: async d => bytesToHex(ed25519.sign(d, seed)),
        verify: async (d, sig, pk) => ed25519.verify(sig, d, pk),
      }),
      gate,
      transport,
      status: s => void statuses.push(s),
      now: () => clock.t,
    },
    opts.handlers,
  );
  return {
    service,
    transport,
    gate,
    statuses,
    thread: (n = 0) => store.threads[threadKey(roomRec(walletId, n))],
    rooms: () => store.rooms,
    store,
    seed,
    writes,
  };
};

interface Store {
  rooms: PeopleRoom[];
  threads: Record<string, Thread>;
}

const epochAt = (ms: number) => presenceEpoch(Math.floor(ms / 1000));
const HOUR = 3600_000;

afterEach(() => {
  vi.useRealTimers();
});

describe('nothing without a reason', () => {
  test('opening people with no rooms makes no request and asks nothing', async () => {
    const relay = fakeRelay();
    const a = device('a', relay, { rooms: [] });
    expect(await a.service.open()).toBe('idle');
    a.service.close();
    expect(a.gate).not.toHaveBeenCalled();
    expect(a.transport).not.toHaveBeenCalled();
    expect(relay.calls).toEqual([]);
  });

  test('a refused relay means no request at all: the transport is never built', async () => {
    const relay = fakeRelay();
    const a = device('a', relay, { gate: 'ask' });
    expect(await a.service.open()).toBe('needs-opt-in');
    expect(await a.service.say(roomRec('a').id, 'hello')).toBe('needs-opt-in');
    a.service.close();
    expect(a.transport).not.toHaveBeenCalled();
    expect(relay.calls).toEqual([]);
    expect(a.statuses.at(-1)?.slot).toBe('needs-opt-in');
    // nothing was drafted: the screen asks, then says it again
    expect(a.thread()).toBeUndefined();
  });

  test('a blocked relay is said as blocked, and still nothing leaves', async () => {
    const relay = fakeRelay();
    const a = device('a', relay, { gate: 'blocked' });
    expect(await a.service.open()).toBe('blocked');
    expect(relay.calls).toEqual([]);
  });

  test('locked: nothing is read', async () => {
    const relay = fakeRelay();
    const a = device('a', relay);
    const locked = createPeopleService({
      readRooms: async () => null,
      writeRooms: async () => false,
      readThreads: async () => null,
      writeThreads: async () => false,
      walletId: async () => 'a',
      identity: async () => {
        throw new Error('no seed while locked');
      },
      gate: a.gate,
      transport: a.transport,
      status: () => undefined,
    });
    expect(await locked.open()).toBe('locked');
    expect(a.transport).not.toHaveBeenCalled();
  });
});

describe('two members, one room', () => {
  test('a line from one arrives at the other on the next pass', async () => {
    const relay = fakeRelay();
    const clock = { t: Date.UTC(2026, 9, 3, 12) };
    const a = device('a', relay, { clock });
    const b = device('b', relay, { clock });
    expect(await a.service.say(roomRec('a').id, 'paying her today?')).toBe('sent');
    expect(a.thread()?.items.map(i => [i.body, i.mine, i.status])).toEqual([
      ['paying her today?', true, undefined],
    ]);
    expect(await b.service.open()).toBe('checked');
    expect(b.thread()?.items.map(i => [i.body, i.name, i.mine])).toEqual([
      ['paying her today?', 'a', false],
    ]);
    // b answers; a reads it from where it left off
    clock.t += 60_000;
    await b.service.say(roomRec('b').id, 'yes');
    await a.service.check();
    expect(a.thread()?.items.map(i => i.body)).toEqual(['paying her today?', 'yes']);
    expect(a.rooms()[0]?.head?.seq).toBe(1);
    a.service.close();
    b.service.close();
  });

  test('a second pass reads only from the last window read', async () => {
    const relay = fakeRelay();
    const a = device('a', relay);
    await a.service.open();
    const first = relay.calls.length;
    expect(first).toBe(RETENTION_WINDOWS); // a room never read reads all the relay keeps
    await a.service.check();
    expect(relay.calls.length - first).toBe(1);
    a.service.close();
  });
});

describe('timers live only while a window is open', () => {
  test('T3 repeats every 5 minutes after open, and stops at close', async () => {
    vi.useFakeTimers();
    const relay = fakeRelay();
    const a = device('a', relay);
    await a.service.open();
    const afterOpen = relay.calls.length;
    await vi.advanceTimersByTimeAsync(T3_MS);
    expect(relay.calls.length).toBeGreaterThan(afterOpen);
    a.service.close();
    const atClose = relay.calls.length;
    await vi.advanceTimersByTimeAsync(T3_MS * 5);
    expect(relay.calls.length).toBe(atClose);
  });

  test('a thread on screen is read every 4 s, and not after it leaves', async () => {
    // only the intervals are fake: WebCrypto settles on real time
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const relay = fakeRelay();
    const clock = { t: Date.UTC(2026, 9, 3, 12) };
    // a room never read: a tick reads its share, oldest first, never all of it at once
    const a = device('a', relay, { clock });
    const stop = a.service.watch(roomRec('a').id);
    await vi.waitFor(() => expect(relay.calls.length).toBe(TICK_WINDOWS));
    await a.service.settled();
    const left = RETENTION_WINDOWS - TICK_WINDOWS;
    expect(a.rooms()[0]?.since).toBe(epochAt(clock.t) - left + 1);
    for (let i = 1; i <= 3; i++) {
      await vi.advanceTimersByTimeAsync(4_000);
      await a.service.settled();
      expect(relay.calls.length).toBe(TICK_WINDOWS * (i + 1));
    }
    stop();
    await vi.advanceTimersByTimeAsync(4_000 * 5);
    await new Promise(r => setTimeout(r, 100));
    expect(relay.calls.length).toBe(TICK_WINDOWS * 4);
    a.service.close();
  });

  test('close aborts what is in flight', async () => {
    const relay = fakeRelay();
    let signal: AbortSignal | undefined;
    const a = device('a', relay);
    a.transport.mockImplementation((...args: unknown[]) => {
      signal = args[2] as AbortSignal;
      return relay.transport();
    });
    await a.service.open();
    a.service.close();
    expect(signal?.aborted).toBe(true);
  });
});

describe('marking a thread read', () => {
  test('writes only when a line from someone else was unread: a re-render is not a write', async () => {
    const relay = fakeRelay();
    const clock = { t: Date.UTC(2026, 9, 3, 12) };
    const a = device('a', relay, { clock });
    const b = device('a', relay, { clock });
    const id = roomRec('a').id;
    expect(await a.service.say(id, 'hello')).toBe('sent');
    clock.t += 60_000;
    await b.service.open();
    const before = b.writes.threads;
    await b.service.read(id);
    expect(b.writes.threads).toBe(before + 1);
    expect(b.thread()?.read).toBe(Math.floor(clock.t / 1000));
    // the screen asks again on every change: nothing new, nothing written
    await b.service.read(id);
    await b.service.read(id);
    expect(b.writes.threads).toBe(before + 1);
    // your own lines never make a thread unread
    expect(await b.service.say(id, 'hi')).toBe('sent');
    const after = b.writes.threads;
    await b.service.read(id);
    expect(b.writes.threads).toBe(after);
  });
});

describe('catch-up within what the relay keeps', () => {
  test('back after 30 h: every room reads every window it missed, each its share', async () => {
    const relay = fakeRelay();
    const t0 = Date.UTC(2026, 9, 3, 12);
    const clock = { t: t0 };
    const born = (n: number) => ({ ...roomRec('b', n), since: epochAt(t0) });
    const rooms = [1, 2, 3].map(born);
    const a = device('a', relay, { clock, rooms: [1, 2, 3].map(n => roomRec('a', n)) });
    const b = device('b', relay, { clock, rooms });
    for (const h of [1, 29]) {
      clock.t = t0 + h * HOUR;
      for (const n of [1, 2, 3]) {
        expect(await a.service.say(roomRec('a', n).id, `room ${n} at ${h} h`)).toBe('sent');
      }
    }
    clock.t = t0 + 30 * HOUR;
    const need = epochAt(clock.t) - epochAt(t0) + 1;
    expect(need).toBeGreaterThan(288); // more than a day: the old cap lost the first line

    const before = relay.calls.length;
    await b.service.check();
    // one pass never reads more than its budget, and every room moved
    expect(relay.calls.length - before).toBeLessThanOrEqual(PASS_BUDGET);
    for (const r of b.rooms()) {
      expect(r.since).toBeGreaterThan(epochAt(t0) + 150);
      expect(r.since).toBeLessThan(epochAt(clock.t));
    }
    await b.service.check();
    for (const n of [1, 2, 3]) {
      expect(b.thread(n)?.items.map(i => i.body)).toEqual([
        `room ${n} at 1 h`,
        `room ${n} at 29 h`,
      ]);
    }
    expect(b.rooms().every(r => r.since === epochAt(clock.t))).toBe(true);
    b.service.close();
  });

  test('a busy room never starves a quiet one', () => {
    const give = shares([1, 576, 576, 2], PASS_BUDGET);
    expect(give.reduce((x, y) => x + y)).toBe(PASS_BUDGET);
    expect(give[0]).toBe(1);
    expect(give[3]).toBe(2);
    expect(Math.abs(give[1]! - give[2]!)).toBeLessThanOrEqual(1);
    // more than enough: each takes only what it needs
    expect(shares([3, 5], PASS_BUDGET)).toEqual([3, 5]);
  });

  test('a card answered 28 h ago is found when its maker comes back after 30 h', async () => {
    const relay = fakeRelay();
    const t0 = Date.UTC(2026, 9, 3, 12);
    const clock = { t: t0 };
    const card: PeopleRoom = {
      ...roomRec('a', 9),
      id: 'c:ab',
      kind: 'card',
      appScope: 'zafu-pair-v1',
      since: epochAt(t0),
    };
    const seen: string[] = [];
    const maker = device('a', relay, {
      clock,
      rooms: [card],
      handlers: {
        card: async (_room, records) => {
          seen.push(...records.map(r => r.body));
          return undefined;
        },
      },
    });
    const answerer = device('b', relay, { clock, rooms: [{ ...card, walletId: 'b' }] });
    clock.t = t0 + 2 * HOUR;
    await answerer.service.api.send(card.id, 'zp2:card:their-answer', 'action');
    clock.t = t0 + 30 * HOUR;
    await maker.service.check();
    expect(seen).toEqual(['zp2:card:their-answer']);
  });
});

describe('the outbox: a line that did not leave', () => {
  const draftOf = (t?: Thread) => t?.items.find(i => i.local);

  test('waits quietly, then leaves on the next pass as a fresh record, shown once', async () => {
    const relay = fakeRelay();
    const clock = { t: Date.UTC(2026, 9, 3, 12) };
    const a = device('a', relay, { clock, rooms: [{ ...roomRec('a'), since: epochAt(clock.t) }] });
    relay.state.put = 'down';
    expect(await a.service.say(roomRec('a').id, 'are you there?')).toBe('unreachable');
    const waiting = draftOf(a.thread());
    expect(waiting).toMatchObject({ status: 'waiting', tries: 1, body: 'are you there?' });
    expect(a.thread()?.items).toHaveLength(1);
    const first = relay.puts.at(-1)!;

    // still down: tried again only once its wait is over
    clock.t += 10 * 60_000;
    await a.service.check();
    expect(draftOf(a.thread())).toMatchObject({
      local: waiting!.local,
      status: 'waiting',
      tries: 2,
    });
    expect(a.thread()?.items).toHaveLength(1);

    relay.state.put = 'up';
    clock.t += 10 * 60_000;
    await a.service.check();
    const last = relay.puts.at(-1)!;
    // a new window, a new tag, a new seal: never the old blob again
    expect(last.epoch).toBeGreaterThan(first.epoch);
    expect(last.tag).not.toBe(first.tag);
    expect(last.blob).not.toBe(first.blob);
    expect(new Set(relay.puts.map(p => p.blob)).size).toBe(relay.puts.length);
    expect(a.thread()?.items.map(i => [i.body, i.status, i.local, !!i.hash])).toEqual([
      ['are you there?', undefined, undefined, true],
    ]);

    // the other side reads it once
    const b = device('b', relay, { clock, rooms: [{ ...roomRec('b'), since: first.epoch }] });
    await b.service.check();
    expect(b.thread()?.items.map(i => i.body)).toEqual(['are you there?']);
    a.service.close();
    b.service.close();
  });

  test('"try again" keeps the same local id', async () => {
    const relay = fakeRelay();
    const clock = { t: Date.UTC(2026, 9, 3, 12) };
    const a = device('a', relay, { clock, rooms: [{ ...roomRec('a'), since: epochAt(clock.t) }] });
    relay.state.put = 'down';
    await a.service.say(roomRec('a').id, '/me waves');
    const local = draftOf(a.thread())!.local!;
    expect(draftOf(a.thread())).toMatchObject({ kind: 'action', body: 'waves' });
    await a.service.say(roomRec('a').id, '/me waves', local);
    expect(a.thread()?.items.map(i => i.local)).toEqual([local]);
    relay.state.put = 'up';
    expect(await a.service.say(roomRec('a').id, '/me waves', local)).toBe('sent');
    expect(a.thread()?.items.map(i => [i.kind, i.body, i.local])).toEqual([
      ['action', 'waves', undefined],
    ]);
  });

  test('a write that landed but whose answer was lost is not sent twice', async () => {
    const relay = fakeRelay();
    const clock = { t: Date.UTC(2026, 9, 3, 12) };
    const a = device('a', relay, { clock, rooms: [{ ...roomRec('a'), since: epochAt(clock.t) }] });
    relay.state.put = 'lost';
    await a.service.say(roomRec('a').id, 'did this land?');
    expect(draftOf(a.thread())?.status).toBe('waiting');
    relay.state.put = 'up';
    const puts = relay.puts.length;
    clock.t += 10 * 60_000;
    await a.service.check();
    expect(relay.puts.length).toBe(puts);
    expect(a.thread()?.items.map(i => [i.body, !!i.hash, i.local])).toEqual([
      ['did this land?', true, undefined],
    ]);
  });

  test('survives closing zafu: the next open sends it', async () => {
    const relay = fakeRelay();
    const clock = { t: Date.UTC(2026, 9, 3, 12) };
    const a = device('a', relay, { clock, rooms: [{ ...roomRec('a'), since: epochAt(clock.t) }] });
    relay.state.put = 'down';
    await a.service.say(roomRec('a').id, 'see you tomorrow');
    a.service.close();
    relay.state.put = 'up';
    clock.t += 8 * HOUR;
    // nothing runs while people is closed
    const puts = relay.puts.length;
    expect(a.service.active).toBe(false);
    const again = device('a', relay, { clock, store: a.store, seed: a.seed });
    expect(relay.puts.length).toBe(puts);
    await again.service.open();
    expect(again.thread()?.items.map(i => [i.body, !!i.hash])).toEqual([
      ['see you tomorrow', true],
    ]);
    again.service.close();
  });

  test('gives up after the retention window, calmly, and asks nothing', async () => {
    const relay = fakeRelay();
    const clock = { t: Date.UTC(2026, 9, 3, 12) };
    const a = device('a', relay, { clock, rooms: [{ ...roomRec('a'), since: epochAt(clock.t) }] });
    relay.state.put = 'down';
    await a.service.say(roomRec('a').id, 'too late');
    clock.t += RETENTION_MS;
    relay.state.put = 'up';
    const puts = relay.puts.length;
    await a.service.check();
    expect(relay.puts.length).toBe(puts);
    expect(draftOf(a.thread())).toMatchObject({ status: 'failed', body: 'too late' });
    // what the screen says about the relay is not about this line
    expect(a.statuses.at(-1)?.slot).toBe('checked');
  });
});

test('an arrived line settles one draft with the same words, drafted no later', () => {
  const line = (o: Partial<ThreadItem>): ThreadItem => ({
    hash: '',
    author: 'me',
    name: '',
    body: 'ok',
    ts: 100,
    epoch: 0,
    kind: 'msg',
    mine: true,
    ...o,
  });
  const draft = line({ local: 'x', status: 'waiting' });
  const t: Thread = { read: 0, items: [draft] };
  expect(landed(t, [line({ hash: 'h', ts: 99 })]).items).toEqual([draft]);
  expect(landed(t, [line({ hash: 'h', kind: 'action' })]).items).toEqual([draft]);
  expect(landed(t, [line({ hash: 'h', mine: false })]).items).toEqual([draft]);
  expect(landed(t, [line({ hash: 'h', ts: 101 })]).items).toEqual([]);
  // one arrival, one draft: two drafts of the same words keep the second
  const two: Thread = { read: 0, items: [draft, line({ local: 'y' })] };
  expect(landed(two, [line({ hash: 'h' })]).items.map(i => i.local)).toEqual(['y']);
});
