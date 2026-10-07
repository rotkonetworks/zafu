/**
 * Groups through the door, on a fake relay and the real SPAKE2: the founder
 * makes a group, others type its code and come in, the roster comes from the
 * founder's log, and they talk. A wrong word is seen at once and opens
 * nothing, the relay's mailbox never holds the words, two codes that share a
 * number stay apart, and a roster record nobody authorised is refused.
 *
 * @vitest-environment node
 */

import { beforeAll, describe, expect, test, vi } from 'vitest';
import { hexToBytes } from '@noble/hashes/utils';
import { appendRecord } from '@zafu/zirc';
import { GROUP_ROOM_PLAINTEXT_BYTES, Room, ZAFU_GROUP_APP_SCOPE } from '@zafu/zirc/room';
import { deriveRoomKeys } from '../state/identity';
import { doorId, groupId, OLDER_CODE } from './groups';
import { ANSWERS_PER_CODE, CODE_RE, encodeWire, makeCode, splitCode } from './door';
import { doorView, hostStep, joinStep, type DoorPake } from './door-run';
import { allowedIn, ceremonyOf, foldFrost } from './frost-room';
import { identityOf } from './keys';
import { chain } from './service';
import { wordName } from './word-name';
import { comeIn, peopleWallet, realPake, relayBoard } from './door.test-util';

vi.setConfig({ testTimeout: 30_000 });

const ALICE =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const BOB = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
const CAROL = 'letter advice cage absurd amount doctor acoustic avoid letter advice cage above';
const EVE = 'zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong';

let pake: DoorPake;
beforeAll(async () => {
  pake = await realPake();
});

const setup = (...phrases: string[]) => {
  const transport = relayBoard();
  const clock = { t: Date.UTC(2026, 9, 7, 12) };
  return {
    transport,
    clock,
    ws: phrases.map((p, i) =>
      peopleWallet(`w${i}`, p, transport, clock, h => ({
        ...h,
        group: chain(h.group, foldFrost),
      })),
    ),
  };
};

const make = async (w: ReturnType<typeof setup>['ws'][number], args: Record<string, unknown>) => {
  const { id, code } = (await w.op('group-create', args)) as { id: string; code: string };
  return { G: id.slice(2), code };
};

describe('a group through its door', () => {
  test('make, type the code, come in, talk: no allow step, the same words on both sides', async () => {
    const { ws, clock } = setup(ALICE, BOB);
    const [a, b] = ws as [(typeof ws)[0], (typeof ws)[0]];
    const { G, code } = await make(a, { name: 'treasury', nick: 'alice' });
    expect(code).toMatch(CODE_RE);

    const door = await comeIn(a, b, code, G, clock, pake);
    expect(doorView(door, clock.t)).toBe('in');
    const bobKey = deriveRoomKeys(BOB, 0, G).pubkey;
    const aliceKey = deriveRoomKeys(ALICE, 0, G).pubkey;
    expect(a.room(groupId(G))?.group?.members.map(m => m.key)).toEqual([aliceKey, bobKey]);
    expect(b.room(groupId(G))?.group?.members.map(m => m.key)).toEqual([aliceKey, bobKey]);
    expect(b.room(groupId(G))?.name).toBe('treasury');
    // bob chose no name: the founder sees his word name for this group, never hex
    expect(a.room(groupId(G))?.group?.names?.[bobKey]).toBe(wordName(bobKey));

    // both sides were shown the same two words, and nothing asked them to compare
    const words = a.room(doorId(G))?.door?.answered?.[0]?.words;
    expect(words?.split(' ')).toHaveLength(2);
    expect(door.door?.words).toBe(words);
    expect(a.lines(groupId(G))?.some(l => l.includes(words!))).toBe(true);
    expect(b.lines(groupId(G))?.some(l => l.includes(words!))).toBe(true);

    expect(await a.service.say(groupId(G), 'alice sent the logo files')).toBe('sent');
    clock.t += 10_000;
    await b.service.check();
    expect(await b.service.say(groupId(G), 'paying her today?')).toBe('sent');
    clock.t += 10_000;
    await a.service.check();
    const said = (w: typeof a) => w.lines(groupId(G))?.filter(l => !l.startsWith(': '));
    expect(said(a)).toEqual([
      'alice: alice sent the logo files',
      `${wordName(bobKey)}: paying her today?`,
    ]);
    expect(said(b)).toEqual(said(a));
  });

  test('a wrong word is seen at once, opens nothing, and leaves the roster as it was', async () => {
    const { ws, clock } = setup(ALICE, EVE);
    const [a, e] = ws as [(typeof ws)[0], (typeof ws)[0]];
    const { G, code } = await make(a, { name: 'treasury' });
    const [n, w1] = code.split('-');
    const guess = `${n}-${w1}-${w1 === 'zoo' ? 'abandon' : 'zoo'}`;

    const door = await comeIn(a, e, guess, G, clock, pake);
    expect(doorView(door, clock.t)).toBe('wrong');
    expect(e.room(groupId(G))).toBeUndefined();
    expect(a.room(groupId(G))?.group?.members).toHaveLength(1);
    // the founder answered one run: the one guess it got
    expect(a.room(doorId(G))?.door?.answered).toHaveLength(1);
  });

  test("the relay's mailbox holds the number's records, never the words", async () => {
    const { ws, clock } = setup(ALICE, BOB);
    const [a, b] = ws as [(typeof ws)[0], (typeof ws)[0]];
    const { G, code } = await make(a, { name: 'treasury' });
    await comeIn(a, b, code, G, clock, pake);
    const said = JSON.stringify(a.room(doorId(G))?.door?.heard);
    expect(said).toContain('"wj"');
    expect(said).toContain('"wa"');
    for (const w of splitCode(code)!.words.split('-')) {
      expect(said).not.toMatch(new RegExp(`\\b${w}\\b`));
    }
  });

  test('two codes on one number: the joiner speaks to both, and comes into the one whose words it has', async () => {
    const { ws, clock } = setup(ALICE, CAROL, BOB);
    const [a, c, b] = ws as [(typeof ws)[0], (typeof ws)[0], (typeof ws)[0]];
    const one = await make(a, { name: 'treasury' });
    const two = await make(c, { name: 'studio' });
    // carol's door moved onto alice's number: the same mailbox, other words
    const moved = `${splitCode(one.code)!.plate}-${splitCode(two.code)!.words}`;
    await c.service.api.updateRoom(doorId(two.G), r => ({
      ...r,
      secret: a.room(doorId(one.G))!.secret,
      door: { ...r.door!, code: moved },
    }));
    c.service.close();
    await c.service.api.send(
      doorId(two.G),
      encodeWire({ kind: 'wh', v: 1, salt: c.room(doorId(two.G))!.door!.salt! }),
      'action',
    );

    const { id } = (await b.op('door-open', { code: one.code })) as { id: string };
    await joinStep(b.room(id)!, pake, b.call);
    expect(b.room(id)?.door?.sent).toHaveLength(2);
    for (const [w, G] of [
      [a, one.G],
      [c, two.G],
    ] as const) {
      await w.service.check();
      await hostStep(w.room(doorId(G))!, w.room(groupId(G)), pake, w.call);
    }
    await b.service.check();
    await joinStep(b.room(id)!, pake, b.call);
    const door = b.room(id)!;
    expect(doorView(door, clock.t)).toBe('in');
    expect(door.door?.G).toBe(one.G);
    expect(b.room(groupId(two.G))).toBeUndefined();
  });

  test('a code from an older zafu says so', async () => {
    const { ws } = setup(BOB);
    await expect(ws[0]!.op('door-open', { code: '673-chaos-mail-kite' })).rejects.toThrow(
      OLDER_CODE,
    );
  });

  test('a code is a number and two words; the founder answers at most a dozen runs', () => {
    for (let i = 0; i < 50; i++) {
      const code = makeCode();
      expect(code).toMatch(CODE_RE);
      const { plate } = splitCode(code)!;
      expect(plate).toBeGreaterThanOrEqual(1);
      expect(plate).toBeLessThanOrEqual(999);
    }
    expect(ANSWERS_PER_CODE).toBe(12);
  });

  test('a shared wallet: once n are in, the founder starts its keys, by itself, for the n', async () => {
    const { ws, clock, transport } = setup(ALICE, BOB, CAROL);
    const [a, b, c] = ws as [(typeof ws)[0], (typeof ws)[0], (typeof ws)[0]];
    const { G, code } = await make(a, { name: 'savings', k: 2, n: 3 });
    expect(a.room(groupId(G))?.group?.want).toEqual({ k: 2, n: 3 });

    await comeIn(a, b, code, G, clock, pake);
    expect(a.room(groupId(G))?.group?.want?.started).toBeUndefined();
    expect(b.room(groupId(G))?.group?.want).toEqual({ k: 2, n: 3 });

    clock.t += 10 * 60_000;
    await comeIn(a, c, code, G, clock, pake);
    await a.service.check();
    await b.service.check();
    await c.service.check();
    const started = a.room(groupId(G))?.group?.want?.started;
    expect(started).toBeTruthy();
    for (const w of [a, b, c]) {
      const r = w.room(groupId(G))!;
      const cer = ceremonyOf(r.frost?.msgs, allowedIn(r, w.me(G).pubkey));
      expect(cer?.id).toBe(started);
      expect(cer?.k).toBe(2);
      expect(cer?.members).toHaveLength(3);
    }

    // full: a fourth who types the code is not answered
    const e = peopleWallet('w9', EVE, transport, clock);
    const { id } = (await e.op('door-open', { code })) as { id: string };
    await joinStep(e.room(id)!, pake, e.call);
    await a.service.check();
    await hostStep(a.room(doorId(G))!, a.room(groupId(G)), pake, a.call);
    expect(a.room(doorId(G))?.door?.answered).toHaveLength(2);
  });

  test('a roster record the founder did not write is refused', async () => {
    const { ws, clock, transport } = setup(ALICE, BOB);
    const [a, b] = ws as [(typeof ws)[0], (typeof ws)[0]];
    const { G, code } = await make(a, { name: 'treasury' });
    await comeIn(a, b, code, G, clock, pake);

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
