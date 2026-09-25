import { describe, expect, it } from 'vitest';
import {
  LEGACY_SCAN_GAP,
  MAX_RECENT_SCAN,
  fundedIndicesKey,
  scanIndices,
  shownIndicesKey,
} from './hd';

describe('transparent hd', () => {
  it('keeps the storage keys the injective screen used', () => {
    expect(shownIndicesKey('injective', 'k')).toBe('injectiveShownIndices:k');
    expect(fundedIndicesKey('injective', 'k')).toBe('injectiveFundedIndices:k');
  });

  it('always scans the legacy first-empty range', () => {
    expect(scanIndices(0)).toEqual(Array.from({ length: LEGACY_SCAN_GAP + 1 }, (_, i) => i));
  });

  it('adds the most recent handed-out indices, capped', () => {
    const idx = scanIndices(100);
    expect(idx).toContain(100);
    expect(idx).toContain(100 - MAX_RECENT_SCAN + 1);
    expect(idx).not.toContain(100 - MAX_RECENT_SCAN);
    expect(idx).toContain(0);
  });

  it('always scans indices that ever held funds', () => {
    expect(scanIndices(100, [40])).toContain(40);
  });

  it('treats garbage counters as 0', () => {
    expect(scanIndices(Number.NaN)).toEqual(scanIndices(0));
    expect(scanIndices(-3)).toEqual(scanIndices(0));
  });
});
