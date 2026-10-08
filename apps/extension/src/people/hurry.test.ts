/**
 * Which rooms are read fast while zafu is open: only those someone waits on
 * right now. Everything else keeps its pace, and a wallet with no open code
 * and no shared wallet in the making reads nothing at popup open.
 */

import { describe, expect, test } from 'vitest';
import { hurried } from './hurry';
import { askingOf } from './sw';
import type { DoorState, PeopleRoom } from './vault';

const NOW = Date.UTC(2026, 9, 8, 12);
const MIN = 60_000;
const G = '00112233445566778899aabbccddeeff';
const SALT = '6498600a'.repeat(4);

const base = (over: Partial<PeopleRoom>): PeopleRoom => ({
  id: `g:${G}`,
  walletId: 'w',
  kind: 'group',
  name: 'savings',
  appScope: 'zafu-group-v1',
  secret: '07'.repeat(32),
  size: 4096,
  relay: 'https://relay.example',
  signer: { gen: 0, G },
  joined: true,
  createdAt: NOW - 2 * 3600_000,
  ...over,
});

const door = (d: Partial<DoorState>, over: Partial<PeopleRoom> = {}): PeopleRoom =>
  base({
    id: `d:${G}:6498600a`,
    kind: 'door',
    joined: false,
    createdAt: NOW - 10 * MIN,
    until: NOW + 50 * MIN,
    door: { code: '7-fern-dusk', role: 'host', salt: SALT, heard: [], ...d },
    ...over,
  });

const wj = { from: 'b', at: 0, wire: { kind: 'wj', v: 2, salt: SALT, jid: 'aa'.repeat(8), y: '' } };

describe('read fast only while someone waits', () => {
  test('nothing open, nothing in the making: nothing is read', () => {
    expect(hurried([base({}), base({ id: 'p:bob', kind: 'pair' })], NOW).size).toBe(0);
  });

  test("an open code, and the founder's group that its asks arrive in", () => {
    expect([...hurried([base({}), door({})], NOW)].sort()).toEqual([`d:${G}:6498600a`, `g:${G}`]);
  });

  test('a code that let someone in: its group a few minutes more for their ask, then nothing', () => {
    const spent = (ago: number) =>
      door({
        admitted: 'aa'.repeat(8),
        answered: [{ jid: 'aa'.repeat(8), words: 'a b', at: NOW - ago }],
      });
    expect([...hurried([spent(MIN)], NOW)]).toEqual([`g:${G}`]);
    expect(hurried([spent(10 * MIN)], NOW).size).toBe(0);
  });

  test("a code whose hour ended, or a joiner's door that is in, wrong or used: nothing", () => {
    for (const r of [
      door({}, { until: NOW - 1 }),
      door({ role: 'join', G }),
      door({ role: 'join', wrong: true }),
      door({ role: 'join', used: true }),
    ]) {
      expect(hurried([r], NOW).has(r.id)).toBe(false);
    }
    expect(hurried([door({ role: 'join', sent: [SALT] })], NOW).size).toBe(1);
  });

  test('a shared wallet filling within its hour, then at the usual pace', () => {
    const filling = (age: number) =>
      base({
        createdAt: NOW - age,
        group: { G, founder: 'a', mine: false, members: [], want: { k: 2, n: 3 } },
      });
    expect(hurried([filling(5 * MIN)], NOW).size).toBe(1);
    expect(hurried([filling(2 * 3600_000)], NOW).size).toBe(0);
  });

  test('keys being made: fast while the ceremony moves, not once saved or gone quiet', () => {
    const keys = (lastAgoS: number, saved = false) =>
      base({
        frost: {
          msgs: [
            {
              from: 'a',
              at: NOW / 1000 - lastAgoS,
              mid: '0',
              body: { t: 'start', id: 'c1', k: 2, m: ['a', 'b', 'c'], label: '' },
            },
          ],
          ...(saved ? { mine: { c1: { saved: true } } } : {}),
        },
      });
    expect(hurried([keys(30)], NOW).size).toBe(1);
    expect(hurried([keys(30, true)], NOW).size).toBe(0);
    expect(hurried([keys(20 * 60)], NOW).size).toBe(0);
  });
});

describe('the people badge', () => {
  test('one per code someone typed, until it lets them in', () => {
    const typed = door({ heard: [wj, { ...wj, wire: { ...wj.wire, jid: 'bb'.repeat(8) } }] });
    expect(askingOf([typed])).toEqual([{ walletId: 'w', n: 1, until: typed.until }]);
    expect(askingOf([door({ heard: [wj], admitted: 'aa'.repeat(8) })])).toEqual([]);
    expect(askingOf([door({})])).toEqual([]);
  });
});
