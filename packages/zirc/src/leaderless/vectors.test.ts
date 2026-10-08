/**
 * The wire format of #110, pinned: every object's exact bytes and id, from
 * fixed inputs, in `vectors/leaderless-v1.json`. zcli's `zirc-proto` must
 * reproduce the file byte for byte. `UPDATE_VECTORS=1` writes it again, which
 * is a wire change and a new domain version, never an edit.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ed25519 } from '@noble/curves/ed25519';
import { sha256 } from '@noble/hashes/sha2';
import { bytesToHex } from '@noble/hashes/utils';
import { describe, expect, test } from 'vitest';
import {
  commitOf,
  DOMAIN,
  fvkHash,
  genesisBytes,
  genesisId,
  h1Of,
  inviteBytes,
  inviteId,
  joinBytes,
  joinId,
  pakeHash,
  r1Id,
  r2Id,
  revealAad,
  roomId,
  rosterBytes,
  rosterId,
  rotateBoxAad,
  rotateBytes,
  rotateId,
  sigMessage,
  skOf,
  sortKeys,
  type Genesis,
  type Invite,
  type Join,
  type R1,
  type R2,
  type Roster,
  type Rotate,
} from './objects';

const FILE = resolve(__dirname, '../../vectors/leaderless-v1.json');

/** a fixed seed per name: sha256("zafu-vector-key:" + name) */
const seed = (name: string) => sha256(new TextEncoder().encode(`zafu-vector-key:${name}`));
const pub = (name: string) => bytesToHex(ed25519.getPublicKey(seed(name)));
const sign = (name: string, id: string) => bytesToHex(ed25519.sign(sigMessage(id), seed(name)));
const fill = (byte: number, n: number) => bytesToHex(new Uint8Array(n).fill(byte));

const build = () => {
  const [alice, bob, carol] = ['alice', 'bob', 'carol'].map(pub) as [string, string, string];
  const chat: Genesis = { purpose: 'chat', t: 0, n: 0, salt: fill(0x11, 16), creator: alice };
  const wallet: Genesis = { purpose: 'wallet', t: 2, n: 3, salt: fill(0x22, 16), creator: alice };
  const G = genesisId(wallet);
  const invite: Invite = { G, owner: alice, plate: 7, salt: fill(0x33, 16), expiry: 1_791_000_000 };
  const pake = { salt: invite.salt, jid: fill(0x44, 8), x: fill(0x02, 33), y: fill(0x03, 33) };
  const join: Join = {
    I: inviteId(invite),
    joiner: bob,
    th: pakeHash(pake.salt, pake.jid, pake.x, pake.y),
  };
  // bob, now seated, invites carol: anyone with a seat invites
  const invite2: Invite = {
    G,
    owner: bob,
    plate: 418,
    salt: fill(0x55, 16),
    expiry: 1_791_000_600,
  };
  const roster: Roster = { G, members: sortKeys([alice, bob, carol]) };
  const R = rosterId(roster);
  const s = roster.members.map((_, i) => fill(0xa0 + i, 32));
  const r1s: R1[] = roster.members.map((member, i) => ({
    R,
    member,
    b: fill(0xb0 + i, 40),
    x: fill(0xc0 + i, 1216),
    c: commitOf(R, i, s[i]!),
  }));
  const h1 = h1Of(R, r1s.map(r1Id));
  const r2s: R2[] = roster.members.map((member, i) => ({
    R,
    member,
    p: roster.members.filter(m => m !== member).map((_, k) => fill(0xd0 + i * 4 + k, 48)),
    s: roster.members.map((m, k) => (m === member ? '' : fill(0xe0 + i * 4 + k, 24))),
    h1,
  }));
  const fvk = {
    R,
    r1: r1s.map(r1Id),
    r2: r2s.map(r2Id),
    pkp: fill(0xf0, 64),
    ufvk: 'uview1example',
    address: 'u1example',
  };
  const remaining: Roster = { G: genesisId(chat), members: sortKeys([alice, carol]) };
  const scope = 'zafu-group-v1';
  const from = roomId(scope, fill(0x66, 32));
  const rotate: Rotate = { R: rosterId(remaining), from, to: roomId(scope, fill(0x77, 32)) };
  const obj = (bytes: Uint8Array, id: string) => ({ bytes: bytesToHex(bytes), id });
  return {
    about:
      'zafu #110 leaderless objects. lp = u32be length ‖ bytes; frame(D, f) = lp(utf8 D) ‖ lp(f1) ‖ ...; ' +
      'id = sha256(frame). signature = ed25519 over frame("zafu-sig-v1", [id]). ' +
      'keys: ed25519 from seed sha256("zafu-vector-key:" + name).',
    domains: DOMAIN,
    keys: { alice, bob, carol },
    genesis: {
      chat: { input: chat, ...obj(genesisBytes(chat), genesisId(chat)) },
      wallet: { input: wallet, ...obj(genesisBytes(wallet), G) },
    },
    invite: {
      input: invite,
      ...obj(inviteBytes(invite), inviteId(invite)),
      sig: sign('alice', inviteId(invite)),
      sigMessage: bytesToHex(sigMessage(inviteId(invite))),
    },
    pake: { input: pake, th: join.th },
    join: {
      input: join,
      ...obj(joinBytes(join), joinId(join)),
      joinerSig: sign('bob', joinId(join)),
      ownerSig: sign('alice', joinId(join)),
    },
    inviteByMember: {
      input: invite2,
      ...obj(inviteBytes(invite2), inviteId(invite2)),
      sig: sign('bob', inviteId(invite2)),
    },
    roster: {
      input: roster,
      ...obj(rosterBytes(roster), R),
      sigs: Object.fromEntries(['alice', 'bob', 'carol'].map(n => [pub(n), sign(n, R)])),
    },
    dkg: {
      s,
      c: r1s.map(r => r.c),
      r1: r1s.map(r => ({ input: r, id: r1Id(r) })),
      h1,
      r2: r2s.map(r => ({ input: r, id: r2Id(r) })),
      revealAad: bytesToHex(revealAad(R, roster.members[0]!, roster.members[1]!)),
      sk: skOf(R, s),
      fvk: { input: fvk, hash: fvkHash(fvk) },
    },
    rotate: {
      room: { scope, secretFrom: fill(0x66, 32), secretTo: fill(0x77, 32) },
      roster: { input: remaining, ...obj(rosterBytes(remaining), rosterId(remaining)) },
      input: rotate,
      ...obj(rotateBytes(rotate), rotateId(rotate)),
      boxAad: bytesToHex(rotateBoxAad(rotateId(rotate), carol)),
      sigs: Object.fromEntries(['alice', 'carol'].map(n => [pub(n), sign(n, rotateId(rotate))])),
    },
  };
};

describe('wire format vectors', () => {
  test('the objects make exactly the bytes and ids the vectors pin', () => {
    const now = JSON.parse(JSON.stringify(build()));
    if (process.env['UPDATE_VECTORS']) {
      writeFileSync(FILE, JSON.stringify(now, null, 2) + '\n');
    }
    expect(now).toEqual(JSON.parse(readFileSync(FILE, 'utf8')));
  });

  test('a roster is one canonical order: unsorted or repeated members are refused', () => {
    const [a, b] = [pub('alice'), pub('bob')].sort() as [string, string];
    expect(() => rosterBytes({ G: fill(1, 32), members: [b, a] })).toThrow();
    expect(() => rosterBytes({ G: fill(1, 32), members: [a, a] })).toThrow();
    expect(rosterId({ G: fill(1, 32), members: [a, b] })).toMatch(/^[0-9a-f]{64}$/);
  });

  test('a chat says no seats; a wallet says 2 <= t <= n <= 32', () => {
    const g = { salt: fill(1, 16), creator: pub('alice') };
    expect(() => genesisBytes({ ...g, purpose: 'chat', t: 2, n: 3 })).toThrow();
    expect(() => genesisBytes({ ...g, purpose: 'wallet', t: 1, n: 3 })).toThrow();
    expect(() => genesisBytes({ ...g, purpose: 'wallet', t: 4, n: 3 })).toThrow();
    expect(() => genesisBytes({ ...g, purpose: 'wallet', t: 2, n: 33 })).toThrow();
    expect(genesisId({ ...g, purpose: 'wallet', t: 2, n: 2 })).not.toBe(
      genesisId({ ...g, purpose: 'wallet', t: 2, n: 3 }),
    );
  });

  test('domains separate: the same fields under two objects never share an id', () => {
    const k = fill(9, 32);
    const r: Rotate = { R: k, from: k, to: k };
    const j: Join = { I: k, joiner: k, th: k };
    expect(rotateId(r)).not.toBe(joinId(j));
  });
});
