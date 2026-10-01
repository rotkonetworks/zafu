import { describe, expect, it } from 'vitest';
import { REBUILD_MS, rebuildLeft, rebuildSince } from './witness-rebuild';

describe('rebuildSince', () => {
  it('starts on the worker label and keeps the first start', () => {
    expect(rebuildSince(undefined, 'witness corrupt - rebuilding', 5)).toBe(5);
    expect(rebuildSince(5, 'witness corrupt - rebuilding', 9)).toBe(5);
  });

  it('holds through the backfill sub-steps', () => {
    expect(rebuildSince(5, 'backfill: blocks downloaded', 9)).toBe(5);
    expect(rebuildSince(5, 'backfill: witness rebuilt', 9)).toBe(5);
    expect(rebuildSince(undefined, 'backfill: replaying tree', 9)).toBeUndefined();
  });

  it('ends on any later stage, or a new send', () => {
    for (const step of ['witnesses built', 'proving (halo2)', 'complete', 'loading wallet state']) {
      expect(rebuildSince(5, step, 9)).toBeUndefined();
    }
  });
});

describe('rebuildLeft', () => {
  it('counts down the worker estimate and then stops promising', () => {
    expect(rebuildLeft(0, 0)).toBe('about 3 min left');
    expect(rebuildLeft(0, 61_000)).toBe('about 2 min left');
    expect(rebuildLeft(0, REBUILD_MS + 1)).toBe('a little longer');
  });
});
