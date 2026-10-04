import { describe, expect, it } from 'vitest';
import { untilLabel } from './crosschain';

describe('untilLabel', () => {
  it('ticks minutes and seconds under an hour', () => {
    expect(untilLabel(599)).toBe('9:59');
  });
  it('rounds to hours and minutes under two days', () => {
    expect(untilLabel(2 * 3600 + 13 * 60 + 5)).toBe('2 h 13 min');
  });
  it('shows days for a long deposit deadline', () => {
    expect(untilLabel(4439 * 60 + 49)).toBe('3 days');
  });
});
