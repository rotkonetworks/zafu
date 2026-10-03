import { describe, expect, it } from 'vitest';
import { mergeLoadedNotes, mergeLoadedSpent } from './wallet-state-merge';

interface Note {
  nullifier: string;
  witness_hex?: string;
  witness_tree_size?: number;
}

describe('mergeLoadedNotes', () => {
  it('replaces state when no sync loop is running', () => {
    const live: Note[] = [{ nullifier: 'a', witness_hex: 'w2', witness_tree_size: 2 }];
    const loaded: Note[] = [{ nullifier: 'b' }];
    expect(mergeLoadedNotes(live, loaded, false)).toBe(loaded);
  });

  it("keeps the live loop's witness when IndexedDB is a batch behind", () => {
    const liveNote: Note = { nullifier: 'a', witness_hex: 'w2', witness_tree_size: 2 };
    const live = [liveNote];
    const loaded: Note[] = [{ nullifier: 'a', witness_hex: 'w1', witness_tree_size: 1 }];
    const merged = mergeLoadedNotes(live, loaded, true);
    expect(merged).toBe(live);
    expect(merged).toEqual([liveNote]);
    expect(merged[0]).toBe(liveNote);
    expect(merged[0]!.witness_hex).toBe('w2');
  });

  it('adds notes the live loop has not seen, in place', () => {
    const live: Note[] = [{ nullifier: 'a' }];
    const merged = mergeLoadedNotes(live, [{ nullifier: 'a' }, { nullifier: 'b' }], true);
    expect(merged).toBe(live);
    expect(merged.map(n => n.nullifier)).toEqual(['a', 'b']);
  });
});

describe('mergeLoadedSpent', () => {
  it('replaces when not syncing', () => {
    const live = new Set(['x']);
    expect([...mergeLoadedSpent(live, ['y'], false)]).toEqual(['y']);
  });

  it('unions into the live set while syncing', () => {
    const live = new Set(['x']);
    const merged = mergeLoadedSpent(live, ['y'], true);
    expect(merged).toBe(live);
    expect([...merged].sort()).toEqual(['x', 'y']);
  });
});
