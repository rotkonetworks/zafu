/**
 * Test kit for people rooms: a fake relay board, a wallet with its own vault
 * and service, the real SPAKE2 from the shipped zafu-wasm blob, and the door
 * walked end to end the way the screens walk it (people/door-run).
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import type { RelayTransport } from '@zafu/zid';
import { deriveRoomKeys } from '../state/identity';
import { doorPake, type DoorPakeWasm } from '../workers/door-pake';
import { hostStep, joinStep, type DoorPake } from './door-run';
import { createGroups, groupId } from './groups';
import { splitCode } from './door';
import { identityOf } from './keys';
import { createPeopleService, threadKey, type RecordHandler } from './service';
import type { PeopleRoom, Thread } from './vault';

export const relayBoard = () => {
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

let wasm: DoorPakeWasm | undefined;

/** SPAKE2 on the shipped blob, as the zcash worker runs it */
export const realPake = async (): Promise<DoorPake> => {
  if (!wasm) {
    // the glue's rayon snippet waits for a worker message on `self`; a node test has none to send
    (globalThis as { self?: unknown }).self ??= new EventTarget();
    const m = (await import('@repo/zcash-wasm')) as unknown as DoorPakeWasm & {
      initSync(o: { module: Uint8Array }): void;
    };
    m.initSync({
      module: readFileSync(resolve(process.cwd(), '../../packages/zcash-wasm/zafu_wasm_bg.wasm')),
    });
    wasm = m;
  }
  const w = wasm;
  return async call => doorPake(w, call) as never;
};

export const peopleWallet = (
  walletId: string,
  phrase: string,
  transport: () => RelayTransport,
  clock: { t: number },
  handlers?: (h: ReturnType<typeof createGroups>['handlers']) => Record<string, RecordHandler>,
) => {
  let rooms: PeopleRoom[] = [];
  let threads: Record<string, Thread> = {};
  const keys = async (_w: string, gen: number, G: string) => deriveRoomKeys(phrase, gen, G);
  const groups = createGroups({
    walletId: async () => walletId,
    keys,
    generation: async () => 0,
    relay: async () => 'https://relay.example',
    gate: async () => 'on',
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
    handlers ? handlers(groups.handlers) : groups.handlers,
  );
  const call = (name: string, args: Record<string, unknown>) =>
    groups.ops[name as keyof typeof groups.ops](args, service) as Promise<never>;
  return {
    service,
    groups,
    op: call,
    call,
    me: (G: string) => deriveRoomKeys(phrase, 0, G),
    room: (id: string) => rooms.find(r => r.id === id),
    rooms: () => rooms,
    lines: (id: string) =>
      threads[threadKey({ walletId, id })]?.items.map(i => `${i.name}: ${i.body}`),
  };
};

export type PeopleWallet = ReturnType<typeof peopleWallet>;

const at = (w: PeopleWallet, id: string) => w.rooms().find(r => r.id === id)!;

/** the founder's door a typed code reaches: the one on its number */
export const hostDoor = (w: PeopleWallet, code: string) =>
  w
    .rooms()
    .find(
      r => r.door?.role === 'host' && splitCode(r.door.code)?.plate === splitCode(code)?.plate,
    )!;

/**
 * The door, as the keeper walks it: the joiner types the code and speaks,
 * the founder (`host`) answers, the joiner confirms its words, the founder
 * sends the box, the joiner opens it and asks in the room, the founder voices
 * the ask. Returns the joiner's door.
 */
export const comeIn = async (
  host: PeopleWallet,
  joiner: PeopleWallet,
  code: string,
  G: string,
  clock: { t: number },
  pake: DoorPake,
  nick = '',
) => {
  const { id } = (await joiner.op('door-open', { code, nick })) as { id: string };
  const hostTurn = async () => {
    clock.t += 1_000;
    await host.service.check();
    await hostStep(hostDoor(host, code), at(host, groupId(G)), pake, host.call);
  };
  const joinTurn = async () => {
    clock.t += 1_000;
    await joiner.service.check();
    await joinStep(at(joiner, id), pake, joiner.call);
  };
  await joinStep(at(joiner, id), pake, joiner.call);
  await hostTurn();
  await joinTurn();
  await hostTurn();
  await joinTurn();
  await joiner.service.settled();
  clock.t += 1_000;
  await host.service.check();
  await joiner.service.check();
  return at(joiner, id);
};
