/**
 * A group shows lines from its roster only: holding the room secret lets
 * anyone write, the roster is who the founder put on it.
 *
 * @vitest-environment node
 */

import { describe, expect, test } from 'vitest';
import { onRoster, type PeopleRoom, type Thread, type ThreadItem } from './vault';

const line = (author: string, body: string, mine = false): ThreadItem =>
  ({ hash: body, author, name: author, body, ts: 1, mine }) as ThreadItem;

const group = (members: string[]): PeopleRoom =>
  ({
    id: 'g:1',
    kind: 'group',
    group: { G: '1', founder: 'f', mine: false, members: members.map(key => ({ key })) },
  }) as unknown as PeopleRoom;

describe('a group thread, as shown', () => {
  const t: Thread = {
    read: 0,
    items: [
      line('f', 'hello'),
      line('m', 'hi'),
      line('x', 'not on the roster'),
      line('me', 'mine', true),
    ],
  };

  test('keeps the founder, members and your own lines', () => {
    expect(onRoster(group(['m']), t)?.items.map(i => i.body)).toEqual(['hello', 'hi', 'mine']);
  });

  test("a member's line shows once their +v arrives: nothing was dropped", () => {
    expect(onRoster(group([]), t)?.items.map(i => i.body)).toEqual(['hello', 'mine']);
    expect(onRoster(group(['m', 'x']), t)?.items).toHaveLength(4);
  });

  test('a pair room is not filtered', () => {
    const pair = { id: 'p:1', kind: 'pair' } as unknown as PeopleRoom;
    expect(onRoster(pair, t)).toBe(t);
  });
});
