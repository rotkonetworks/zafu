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
import { createPeopleService, T3_MS, threadKey, type Gate, type PeopleStatus } from './service';
import type { PeopleRoom, Thread } from './vault';

/** one relay, many readers: entries merged by tag per coordinate */
const fakeRelay = () => {
  const board = new Map<string, Map<string, Uint8Array>>();
  const calls: string[] = [];
  const transport = (): RelayTransport => ({
    putBucket: async req => {
      calls.push(`put ${req.epoch}`);
      const k = `${req.appScope}|${req.epoch}|${req.shard}`;
      const coord = board.get(k) ?? new Map();
      for (const e of req.entries) {
        coord.set(bytesToHex(e.tag), e.blob);
      }
      board.set(k, coord);
    },
    getBucket: async req => {
      calls.push(`get ${req.epoch}`);
      const coord = board.get(`${req.appScope}|${req.epoch}|${req.shard}`);
      return [...(coord?.entries() ?? [])].map(([tag, blob]) => ({ tag: hexToBytes(tag), blob }));
    },
  });
  return { transport, calls };
};

const SECRET = bytesToHex(new Uint8Array(32).fill(7));

const roomRec = (walletId: string): PeopleRoom => ({
  id: 'g:00112233445566778899aabbccddeeff',
  walletId,
  kind: 'group',
  name: 'treasury',
  appScope: 'zafu-group-v1',
  secret: SECRET,
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
  opts: { gate?: Gate; rooms?: PeopleRoom[]; clock?: { t: number } } = {},
) => {
  const seed = ed25519.utils.randomPrivateKey();
  const pubkey = bytesToHex(ed25519.getPublicKey(seed));
  let rooms: PeopleRoom[] = opts.rooms ?? [roomRec(walletId)];
  let threads: Record<string, Thread> = {};
  const statuses: PeopleStatus[] = [];
  const transport = vi.fn(() => relay.transport());
  const gate = vi.fn(async () => opts.gate ?? 'on');
  const clock = opts.clock ?? { t: Date.UTC(2026, 9, 3, 12) };
  const service = createPeopleService({
    readRooms: async () => structuredClone(rooms),
    writeRooms: async r => ((rooms = structuredClone(r)), true),
    readThreads: async () => structuredClone(threads),
    writeThreads: async t => ((threads = structuredClone(t)), true),
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
  });
  return {
    service,
    transport,
    gate,
    statuses,
    thread: () => threads[threadKey(roomRec(walletId))],
    rooms: () => rooms,
  };
};

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
    expect(first).toBe(12); // a first pass reads the last hour
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
    const a = device('a', relay);
    const stop = a.service.watch(roomRec('a').id);
    await vi.waitFor(() => expect(relay.calls.length).toBe(12)); // the first read: an hour
    await a.service.settled();
    for (let i = 1; i <= 3; i++) {
      await vi.advanceTimersByTimeAsync(4_000);
      await a.service.settled();
      expect(relay.calls.length).toBe(12 + i); // then one window a tick
    }
    stop();
    await vi.advanceTimersByTimeAsync(4_000 * 5);
    await new Promise(r => setTimeout(r, 100));
    expect(relay.calls.length).toBe(15);
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
