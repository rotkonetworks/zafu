/**
 * The device's side of a leaderless group (#110) in small pieces: the
 * joiner's proof to its inviter, what a room an older zafu made reads as,
 * which rosters are key setups, the new room secret's box, and the invite
 * box a door sends.
 *
 * @vitest-environment node
 */

import { describe, expect, test } from 'vitest';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import { openXWing, sealXWing } from '@zafu/pq';
import {
  genesisId,
  rosterId,
  rotateBoxAad,
  sigMessage,
  sortKeys,
  type Genesis,
  type Roster,
} from '@zafu/zirc/leaderless';
import { ed25519 } from '@noble/curves/ed25519';
import { deriveRoomKeys } from '../state/identity';
import { DOOR_VERSION, openBox, sealBox } from './door';
import type { FrostMsg } from './frost-room';
import { isLegacy, joinMac, keygensOf, recordsOf, upgradeGenesis } from './lx';
import type { PeopleRoom } from './vault';

const PHRASES = [
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
  'legal winner thank year wave sausage worth useful legal winner thank yellow',
  'letter advice cage absurd amount doctor acoustic avoid letter advice cage above',
];
const TAG = 'ab'.repeat(16);
const [A, B, C] = PHRASES.map(p => deriveRoomKeys(p, 0, TAG)) as [
  ReturnType<typeof deriveRoomKeys>,
  ReturnType<typeof deriveRoomKeys>,
  ReturnType<typeof deriveRoomKeys>,
];

const wallet: Genesis = { purpose: 'wallet', t: 2, n: 3, salt: TAG, creator: A.pubkey };

const room = (msgs: FrostMsg[], g: Genesis | null = wallet): PeopleRoom => ({
  id: `g:${TAG}`,
  walletId: 'w',
  kind: 'group',
  name: 'studio',
  appScope: 'zafu-group-v1',
  secret: '11'.repeat(32),
  size: 4096,
  relay: 'https://relay.example',
  signer: { gen: 0, G: TAG },
  joined: true,
  createdAt: 0,
  group: { G: TAG, founder: A.pubkey, mine: true, members: [], ...(g ? { g } : {}) },
  frost: { msgs },
});

const signed = (r: Roster, k: typeof A, at = 1): FrostMsg => ({
  from: k.pubkey,
  at,
  mid: '0',
  body: {
    t: 'rs',
    v: 2,
    id: rosterId(r),
    r,
    k: k.pubkey,
    sig: bytesToHex(ed25519.sign(sigMessage(rosterId(r)), k.seed)),
  },
});

describe('a leaderless room on this device', () => {
  test("the joiner's proof binds the run's key and the join: neither can be swapped", () => {
    const [k1, k2, j1, j2] = ['01', '02', '03', '04'].map(b => b.repeat(32));
    expect(joinMac(k1!, j1!)).toMatch(/^[0-9a-f]{64}$/);
    expect(joinMac(k1!, j1!)).toBe(joinMac(k1!, j1!));
    expect(joinMac(k2!, j1!)).not.toBe(joinMac(k1!, j1!));
    expect(joinMac(k1!, j2!)).not.toBe(joinMac(k1!, j1!));
  });

  test('a group an older zafu made is upgrading, and makes no keys until it is upgraded', () => {
    const r = sortKeys([A.pubkey, B.pubkey, C.pubkey]);
    const roster = { G: genesisId(wallet), members: r };
    const old = room([signed(roster, A)], null);
    expect(isLegacy(old)).toBe(true);
    // its genesis is fixed by its tag and its founder: every member arrives at the same one
    expect(recordsOf(old)?.G).toEqual(upgradeGenesis(old));
    expect(upgradeGenesis(old)).toEqual({
      purpose: 'chat',
      t: 0,
      n: 0,
      salt: TAG,
      creator: A.pubkey,
    });
    expect(keygensOf(old)).toEqual([]);
  });

  test('only a roster with as many members as its wallet has seats is a key setup', () => {
    // a removal before keys: a roster of the two left, for the 2-of-3 genesis
    const two = { G: genesisId(wallet), members: sortKeys([A.pubkey, B.pubkey]) };
    expect(keygensOf(room([signed(two, A), signed(two, B)]))).toEqual([]);
  });

  test('two rosters for one wallet, each with a signature: both wait, shown as rivals', () => {
    // the creator alone holds a seat here, so neither can bind; both are shown
    const r1 = { G: genesisId(wallet), members: sortKeys([A.pubkey, B.pubkey, C.pubkey]) };
    const r2 = { G: genesisId(wallet), members: sortKeys([A.pubkey, B.pubkey, 'ee'.repeat(32)]) };
    const kg = keygensOf(room([signed(r1, A, 1), signed(r2, B, 2)]));
    expect(kg.map(k => [k.rival, k.bound])).toEqual([
      [true, false],
      [true, false],
    ]);
  });

  test("the new room secret's box opens only for its member, and only for its rotation", () => {
    const rot = 'cd'.repeat(32);
    const secret = '22'.repeat(32);
    const box = sealXWing(
      hexToBytes(C.xwingPublicKey),
      hexToBytes(secret),
      rotateBoxAad(rot, C.pubkey),
    );
    expect(bytesToHex(openXWing(C.xwingSeed, box, rotateBoxAad(rot, C.pubkey)))).toBe(secret);
    expect(() => openXWing(B.xwingSeed, box, rotateBoxAad(rot, B.pubkey))).toThrow();
    expect(() => openXWing(C.xwingSeed, box, rotateBoxAad('ef'.repeat(32), C.pubkey))).toThrow();
  });

  test("a door's box carries the group's genesis and the invite; an older or mismatched one is refused", async () => {
    const key = crypto.getRandomValues(new Uint8Array(32));
    const I = { G: genesisId(wallet), owner: A.pubkey, plate: 7, salt: 'cc'.repeat(16), expiry: 9 };
    const body = {
      secret: '33'.repeat(32),
      relay: 'https://r',
      group: 'studio',
      G: TAG,
      g: wallet,
      I,
      from: 'a',
    };
    expect(await openBox(key, await sealBox(key, body))).toMatchObject({ g: wallet, I });
    // an invite for another genesis than the one it carries
    const other = { ...body, I: { ...I, G: 'ff'.repeat(32) } };
    await expect(openBox(key, await sealBox(key, other))).rejects.toThrow('not an invite');
    // a box an older zafu would send: no genesis, no invite
    const older = {
      secret: body.secret,
      relay: body.relay,
      group: 'x',
      G: TAG,
      founder: A.pubkey,
      from: '',
    };
    await expect(openBox(key, await sealBox(key, older as never))).rejects.toThrow('not an invite');
    expect(DOOR_VERSION).toBe(3);
  });
});
