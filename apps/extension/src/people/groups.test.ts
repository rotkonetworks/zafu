/**
 * Groups through the door with no leader (#110), on a fake relay and the
 * real SPAKE2: someone makes a group, others type a code and come in, each
 * seat a join co-signed by the invite's owner, and they talk. Anyone seated
 * invites. A code lets one person in, and its owner co-signs one join for it;
 * an owner who co-signs two seats neither. A wrong word is seen at once,
 * opens nothing and spends nothing; the relay's mailbox never holds the
 * words; two codes that share a number stay apart. Removing someone before
 * keys moves the rest to a room the removed one cannot read.
 *
 * @vitest-environment node
 */

import { beforeAll, describe, expect, test, vi } from 'vitest';
import { hexToBytes } from '@noble/hashes/utils';
import { ed25519 } from '@noble/curves/ed25519';
import { bytesToHex } from '@noble/hashes/utils';
import { joinId, sigMessage } from '@zafu/zirc/leaderless';
import { deriveRoomKeys } from '../state/identity';
import { groupId, OLDER_CODE } from './groups';
import { ANSWERS_PER_CODE, CODE_RE, DOOR_VERSION, encodeWire, makeCode, splitCode } from './door';
import { doorView, hostStep, joinStep, type DoorPake } from './door-run';
import { frostOps, packFrost, type FrostBody } from './frost-room';
import { joinMac, keygensOf, viewOf } from './lx';
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
    ws: phrases.map((p, i) => withPost(peopleWallet(`w${i}`, p, transport, clock))),
  };
};

const make = async (w: ReturnType<typeof setup>['ws'][number], args: Record<string, unknown>) => {
  const { id, code } = (await w.op('group-create', args)) as { id: string; code: string };
  return { G: id.slice(2), code };
};

/** say one leaderless record in a room, as this wallet */
const withPost = <T extends ReturnType<typeof setup>['ws'][number]>(w: T) =>
  Object.assign(w, {
    post: async (roomId: string, body: FrostBody) =>
      frostOps['frost-post']({ roomId, bodies: await packFrost(body) }, w.service),
  });

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

  test('a shared wallet: once n are in, every member signs the roster of all of them, by itself', async () => {
    const { ws, clock, transport } = setup(ALICE, BOB, CAROL);
    const [a, b, c] = ws as [(typeof ws)[0], (typeof ws)[0], (typeof ws)[0]];
    const { G, code } = await make(a, { name: 'savings', k: 2, n: 3 });
    expect(a.room(groupId(G))?.group?.want).toEqual({ k: 2, n: 3 });

    await comeIn(a, b, code, G, clock, pake);
    expect(keygensOf(a.room(groupId(G))!)).toEqual([]);
    expect(b.room(groupId(G))?.group?.want).toEqual({ k: 2, n: 3 });

    clock.t += 10 * 60_000;
    const { code: second } = (await a.op('group-renew', { G })) as { code: string };
    await comeIn(a, c, second, G, clock, pake);
    for (let i = 0; i < 2; i++) {
      for (const w of [a, b, c]) {
        await w.service.check();
      }
    }
    const ids = new Set<string>();
    for (const w of [a, b, c]) {
      const [kg] = keygensOf(w.room(groupId(G))!);
      expect(kg).toMatchObject({ k: 2, bound: true });
      expect(kg!.members).toHaveLength(3);
      ids.add(kg!.id);
    }
    // the same roster everywhere, signed by all three, and nobody tapped anything
    expect(ids.size).toBe(1);

    // full: a fourth who types a fresh code is not answered
    const { code: third } = (await a.op('group-renew', { G })) as { code: string };
    const e = peopleWallet('w9', EVE, transport, clock);
    const { id } = (await e.op('door-open', { code: third })) as { id: string };
    await joinStep(e.room(id)!, pake, e.call);
    await a.service.check();
    await hostStep(hostDoor(a, third), a.room(groupId(G)), pake, a.call);
    expect(hostDoor(a, third).door?.answered ?? []).toHaveLength(0);
  });

  test('a member who is not the founder invites: their own zafu answers, the founder closed', async () => {
    const { ws, clock } = setup(ALICE, BOB, CAROL);
    const [a, b, c] = ws as [(typeof ws)[0], (typeof ws)[0], (typeof ws)[0]];
    const { G, code } = await make(a, { name: 'savings', k: 2, n: 3 });
    await comeIn(a, b, code, G, clock, pake);
    // alice closes zafu; bob invites carol, and bob's zafu answers
    const { code: bobs } = (await b.op('group-renew', { G })) as { code: string };
    const door = await comeIn(b, c, bobs, G, clock, pake);
    expect(doorView(door, clock.t)).toBe('in');
    const keys = [ALICE, BOB, CAROL].map(p => deriveRoomKeys(p, 0, G).pubkey);
    for (const w of [b, c]) {
      expect(
        w
          .room(groupId(G))
          ?.group?.members.map(m => m.key)
          .sort(),
      ).toEqual([...keys].sort());
    }
    expect(b.lines(groupId(G))).toContain(
      `: ${wordName(keys[2]!)} joined with your code · words to compare: ${door.door?.words}`,
    );
    // the roster waits for alice's word: it never binds without her
    expect(keygensOf(c.room(groupId(G))!)[0]).toMatchObject({ bound: false });
    // alice opens zafu: she reads bob's invite and carol's join, seats her, and signs
    clock.t += 1_000;
    await a.service.check();
    await a.service.check();
    for (const w of [b, c]) {
      await w.service.check();
    }
    expect(a.room(groupId(G))?.group?.members).toHaveLength(3);
    expect(keygensOf(c.room(groupId(G))!)[0]).toMatchObject({ bound: true });
  });

  test('a code is single use: its owner co-signs one join for it, ever', async () => {
    const { ws, clock } = setup(ALICE, BOB);
    const [a, b] = ws as [(typeof ws)[0], (typeof ws)[0]];
    const { G, code } = await make(a, { name: 'treasury' });
    await comeIn(a, b, code, G, clock, pake);
    const room = b.room(groupId(G))!;
    const half = room.frost!.msgs.find(m => m.body.t === 'join')!.body as Extract<
      FrostBody,
      { t: 'join' }
    >;
    // the joiner, who holds the run's key, tries a second seat on the same invite
    const other = deriveRoomKeys(EVE, 0, G);
    const j = { I: half.id, joiner: other.pubkey, th: half.j.th };
    const id = joinId(j);
    const door = hostDoor(a, code).door!;
    await b.post(groupId(G), {
      t: 'join',
      v: 2,
      id: half.id,
      j,
      js: bytesToHex(ed25519.sign(sigMessage(id), other.seed)),
      jm: joinMac(door.mk!, id),
    });
    for (let i = 0; i < 2; i++) {
      clock.t += 1_000;
      await a.service.check();
      await b.service.check();
    }
    expect(hostDoor(a, code).door?.cosigned).not.toBe(id);
    const v = viewOf(a.room(groupId(G))!)!;
    expect(v.m.members.has(other.pubkey)).toBe(false);
    expect(v.m.twice.size).toBe(0);
  });

  test('an owner who answers one invite twice: everyone is shown, and neither seat counts', async () => {
    const { ws, clock } = setup(ALICE, BOB, CAROL);
    const [a, b, c] = ws as [(typeof ws)[0], (typeof ws)[0], (typeof ws)[0]];
    const { G, code } = await make(a, { name: 'treasury' });
    await comeIn(a, b, code, G, clock, pake);
    // alice's device misbehaves: it co-signs a second join for the code bob used
    const I = viewOf(a.room(groupId(G))!)!.rec.joins[0]!.j.I;
    const eve = deriveRoomKeys(EVE, 0, G);
    const alice = deriveRoomKeys(ALICE, 0, G);
    const j = { I, joiner: eve.pubkey, th: 'ee'.repeat(32) };
    const id = joinId(j);
    const sign = (k: { seed: Uint8Array }) => bytesToHex(ed25519.sign(sigMessage(id), k.seed));
    await a.post(groupId(G), { t: 'join', v: 2, id: I, j, js: sign(eve), os: sign(alice) });
    for (let i = 0; i < 2; i++) {
      clock.t += 1_000;
      for (const w of [a, b, c]) {
        await w.service.check();
      }
    }
    for (const w of [a, b]) {
      const v = viewOf(w.room(groupId(G))!)!;
      expect([...v.m.members]).toEqual([alice.pubkey]);
      expect(w.lines(groupId(G))?.some(l => l.includes('let two people in with one code'))).toBe(
        true,
      );
    }
  });

  test('removed before keys: the room rotates, and the removed member cannot read it', async () => {
    const { ws, clock } = setup(ALICE, BOB);
    const [a, b] = ws as [(typeof ws)[0], (typeof ws)[0]];
    const { G, code } = await make(a, { name: 'savings', k: 2, n: 3 });
    await comeIn(a, b, code, G, clock, pake);
    const bobKey = deriveRoomKeys(BOB, 0, G).pubkey;
    const old = a.room(groupId(G))!.secret;

    await a.op('group-remove', { G, key: bobKey });
    for (let i = 0; i < 2; i++) {
      clock.t += 1_000;
      await a.service.check();
      await b.service.check();
    }
    const moved = a.room(groupId(G))!;
    expect(moved.secret).not.toBe(old);
    expect(moved.group?.members.map(m => m.key)).toEqual([deriveRoomKeys(ALICE, 0, G).pubkey]);
    expect(a.lines(groupId(G))).toContain(`: ${wordName(bobKey)} is no longer in the group`);
    // bob is told, calmly, and keeps the old room only
    expect(b.room(groupId(G))?.group?.gone).toBe(true);
    expect(b.room(groupId(G))?.secret).toBe(old);
    expect(b.lines(groupId(G))).toContain(": you're no longer in this group");
    // alice speaks in the new room: bob never reads it
    expect(await a.service.say(groupId(G), 'only for the ones still here')).toBe('sent');
    clock.t += 5_000;
    await b.service.check();
    expect(b.lines(groupId(G))?.some(l => l.includes('only for the ones still here'))).toBe(false);

    // invited again, with a new code: bob comes into the new room
    const { code: next } = (await a.op('group-renew', { G })) as { code: string };
    await comeIn(a, b, next, G, clock, pake);
    expect(b.room(groupId(G))?.secret).toBe(moved.secret);
    expect(b.room(groupId(G))?.group?.gone).toBeFalsy();
    expect(a.room(groupId(G))?.group?.members).toHaveLength(2);
  });

  test('removing someone with others left waits for every one of them, and then all move', async () => {
    const { ws, clock } = setup(ALICE, BOB, CAROL);
    const [a, b, c] = ws as [(typeof ws)[0], (typeof ws)[0], (typeof ws)[0]];
    const { G, code } = await make(a, { name: 'studio' });
    await comeIn(a, b, code, G, clock, pake);
    const { code: second } = (await a.op('group-renew', { G })) as { code: string };
    await comeIn(a, c, second, G, clock, pake);
    for (const w of [a, b, c]) {
      await w.service.check();
    }
    const carol = deriveRoomKeys(CAROL, 0, G).pubkey;
    const old = a.room(groupId(G))!.secret;
    await a.op('group-remove', { G, key: carol });
    for (let i = 0; i < 2; i++) {
      clock.t += 1_000;
      for (const w of [a, b, c]) {
        await w.service.check();
      }
    }
    // bob has not signed: nobody moved, and bob is shown what is asked of him
    expect(a.room(groupId(G))!.secret).toBe(old);
    expect(b.lines(groupId(G))?.some(l => l.includes('asked to remove'))).toBe(true);
    // bob signs both (how bob says yes is still open in #110; here his device does it directly)
    const v = viewOf(b.room(groupId(G))!)!;
    const rot = v.rotations[0]!;
    const bob = deriveRoomKeys(BOB, 0, G);
    const sign = (id: string) => bytesToHex(ed25519.sign(sigMessage(id), bob.seed));
    const r = rot.roster.r;
    await b.post(groupId(G), {
      t: 'rs',
      v: 2,
      id: rot.rot.R,
      r,
      k: bob.pubkey,
      sig: sign(rot.rot.R),
    });
    await b.post(groupId(G), {
      t: 'rot',
      v: 2,
      id: rot.id,
      rot: rot.rot,
      r,
      k: bob.pubkey,
      sig: sign(rot.id),
    });
    for (let i = 0; i < 3; i++) {
      clock.t += 1_000;
      for (const w of [a, b, c]) {
        await w.service.check();
      }
    }
    // alice and bob are in one new room; carol is told and cannot read it
    expect(a.room(groupId(G))!.secret).not.toBe(old);
    expect(b.room(groupId(G))!.secret).toBe(a.room(groupId(G))!.secret);
    expect(c.room(groupId(G))?.group?.gone).toBe(true);
    expect(await b.service.say(groupId(G), 'just us two now')).toBe('sent');
    clock.t += 5_000;
    await a.service.check();
    await c.service.check();
    expect(a.lines(groupId(G))?.some(l => l.endsWith('just us two now'))).toBe(true);
    expect(c.lines(groupId(G))?.some(l => l.endsWith('just us two now'))).toBe(false);
    // the new room seats exactly the two, from the rotation they both signed
    expect(viewOf(a.room(groupId(G))!)!.m.members).toEqual(
      new Set([deriveRoomKeys(ALICE, 0, G).pubkey, bob.pubkey]),
    );
  });
});
