/**
 * What a set of records binds, read by members who hold different subsets,
 * in different orders, with some records forged or said twice. The relay can
 * withhold and reorder; it must only ever cost time.
 */

import { ed25519 } from '@noble/curves/ed25519';
import { sha256 } from '@noble/hashes/sha2';
import { bytesToHex } from '@noble/hashes/utils';
import { describe, expect, test } from 'vitest';
import {
  genesisId,
  inviteId,
  joinId,
  roomId,
  rosterId,
  rotateId,
  sigMessage,
  sortKeys,
  type Genesis,
  type Invite,
  type Roster,
  type Rotate,
} from './objects';
import {
  maySignRoster,
  maySignRotate,
  membershipOf,
  rostersOf,
  rotationsFrom,
  type RoomRecords,
  type Verify,
} from './state';

const seed = (n: string) => sha256(new TextEncoder().encode(`state-test:${n}`));
const pub = (n: string) => bytesToHex(ed25519.getPublicKey(seed(n)));
const sign = (n: string, id: string) => bytesToHex(ed25519.sign(sigMessage(id), seed(n)));
const verify: Verify = (m, s, k) => {
  try {
    return ed25519.verify(s, m, k);
  } catch {
    return false;
  }
};
const hex = (b: number, n: number) => bytesToHex(new Uint8Array(n).fill(b));

const [A, B, C, D, E] = ['a', 'b', 'c', 'd', 'e'].map(pub) as [string, string, string, string, string];
const name = (k: string) => 'abcde'[[A, B, C, D, E].indexOf(k)]!;

const G: Genesis = { purpose: 'wallet', t: 2, n: 3, salt: hex(1, 16), creator: A };
const Gid = genesisId(G);
const ROOM = roomId('zafu-group-v1', hex(2, 32));

let plate = 1;
/** `owner` invites `joiner`, and both sign the join */
const letIn = (owner: string, joiner: string, th = hex(plate, 32)) => {
  const i: Invite = { G: Gid, owner, plate: plate++, salt: hex(plate, 16), expiry: 2_000_000_000 };
  const j = { I: inviteId(i), joiner, th };
  return {
    invite: { i, sig: sign(name(owner), inviteId(i)) },
    join: { j, js: sign(name(joiner), joinId(j)), os: sign(name(owner), joinId(j)) },
  };
};

const empty = (): RoomRecords => ({
  G,
  room: ROOM,
  invites: [],
  joins: [],
  rosterSigs: [],
  rotateSigs: [],
});

const withAll = (parts: ReturnType<typeof letIn>[]): RoomRecords => ({
  ...empty(),
  invites: parts.map(p => p.invite),
  joins: parts.map(p => p.join),
});

const rosterSig = (r: Roster, who: string) => ({ r, key: who, sig: sign(name(who), rosterId(r)) });

const shuffle = <T>(xs: T[], k: number): T[] => {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = (k * 7919 + i * 104729) % (i + 1);
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
};

describe('seats', () => {
  test('a non-founder invites: whoever holds a seat lets someone in, and they sit too', () => {
    const m = membershipOf(withAll([letIn(A, B), letIn(B, C)]), verify);
    expect([...m.members].sort()).toEqual(sortKeys([A, B, C]));
    expect(m.by.get(C)).toBe(B);
  });

  test('out of order: the records arrive in any order and the seats are the same', () => {
    const parts = [letIn(A, B), letIn(B, C), letIn(C, D)];
    const full = withAll(parts);
    for (let k = 0; k < 12; k++) {
      const rec = {
        ...full,
        invites: shuffle(full.invites, k),
        joins: shuffle(full.joins, k + 3),
      };
      expect([...membershipOf(rec, verify).members].sort()).toEqual(sortKeys([A, B, C, D]));
    }
  });

  test('withheld: a join whose invite has not arrived seats nobody yet, and nobody wrongly', () => {
    const [ab, bc] = [letIn(A, B), letIn(B, C)];
    const rec = { ...empty(), invites: [bc.invite], joins: [ab.join, bc.join] };
    expect([...membershipOf(rec, verify).members]).toEqual([A]);
  });

  test("a join only the joiner signed, or one signed by someone who isn't the owner, seats nobody", () => {
    const ab = letIn(A, B);
    const half = { ...ab.join, os: undefined };
    const forged = { ...ab.join, os: sign('c', joinId(ab.join.j)) };
    expect([...membershipOf({ ...withAll([ab]), joins: [half] }, verify).members]).toEqual([A]);
    expect([...membershipOf({ ...withAll([ab]), joins: [forged] }, verify).members]).toEqual([A]);
  });

  test('an owner who answers one invite twice: shown, and neither seat counts', () => {
    const ab = letIn(A, B);
    const j2 = { I: ab.join.j.I, joiner: C, th: hex(0xee, 32) };
    const twice = { j: j2, js: sign('c', joinId(j2)), os: sign('a', joinId(j2)) };
    for (const joins of [
      [ab.join, twice],
      [twice, ab.join],
    ]) {
      const m = membershipOf({ ...withAll([ab]), joins }, verify);
      expect([...m.members]).toEqual([A]);
      expect(m.twice.get(ab.join.j.I)).toBe(A);
    }
    // a member who saw only one of the two seats that one: it waits, it never decides
    const one = membershipOf(withAll([ab]), verify);
    expect(one.members.has(B)).toBe(true);
  });

  test('an invite from someone without a seat lets nobody in', () => {
    const m = membershipOf(withAll([letIn(D, E)]), verify);
    expect([...m.members]).toEqual([A]);
  });
});

describe('rosters', () => {
  const parts = [letIn(A, B), letIn(A, C)];
  const R: Roster = { G: Gid, members: sortKeys([A, B, C]) };

  test('binds only with every member signing, each seated', () => {
    const rec = withAll(parts);
    const m = membershipOf(rec, verify);
    const two = rostersOf({ ...rec, rosterSigs: [rosterSig(R, A), rosterSig(R, B)] }, m, verify);
    expect(two[0]!.bound).toBe(false);
    const all = rostersOf(
      { ...rec, rosterSigs: [rosterSig(R, A), rosterSig(R, B), rosterSig(R, C)] },
      m,
      verify,
    );
    expect(all[0]!.bound).toBe(true);
    // someone signing for another member is not that member signing
    const fake = { r: R, key: C, sig: sign('a', rosterId(R)) };
    expect(
      rostersOf({ ...rec, rosterSigs: [rosterSig(R, A), rosterSig(R, B), fake] }, m, verify)[0]!
        .bound,
    ).toBe(false);
  });

  test('a roster naming someone with no seat never binds, even signed by all it names', () => {
    const rec = withAll([letIn(A, B)]);
    const R2: Roster = { G: Gid, members: sortKeys([A, B, E]) };
    const v = rostersOf(
      { ...rec, rosterSigs: [rosterSig(R2, A), rosterSig(R2, B), rosterSig(R2, E)] },
      membershipOf(rec, verify),
      verify,
    );
    expect(v[0]).toMatchObject({ seated: false, bound: false });
  });

  test('split views: members with different subsets never bind two different rosters', () => {
    // four people came in for three seats: A, B, C, D. Each signs the one roster
    // its own view supports; the relay shows each member a different subset.
    const all = [letIn(A, B), letIn(A, C), letIn(B, D)];
    const views: Record<string, ReturnType<typeof letIn>[]> = {
      [A]: [all[0]!, all[1]!],
      [B]: [all[0]!, all[2]!],
      [C]: [all[0]!, all[1]!],
      [D]: [all[0]!, all[2]!],
    };
    const signed: ReturnType<typeof rosterSig>[] = [];
    const mine: Record<string, string> = {};
    for (const [me, sub] of Object.entries(views)) {
      const m = membershipOf(withAll(sub), verify);
      const R0: Roster = { G: Gid, members: sortKeys([...m.members]) };
      if (m.members.size === G.n && maySignRoster(R0, me, m, mine[me])) {
        mine[me] = rosterId(R0);
        signed.push(rosterSig(R0, me));
      }
    }
    // whatever any member later sees, at most one roster binds, and here none does
    for (let k = 0; k < 6; k++) {
      const rec = { ...withAll(all), rosterSigs: shuffle(signed, k) };
      const bound = rostersOf(rec, membershipOf(rec, verify), verify).filter(v => v.bound);
      expect(bound.length).toBeLessThanOrEqual(1);
      expect(bound).toEqual([]);
    }
    // a member never signs a second roster for the same genesis
    const Rother: Roster = { G: Gid, members: sortKeys([A, B, D]) };
    const m = membershipOf(withAll(all), verify);
    expect(maySignRoster(Rother, A, m, mine[A])).toBe(false);
  });

  test('equivocating rosters: a member who signs two stops both, for all who see it', () => {
    const all = [letIn(A, B), letIn(A, C), letIn(A, D)];
    const R1: Roster = { G: Gid, members: sortKeys([A, B, C]) };
    const R2: Roster = { G: Gid, members: sortKeys([A, B, D]) };
    // A and B equivocate by signing both; C signs R1, D signs R2: both "bind"
    // only because two members broke the rule, and every reader sees both
    const rec = {
      ...withAll(all),
      rosterSigs: [R1, R2].flatMap(r => r.members.map(k => rosterSig(r, k))),
    };
    const v = rostersOf(rec, membershipOf(rec, verify), verify);
    expect(v.map(x => x.bound)).toEqual([false, false]);
    expect(v.map(x => [...x.twice].sort())).toEqual([sortKeys([A, B]), sortKeys([A, B])]);
    // a member who saw only R1 may think it binds; the setup still needs B and A,
    // who see both, so it waits for them and never finishes as two wallets
  });

  test('the same records in any order bind the same roster', () => {
    const rec = { ...withAll(parts), rosterSigs: R.members.map(k => rosterSig(R, k)) };
    for (let k = 0; k < 6; k++) {
      const shuffled = {
        ...rec,
        invites: shuffle(rec.invites, k),
        joins: shuffle(rec.joins, k),
        rosterSigs: shuffle(rec.rosterSigs, k),
      };
      const b = rostersOf(shuffled, membershipOf(shuffled, verify), verify).filter(x => x.bound);
      expect(b.map(x => x.id)).toEqual([rosterId(R)]);
    }
  });
});

describe('removal before keys rotates the room', () => {
  const chat: Genesis = { purpose: 'chat', t: 0, n: 0, salt: hex(3, 16), creator: A };
  const Gc = genesisId(chat);
  const letInChat = (owner: string, joiner: string) => {
    const i: Invite = { G: Gc, owner, plate: plate++, salt: hex(plate, 16), expiry: 2_000_000_000 };
    const j = { I: inviteId(i), joiner, th: hex(plate, 32) };
    return {
      invite: { i, sig: sign(name(owner), inviteId(i)) },
      join: { j, js: sign(name(joiner), joinId(j)), os: sign(name(owner), joinId(j)) },
    };
  };
  const parts = [letInChat(A, B), letInChat(B, C)];
  const base: RoomRecords = {
    ...empty(),
    G: chat,
    invites: parts.map(p => p.invite),
    joins: parts.map(p => p.join),
  };
  const Rr: Roster = { G: Gc, members: sortKeys([A, C]) };
  const to = roomId('zafu-group-v1', hex(4, 32));
  const rot: Rotate = { R: rosterId(Rr), from: ROOM, to };
  const rotSig = (who: string) => ({ rot, r: Rr, key: who, sig: sign(name(who), rotateId(rot)) });

  test('binds only when every remaining member signed both the roster and the rotation', () => {
    const m = membershipOf(base, verify);
    const partial = {
      ...base,
      rosterSigs: [rosterSig(Rr, A), rosterSig(Rr, C)],
      rotateSigs: [rotSig(A)],
    };
    const r1 = rotationsFrom(partial, rostersOf(partial, m, verify), verify);
    expect(r1[0]!.bound).toBe(false);
    const done = { ...partial, rotateSigs: [rotSig(A), rotSig(C)] };
    const r2 = rotationsFrom(done, rostersOf(done, m, verify), verify);
    expect(r2[0]).toMatchObject({ id: rotateId(rot), bound: true });
    // the removed member, B, is in none of it
    expect(r2[0]!.roster.r.members.includes(B)).toBe(false);
  });

  test('the new room seats exactly the remaining members, from the rotation posted into it', () => {
    const opened: RoomRecords = {
      ...empty(),
      G: chat,
      room: to,
      rotateSigs: [rotSig(A), rotSig(C)],
    };
    expect([...membershipOf(opened, verify).members].sort()).toEqual(sortKeys([A, C]));
    // half-signed, the new room is only its creator's
    const half = { ...opened, rotateSigs: [rotSig(A)] };
    expect([...membershipOf(half, verify).members]).toEqual([A]);
  });

  test('a member signs one rotation per room, and only to a roster it signed', () => {
    const other: Rotate = { ...rot, to: roomId('zafu-group-v1', hex(5, 32)) };
    expect(maySignRotate(rot, Rr, C, ROOM, rosterId(Rr), undefined)).toBe(true);
    expect(maySignRotate(rot, Rr, C, ROOM, undefined, undefined)).toBe(false);
    expect(maySignRotate(other, Rr, C, ROOM, rosterId(Rr), rotateId(rot))).toBe(false);
    expect(maySignRotate(rot, Rr, B, ROOM, rosterId(Rr), undefined)).toBe(false);
  });
});
