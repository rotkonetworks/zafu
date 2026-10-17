/**
 * A line reaching someone away longer than the relay keeps it: said again,
 * filed once, and read receipts only where both turned them on.
 *
 * @vitest-environment node
 */

import { describe, expect, test } from 'vitest';
import type { RoomMessage } from '@zafu/zirc/room';
import { RESEND_AFTER_MS, RESEND_FOR_MS, againBody, dueAgain, fromAgain, seenOf } from './delivery';
import { pairId } from './protocol';
import { paired } from './test-pair';
import type { ThreadItem } from './vault';

const H = 'ab'.repeat(32);
const NOW = Date.UTC(2026, 9, 17, 12);
const mine = (o: Partial<ThreadItem> = {}): ThreadItem => ({
  hash: H,
  author: 'me',
  name: '',
  body: 'hello: there',
  ts: Math.floor((NOW - RESEND_AFTER_MS - 1000) / 1000),
  epoch: 0,
  kind: 'msg',
  mine: true,
  ...o,
});
const rec = (body: string, author = 'them', ts = 1): RoomMessage =>
  ({ hash: 'x', author, name: '', body, ts, epoch: 7, kind: 'action' }) as RoomMessage;

describe('saying a line again', () => {
  test('the line comes back whole, under its first id and time, colons and all', () => {
    const back = fromAgain(rec(againBody(mine({ kind: 'action' }))), 'me-not');
    expect(back).toMatchObject({ hash: H, body: 'hello: there', kind: 'action', mine: false });
    expect(back?.ts).toBe(mine().ts);
    expect(fromAgain(rec('zp2:again:nothex:1:m:x'), 'me')).toBeUndefined();
  });

  test('only your own lines on the relay, young enough, unread and not said lately', () => {
    expect(dueAgain([mine()], 0, NOW)).toHaveLength(1);
    expect(dueAgain([mine({ mine: false })], 0, NOW)).toHaveLength(0);
    expect(dueAgain([mine({ status: 'waiting' })], 0, NOW)).toHaveLength(0);
    expect(dueAgain([mine({ kind: 'note' })], 0, NOW)).toHaveLength(0);
    expect(dueAgain([mine({ posted: NOW - 1000 })], 0, NOW)).toHaveLength(0);
    expect(
      dueAgain([mine({ ts: Math.floor((NOW - RESEND_FOR_MS) / 1000) - 1 })], 0, NOW),
    ).toHaveLength(0);
    // they said they read it
    expect(dueAgain([mine()], mine().ts, NOW)).toHaveLength(0);
  });

  test("their latest 'read up to', never someone else's", () => {
    expect(
      seenOf([rec('zp2:seen:10'), rec('zp2:seen:30'), rec('zp2:seen:99', 'other')], 'them'),
    ).toEqual({ upTo: 30, at: 1 });
  });
});

describe('a line reaches someone away three days', () => {
  test('said again before the relay lets it go, it arrives once', async () => {
    const { alice, bob, clock, turns } = await paired();
    await turns(3);
    expect(await alice.service.say(pairId('b'), 'are you there')).toBe('sent');
    // bob is away; alice opens zafu now and then
    clock.t += RESEND_AFTER_MS + 60_000;
    await alice.service.check();
    clock.t += 30 * 3600_000;
    await alice.service.check();
    await bob.service.check();
    expect(bob.lines(pairId('a'))).toEqual(['them: are you there']);
  });

  test('someone who had it already sees it once', async () => {
    const { alice, bob, clock, turns } = await paired();
    await turns(3);
    await alice.service.say(pairId('b'), 'once');
    await turns(1);
    clock.t += RESEND_AFTER_MS + 60_000;
    await alice.service.check();
    await bob.service.check();
    expect(bob.lines(pairId('a'))).toEqual(['them: once']);
  });
});

describe('read receipts, per chat', () => {
  test('both on: reading says so, and the line stops going again', async () => {
    const { alice, bob, turns } = await paired();
    await turns(3);
    await alice.receipts(pairId('b'), true);
    await bob.receipts(pairId('a'), true);
    await alice.service.say(pairId('b'), 'read me');
    await turns(1);
    await bob.service.read(pairId('a'));
    await turns(1);
    const said = alice.thread(pairId('b'))!.items.find(i => i.body === 'read me')!;
    expect(alice.room(pairId('b'))!.pair?.seen?.upTo).toBeGreaterThanOrEqual(said.ts);
  });

  test('off on their side: reading tells you nothing', async () => {
    const { alice, bob, turns } = await paired();
    await turns(3);
    await alice.receipts(pairId('b'), true);
    await alice.service.say(pairId('b'), 'quiet');
    await turns(1);
    await bob.service.read(pairId('a'));
    await turns(1);
    expect(alice.room(pairId('b'))!.pair?.seen).toBeUndefined();
  });
});
