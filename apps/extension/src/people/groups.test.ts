/**
 * Two wallets make a group through its door on a fake relay: the founder
 * makes it, the other reads the code, asks, is allowed, opens the invite,
 * reads the roster from the founder's log, and they talk. A guesser who has
 * the code reads names and keys but cannot open the invite, and a roster
 * record nobody authorised is refused.
 *
 * @vitest-environment node
 */

import { describe, expect, test } from 'vitest';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import type { RelayTransport } from '@zafu/zid';
import { appendRecord } from '@zafu/zirc';
import { GROUP_ROOM_PLAINTEXT_BYTES, Room, ZAFU_GROUP_APP_SCOPE } from '@zafu/zirc/room';
import { deriveRoomKeys } from '../state/identity';
import { createPeopleService, threadKey } from './service';
import { createGroups, doorId, groupId } from './groups';
import { decodeWire, DOOR_SCOPE, doorSecret, encodeWire, openInviteBody, CODE_RE } from './door';
import { identityOf } from './keys';
import type { PeopleRoom, Thread } from './vault';

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

const ALICE =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const BOB = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
const RELAY = 'https://relay.example';

const wallet = (
  walletId: string,
  phrase: string,
  transport: () => RelayTransport,
  clock: { t: number },
) => {
  let rooms: PeopleRoom[] = [];
  let threads: Record<string, Thread> = {};
  const keys = async (_w: string, gen: number, G: string) => deriveRoomKeys(phrase, gen, G);
  const groups = createGroups({
    walletId: async () => walletId,
    keys,
    generation: async () => 0,
    relay: async () => RELAY,
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
    groups.handlers,
  );
  const op = (name: keyof typeof groups.ops, args: Record<string, unknown>) =>
    groups.ops[name](args, service) as Promise<never>;
  return {
    service,
    op,
    room: (id: string) => rooms.find(r => r.id === id),
    lines: (id: string) =>
      threads[threadKey({ walletId, id })]?.items.map(i => `${i.name}: ${i.body}`),
  };
};

describe('a group through its door', () => {
  test('make, ask, allow, join, talk', async () => {
    const transport = relayBoard();
    const clock = { t: Date.UTC(2026, 9, 3, 12) };
    const a = wallet('wa', ALICE, transport, clock);
    const b = wallet('wb', BOB, transport, clock);

    const { id, code } = (await a.op('group-create', { name: 'treasury' })) as unknown as {
      id: string;
      code: string;
    };
    expect(code).toMatch(CODE_RE);
    const G = id.slice(2);

    clock.t += 30_000;
    const card = await b.op('door-peek', { code });
    expect(card).toMatchObject({ G, group: 'treasury', count: 1 });
    await b.op('door-ask', { code });

    clock.t += 30_000;
    await a.service.open();
    const asks = a.room(doorId(G))?.group?.requests ?? [];
    expect(asks).toHaveLength(1);
    const bobKey = deriveRoomKeys(BOB, 0, G).pubkey;
    expect(asks[0]!.key).toBe(bobKey);

    await a.op('group-allow', { G, key: bobKey });
    expect(a.room(groupId(G))?.group?.members.map(m => m.key)).toEqual([
      deriveRoomKeys(ALICE, 0, G).pubkey,
      bobKey,
    ]);
    expect(a.room(doorId(G))?.group?.requests).toEqual([]);

    clock.t += 30_000;
    await b.service.open(); // opens the invite, joins the group
    await b.service.settled();
    await b.service.check(); // and reads the roster from the founder's log
    const joined = b.room(groupId(G));
    expect(joined?.joined).toBe(true);
    expect(joined?.name).toBe('treasury');
    expect(joined?.group?.members.map(m => m.key)).toEqual([
      deriveRoomKeys(ALICE, 0, G).pubkey,
      bobKey,
    ]);
    expect(b.room(doorId(G))?.group?.opened).toBe(true);

    expect(await a.service.say(groupId(G), 'alice sent the logo files')).toBe('sent');
    clock.t += 10_000;
    await b.service.check();
    expect(await b.service.say(groupId(G), 'paying her today?')).toBe('sent');
    clock.t += 10_000;
    await a.service.check();
    const aKey = deriveRoomKeys(ALICE, 0, G);
    const short = (k: string) => k.slice(0, 8);
    expect(a.lines(groupId(G))).toEqual([
      `${short(aKey.xid)}: alice sent the logo files`,
      `${short(deriveRoomKeys(BOB, 0, G).xid)}: paying her today?`,
    ]);
    expect(b.lines(groupId(G))).toEqual(a.lines(groupId(G)));

    // once allowed, the ask is not shown again on the next pass
    await a.service.check();
    expect(a.room(doorId(G))?.group?.requests).toEqual([]);
  });

  test('a guesser with the code reads the door but cannot open the invite', async () => {
    const transport = relayBoard();
    const clock = { t: Date.UTC(2026, 9, 3, 12) };
    const a = wallet('wa', ALICE, transport, clock);
    const b = wallet('wb', BOB, transport, clock);
    const { id, code } = (await a.op('group-create', { name: 'treasury' })) as unknown as {
      id: string;
      code: string;
    };
    const G = id.slice(2);
    await b.op('door-ask', { code });
    await a.service.open();
    const bobKey = deriveRoomKeys(BOB, 0, G).pubkey;
    await a.op('group-allow', { G, key: bobKey });

    const eve = deriveRoomKeys('zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong', 0, G);
    const door = new Room(identityOf(eve), {
      appScope: DOOR_SCOPE,
      roomSecret: doorSecret(code),
      relay: transport(),
      plaintextBytes: GROUP_ROOM_PLAINTEXT_BYTES,
      now: () => Math.floor(clock.t / 1000),
    });
    const wires = (await door.sync(12)).messages.map(m => decodeWire(m.body));
    expect(wires.map(w => w?.kind).sort()).toEqual(['ask', 'card', 'invite']);
    const invite = wires.find(w => w?.kind === 'invite');
    expect(invite?.kind).toBe('invite');
    expect(() =>
      openInviteBody(eve.xwingSeed, (invite as { sealed: Uint8Array }).sealed),
    ).toThrow();
    // and the one it was sealed to opens it
    const body = openInviteBody(
      deriveRoomKeys(BOB, 0, G).xwingSeed,
      (invite as { sealed: Uint8Array }).sealed,
    );
    expect(body.secret).toBe(a.room(groupId(G))?.secret);
  });

  test('a roster record the founder did not write is refused', async () => {
    const transport = relayBoard();
    const clock = { t: Date.UTC(2026, 9, 3, 12) };
    const a = wallet('wa', ALICE, transport, clock);
    const b = wallet('wb', BOB, transport, clock);
    const { id, code } = (await a.op('group-create', { name: 'treasury' })) as unknown as {
      id: string;
      code: string;
    };
    const G = id.slice(2);
    await b.op('door-ask', { code });
    await a.service.open();
    await a.op('group-allow', { G, key: deriveRoomKeys(BOB, 0, G).pubkey });
    await b.service.open();
    await b.service.settled();
    await b.service.check();

    // bob, a member, voices someone himself and posts it as the next log record
    const room = b.room(groupId(G))!;
    const bobId = identityOf(deriveRoomKeys(BOB, 0, G));
    const forged = await appendRecord({
      genesis: room.group!.log!.genesis,
      records: room.group!.log!.records,
      author: bobId,
      body: { kind: 'mode', mode: '+v', subject: 'ee'.repeat(32) },
    });
    const member = new Room(bobId, {
      appScope: ZAFU_GROUP_APP_SCOPE,
      roomSecret: hexToBytes(room.secret),
      relay: transport(),
      plaintextBytes: GROUP_ROOM_PLAINTEXT_BYTES,
      now: () => Math.floor(clock.t / 1000),
      head: { seq: 100, hash: '' },
    });
    await member.send(encodeWire({ kind: 'log', entry: forged }), { kind: 'action' });
    clock.t += 10_000;
    await a.service.check();
    expect(a.room(groupId(G))?.group?.members).toHaveLength(2);
    expect(a.room(groupId(G))?.group?.log?.records).toHaveLength(2);
  });
});
