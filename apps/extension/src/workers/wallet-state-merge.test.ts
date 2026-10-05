import { describe, expect, it } from 'vitest';
import { mergeLoadedNotes, mergeLoadedSpent, readAcrossRewinds } from './wallet-state-merge';

interface Note {
  nullifier: string;
  spent_at_height?: number;
}

describe('mergeLoadedNotes', () => {
  it('replaces state when no sync loop is running', () => {
    const live: Note[] = [{ nullifier: 'a', spent_at_height: 2 }];
    const loaded: Note[] = [{ nullifier: 'b' }];
    expect(mergeLoadedNotes(live, loaded, false)).toBe(loaded);
  });

  it("keeps the live loop's note when IndexedDB is a batch behind", () => {
    const liveNote: Note = { nullifier: 'a', spent_at_height: 2 };
    const live = [liveNote];
    const loaded: Note[] = [{ nullifier: 'a' }];
    const merged = mergeLoadedNotes(live, loaded, true);
    expect(merged).toBe(live);
    expect(merged).toEqual([liveNote]);
    expect(merged[0]).toBe(liveNote);
    expect(merged[0]!.spent_at_height).toBe(2);
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

describe('readAcrossRewinds', () => {
  it('reads again when a rewind lands during the read', async () => {
    let rewinds = 0;
    const store = ['orphan', 'kept'];
    let reads = 0;
    const result = await readAcrossRewinds(
      () => rewinds,
      async () => {
        reads++;
        const snapshot = [...store];
        if (reads === 1) {
          // the rewind commits while this read is in flight
          store.splice(0, 1);
          rewinds++;
        }
        return snapshot;
      },
    );
    expect(reads).toBe(2);
    expect(result).toEqual(['kept']);
  });

  it('reads once when nothing moves', async () => {
    let reads = 0;
    await readAcrossRewinds(
      () => 0,
      async () => {
        reads++;
        return reads;
      },
    );
    expect(reads).toBe(1);
  });
});
