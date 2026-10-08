/**
 * Deals: the "join my deal group" record a pair room carries, read only from
 * the other person, and who may take part in a pair room's ceremony.
 *
 * @vitest-environment node
 */

import { describe, expect, test } from 'vitest';
import type { RoomMessage } from '@zafu/zirc/room';
import { onDealAsk as onPair } from './deal';
import { decodeWire, encodeWire } from './door';
import type { PeopleApi } from './service';
import type { PeopleRoom } from './vault';

const ME = 'a'.repeat(64);
const KEN = 'b'.repeat(64);
const CODE = '7-fern-dusk';

const pair: PeopleRoom = {
  id: 'p:ken',
  walletId: 'w',
  kind: 'pair',
  name: 'ken',
  appScope: 'zafu-pair-v1',
  secret: '00'.repeat(32),
  size: 4096,
  relay: 'https://relay.example',
  signer: { gen: 0, j: 1 },
  joined: true,
  createdAt: 0,
  pair: { personId: 'ken', peer: KEN },
};

const record = (author: string, body: string, ts = 100): RoomMessage =>
  ({
    author,
    body,
    ts,
    hash: `${author}${ts}`,
    seq: 0,
    epoch: 0,
    kind: 'action',
    name: '',
  }) as RoomMessage;

describe('a deal between two people', () => {
  test('the join record carries a door code and a name, and nothing else reads as one', () => {
    expect(decodeWire(encodeWire({ kind: 'dj', code: CODE, group: 'logo design' }))).toEqual({
      kind: 'dj',
      code: CODE,
      group: 'logo design',
    });
    expect(decodeWire(encodeWire({ kind: 'dj', code: 'not-a-code', group: 'x' }))).toBe(undefined);
  });

  test('an invite into a deal group counts only from the other person', async () => {
    const body = encodeWire({ kind: 'dj', code: CODE, group: 'logo design' });
    const api = {} as PeopleApi;
    expect(await onPair(pair, [record('c'.repeat(64), body)], api)).toBe(undefined);
    const patch = await onPair(pair, [record(KEN, body, 200)], api);
    expect(patch?.(pair).pair?.deal).toEqual({ code: CODE, group: 'logo design', at: 200 });
    // the same invite read again changes nothing
    expect(await onPair(patch!(pair), [record(KEN, body, 200)], api)).toBe(undefined);
  });
});
