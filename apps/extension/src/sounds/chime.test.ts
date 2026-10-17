import { describe, expect, it } from 'vitest';
import { newIncoming } from './chime';
import type { Thread, ThreadItem } from '../people/vault';

const line = (hash: string, o: Partial<ThreadItem> = {}): ThreadItem => ({
  hash,
  author: 'k',
  name: '',
  body: 'hi',
  ts: 1,
  epoch: 0,
  kind: 'msg',
  mine: false,
  ...o,
});
const t = (...items: ThreadItem[]): Thread => ({ items, read: 0 });

describe('what rings the bell', () => {
  it('a new line from someone, never your own, a note, a draft or one already there', () => {
    const before = { a: t(line('1')) };
    const after = {
      a: t(
        line('1'),
        line('2'),
        line('3', { mine: true }),
        line('4', { kind: 'note' }),
        line('', { local: 'x' }),
      ),
      b: t(line('5')),
    };
    expect(newIncoming(before, after)).toBe(2);
    expect(newIncoming(after, after)).toBe(0);
  });
});
