/**
 * Two wallets make a group through its door on a fake relay: the founder
 * makes it, the other reads the code, asks, is allowed, opens the invite,
 * reads the roster from the founder's log, and they talk. A guesser who has
 * the code reads names and keys but cannot open the invite, and a roster
 * record nobody authorised is refused.
 *
 * @vitest-environment node
 */

import { describe, expect, test, vi } from 'vitest';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import type { RelayTransport } from '@zafu/zid';
import { appendRecord } from '@zafu/zirc';
import { GROUP_ROOM_PLAINTEXT_BYTES, Room, ZAFU_GROUP_APP_SCOPE } from '@zafu/zirc/room';
import { deriveRoomKeys } from '../state/identity';
import { createPeopleService, threadKey } from './service';
import { createGroups, doorId, groupId } from './groups';
import {
  codeNames,
  decodeWire,
  DOOR_SCOPE,
  doorSecret,
  encodeWire,
  makeCode,
  openInviteBody,
  CODE_RE,
} from './door';
import { ephemeralIdentity, identityOf } from './keys';
import { wordName } from './word-name';
import type { PeopleRoom, Thread } from './vault';

// every door here runs the real scrypt (N 2^16, 64 MiB) once per member: about
// a second a test on a busy CI runner, so leave room past the 5s default
vi.setConfig({ testTimeout: 30_000 });

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
    groups,
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

    const { id, code } = (await a.op('group-create', {
      name: 'treasury',
      nick: 'alice',
    })) as unknown as {
      id: string;
      code: string;
    };
    expect(code).toMatch(CODE_RE);
    const G = id.slice(2);

    clock.t += 30_000;
    const card = await b.op('door-peek', { code });
    expect(card).toMatchObject({ G, group: 'treasury', count: 1, from: 'alice' });
    await b.op('door-ask', { code });

    clock.t += 30_000;
    await a.service.open();
    const asks = a.room(doorId(G))?.group?.requests ?? [];
    expect(asks).toHaveLength(1);
    const bobKey = deriveRoomKeys(BOB, 0, G).pubkey;
    expect(asks[0]!.key).toBe(bobKey);
    // a pass that read the ask before "allow" and lands after it
    const stale = structuredClone(a.room(doorId(G))!);
    const bob = deriveRoomKeys(BOB, 0, G);
    const late = await a.groups.handlers.door(
      stale,
      [
        {
          body: encodeWire({ kind: 'ask', key: bobKey, name: 'x', seal: bob.xwingPublicKey }),
          author: bobKey,
          ts: Math.floor(clock.t / 1000),
        } as never,
      ],
      a.service.api,
    );
    // and a pass over the group room that read its roster before "allow"
    const aliceRoomKey = deriveRoomKeys(ALICE, 0, G).pubkey;
    const staleRoster = await a.groups.handlers.group(
      structuredClone(a.room(groupId(G))!),
      [
        {
          body: encodeWire({ kind: 'names', names: {} }),
          author: aliceRoomKey,
          ts: Math.floor(clock.t / 1000),
        } as never,
      ],
      a.service.api,
    );
    // bob chose no name: the founder sees his word name for this group, never hex
    expect(asks[0]!.name).toBe(wordName(bobKey));

    await a.op('group-allow', { G, key: bobKey });
    expect(a.room(groupId(G))?.group?.members.map(m => m.key)).toEqual([
      deriveRoomKeys(ALICE, 0, G).pubkey,
      bobKey,
    ]);
    expect(a.room(doorId(G))?.group?.requests).toEqual([]);
    await a.service.api.updateRoom(doorId(G), r => (late ? late(r) : r));
    expect(a.room(doorId(G))?.group?.requests).toEqual([]);
    await a.service.api.updateRoom(groupId(G), r => (staleRoster ? staleRoster(r) : r));
    expect(a.room(groupId(G))?.group?.members.map(m => m.key)).toEqual([aliceRoomKey, bobKey]);

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
    expect(a.lines(groupId(G))).toEqual([
      'alice: alice sent the logo files',
      `${wordName(bobKey)}: paying her today?`,
    ]);
    // the roster names agree on both sides
    const aliceKey = deriveRoomKeys(ALICE, 0, G).pubkey;
    expect(b.room(groupId(G))?.group?.members.map(m => m.name)).toEqual([
      'alice',
      wordName(bobKey),
    ]);
    expect(a.room(groupId(G))?.group?.names?.[aliceKey]).toBe('alice');
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
      roomSecret: await doorSecret(code),
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

  test('the code names its founder: a code holder posting a newer card does not take the door', async () => {
    const transport = relayBoard();
    const clock = { t: Date.UTC(2026, 9, 3, 12) };
    const a = wallet('wa', ALICE, transport, clock);
    const b = wallet('wb', BOB, transport, clock);
    const { id, code } = (await a.op('group-create', { name: 'treasury' })) as unknown as {
      id: string;
      code: string;
    };
    const G = id.slice(2);
    const door = async (who: ReturnType<typeof ephemeralIdentity>) =>
      new Room(who, {
        appScope: DOOR_SCOPE,
        roomSecret: await doorSecret(code),
        relay: transport(),
        plaintextBytes: GROUP_ROOM_PLAINTEXT_BYTES,
        now: () => Math.floor(clock.t / 1000),
      });
    const fakeCard = (founder: string) =>
      encodeWire({
        kind: 'card',
        G: 'ee'.repeat(16),
        founder,
        group: 'treasury',
        from: 'alice',
        count: 1,
      });

    // a later card from someone the code does not name: ignored
    clock.t += 60_000;
    let eve = ephemeralIdentity();
    while (codeNames(code, eve.pubkey)) {
      eve = ephemeralIdentity();
    }
    await (await door(eve)).send(fakeCard(eve.pubkey), { kind: 'action' });
    expect(await b.op('door-peek', { code })).toMatchObject({ G, group: 'treasury' });

    // a key ground to fit the code's last word: two founders fit, so the door is refused
    let ground = ephemeralIdentity();
    while (!codeNames(code, ground.pubkey)) {
      ground = ephemeralIdentity();
    }
    await (await door(ground)).send(fakeCard(ground.pubkey), { kind: 'action' });
    await expect(b.op('door-peek', { code })).rejects.toThrow(/unclear/);
  });

  test('a code is three digits and three words, the last naming its founder', () => {
    const founder = ephemeralIdentity().pubkey;
    const code = makeCode(founder);
    expect(code).toMatch(CODE_RE);
    expect(codeNames(code, founder)).toBe(true);
    // the same digits and words with any other last word do not name them
    const parts = code.split('-');
    const swapped = [...parts.slice(0, 3), parts[3] === 'kite' ? 'mail' : 'kite'].join('-');
    expect(codeNames(swapped, founder)).toBe(false);
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
