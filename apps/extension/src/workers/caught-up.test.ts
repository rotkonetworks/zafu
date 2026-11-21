import { describe, expect, it } from 'vitest';
import { isCaughtUp } from './caught-up';

describe('isCaughtUp', () => {
  it('takes a store at the tip or one block behind it', () => {
    expect(isCaughtUp(3_200_000, 3_200_000)).toBe(true);
    expect(isCaughtUp(3_199_999, 3_200_000)).toBe(true);
  });

  it('refuses a store further behind: its notes may already be spent elsewhere', () => {
    expect(isCaughtUp(3_199_998, 3_200_000)).toBe(false);
    expect(isCaughtUp(3_150_000, 3_200_000)).toBe(false);
  });

  it('refuses a store that has never saved a height', () => {
    expect(isCaughtUp(0, 3_200_000)).toBe(false);
  });
});
