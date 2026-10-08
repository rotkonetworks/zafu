/**
 * Groups through the door, on a fake relay and the real SPAKE2: the founder
 * makes a group, others type its code and come in, the roster comes from the
 * founder's log, and they talk. A code lets one person in; a wrong word is
 * seen at once, opens nothing and spends nothing; the relay's mailbox never
 * holds the words; two codes that share a number stay apart; the founder can
 * take someone off until the keys are made; and a roster record nobody
 * authorised is refused.
 *
 * @vitest-environment node
 */

import { beforeAll, describe, expect, test, vi } from 'vitest';
import { hexToBytes } from '@noble/hashes/utils';
import { appendRecord } from '@zafu/zirc';
import { GROUP_ROOM_PLAINTEXT_BYTES, Room, ZAFU_GROUP_APP_SCOPE } from '@zafu/zirc/room';
import { deriveRoomKeys } from '../state/identity';
import { groupId, OLDER_CODE } from './groups';
import { ANSWERS_PER_CODE, CODE_RE, DOOR_VERSION, encodeWire, makeCode, splitCode } from './door';
import { doorView, hostStep, joinStep, type DoorPake } from './door-run';
import { allowedIn, cameFor, ceremonyOf, foldFrost } from './frost-room';
import { identityOf } from './keys';
import { chain } from './service';
import { wordName } from './word-name';
import { comeIn, hostDoor, peopleWallet, realPake, relayBoard } from './door.test-util';

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
    const words = hostDoor(a, code).door?.answered?.[0]?.words;
    expect(words?.split(' ')).toHaveLength(2);
    expect(door.door?.words).toBe(words);
    // the arrival, said in the founder's thread by name, with the words
    expect(a.lines(groupId(G))).toContain(
      `: ${wordName(bobKey)} joined with your code · words to compare: ${words}`,
    );
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
    // the founder answered one run, the one guess it got, and the code is not spent
    expect(hostDoor(a, code).door?.answered).toHaveLength(1);
    expect(hostDoor(a, code).door?.admitted).toBeUndefined();
  });

  test('a code lets one person in: whoever types it next is told so, calmly, and nothing opens', async () => {
    const { ws, clock } = setup(ALICE, BOB, CAROL);
    const [a, b, c] = ws as [(typeof ws)[0], (typeof ws)[0], (typeof ws)[0]];
    const { G, code } = await make(a, { name: 'treasury' });
    // a guess first: a wrong word spends nothing
    const [n, w1] = code.split('-');
    await comeIn(a, c, `${n}-${w1}-${w1 === 'zoo' ? 'abandon' : 'zoo'}`, G, clock, pake);
    expect(doorView(await comeIn(a, b, code, G, clock, pake), clock.t)).toBe('in');

    // the code forwarded: the right words, and still nothing
    const again = await comeIn(a, c, code, G, clock, pake);
    expect(doorView(again, clock.t)).toBe('used');
    expect(c.room(groupId(G))).toBeUndefined();
    expect(a.room(groupId(G))?.group?.members).toHaveLength(2);
    // exactly one box went out
    const boxes = hostDoor(a, code).door!.heard.filter(h => h.wire.kind === 'wb');
    expect(boxes).toHaveLength(1);

    // "invite another": a second code lets carol in
    const { code: next } = (await a.op('group-renew', { G })) as { code: string };
    expect(next).not.toBe(code);
    expect(doorView(await comeIn(a, c, next, G, clock, pake), clock.t)).toBe('in');
    expect(a.room(groupId(G))?.group?.members).toHaveLength(3);
  });

  test("the relay's mailbox holds the number's records, never the words", async () => {
    const { ws, clock } = setup(ALICE, BOB);
    const [a, b] = ws as [(typeof ws)[0], (typeof ws)[0]];
    const { G, code } = await make(a, { name: 'treasury' });
    await comeIn(a, b, code, G, clock, pake);
    const said = JSON.stringify(hostDoor(a, code).door?.heard);
    for (const kind of ['wh', 'wj', 'wa', 'wk', 'wb']) {
      expect(said).toContain(`"${kind}"`);
    }
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
    const twoId = hostDoor(c, two.code).id;
    await c.service.api.updateRoom(twoId, r => ({
      ...r,
      secret: hostDoor(a, one.code).secret,
      door: { ...r.door!, code: moved },
    }));
    c.service.close();
    await c.service.api.send(
      twoId,
      encodeWire({ kind: 'wh', v: DOOR_VERSION, salt: c.room(twoId)!.door!.salt! }),
      'action',
    );

    const { id } = (await b.op('door-open', { code: one.code })) as { id: string };
    await joinStep(b.room(id)!, pake, b.call);
    expect(b.room(id)?.door?.sent).toHaveLength(2);
    for (let turn = 0; turn < 2; turn++) {
      for (const [w, G, code] of [
        [a, one.G, one.code],
        [c, two.G, moved],
      ] as const) {
        await w.service.check();
        await hostStep(hostDoor(w, code), w.room(groupId(G)), pake, w.call);
      }
      await b.service.check();
      await joinStep(b.room(id)!, pake, b.call);
    }
    const door = b.room(id)!;
    expect(doorView(door, clock.t)).toBe('in');
    expect(door.door?.G).toBe(one.G);
    expect(b.room(groupId(two.G))).toBeUndefined();
    // speaking to carol's code by mistake spent nothing of hers
    expect(c.room(twoId)?.door?.admitted).toBeUndefined();
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
    const { code: second } = (await a.op('group-renew', { G })) as { code: string };
    await comeIn(a, c, second, G, clock, pake);
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
      // typing the code was the yes: nothing more is asked of anyone
      expect(cameFor(r, cer!)).toBe(true);
    }

    // full: a fourth who types a fresh code is not answered
    const { code: third } = (await a.op('group-renew', { G })) as { code: string };
    const e = peopleWallet('w9', EVE, transport, clock);
    const { id } = (await e.op('door-open', { code: third })) as { id: string };
    await joinStep(e.room(id)!, pake, e.call);
    await a.service.check();
    await hostStep(hostDoor(a, third), a.room(groupId(G)), pake, a.call);
    expect(hostDoor(a, third).door?.answered ?? []).toHaveLength(0);
  });

  test('the founder can take someone off until the keys are made; they stay off', async () => {
    const { ws, clock } = setup(ALICE, BOB, CAROL);
    const [a, b, c] = ws as [(typeof ws)[0], (typeof ws)[0], (typeof ws)[0]];
    const { G, code } = await make(a, { name: 'savings', k: 2, n: 3 });
    await comeIn(a, b, code, G, clock, pake);
    const bobKey = deriveRoomKeys(BOB, 0, G).pubkey;

    await a.op('group-remove', { G, key: bobKey });
    expect(a.room(groupId(G))?.group?.members).toHaveLength(1);
    expect(a.lines(groupId(G))).toContain(`: ${wordName(bobKey)} is no longer in the group`);
    // bob still holds the room: his ask again is not voiced
    await b.service.api.send(
      groupId(G),
      encodeWire({
        kind: 'ask',
        key: bobKey,
        name: 'bob',
        seal: deriveRoomKeys(BOB, 0, G).xwingPublicKey,
      }),
      'action',
    );
    clock.t += 5_000;
    await a.service.check();
    expect(a.room(groupId(G))?.group?.members).toHaveLength(1);
    clock.t += 5_000;
    await b.service.check();
    expect(b.room(groupId(G))?.group?.members.map(m => m.key)).not.toContain(bobKey);

    // invited again, with a new code: bob is back; then carol, and the keys start
    for (const w of [b, c]) {
      const { code: next } = (await a.op('group-renew', { G })) as { code: string };
      await comeIn(a, w, next, G, clock, pake);
    }
    expect(a.room(groupId(G))?.group?.members).toHaveLength(3);
    expect(a.room(groupId(G))?.group?.want?.started).toBeTruthy();
    // no one can be taken off once the keys are being made
    await expect(a.op('group-remove', { G, key: bobKey })).rejects.toThrow();
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
