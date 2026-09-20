import { describe, it, expect } from 'vitest';
import { writable } from './store';

describe('writable - the framework-free reactive primitive', () => {
  it('reads back the last write and notifies every subscriber with it', () => {
    const [read, write] = writable(0);
    const seen: number[] = [];
    read.subscribe(v => seen.push(v));

    expect(read()).toBe(0);
    write(1);
    write(2);

    expect(read()).toBe(2);
    expect(seen).toEqual([1, 2]);
  });

  it('unsubscribe stops delivery but leaves the value readable', () => {
    const [read, write] = writable('a');
    const seen: string[] = [];
    const stop = read.subscribe(v => seen.push(v));

    write('b');
    stop();
    write('c');

    expect(seen).toEqual(['b']);
    expect(read()).toBe('c');
  });

  it('de-dupes by Object.is: the same value never notifies twice', () => {
    const [read, write] = writable<{ n: number } | null>(null);
    let calls = 0;
    read.subscribe(() => calls++);

    const same = { n: 1 };
    write(same);
    write(same); // same reference - no notify (one React re-render, not two)
    expect(calls).toBe(1);

    write({ n: 1 }); // equal shape, new reference - that IS a change
    expect(calls).toBe(2);
  });
});
