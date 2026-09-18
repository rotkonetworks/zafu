import { describe, expect, it } from 'vitest';
import { rescanStartHeight, safeBirthdayFloor } from './zcash-blocks';
import { ZCASH_ORCHARD_ACTIVATION } from '../config/networks';

describe('rescanStartHeight', () => {
  it('keeps a real wallet birthday', () => {
    expect(rescanStartHeight(2_500_000)).toBe(2_500_000);
  });

  it('never returns the chain tip for a missing birthday', () => {
    // the bug: `walletBirthday || chainHeight` made "no birthday recorded"
    // mean "start scanning from now", and the handler then WROTE that as the
    // birthday — every note already held became unreachable.
    const tip = 3_500_000;
    for (const missing of [0, undefined, null, NaN]) {
      const h = rescanStartHeight(missing as number);
      expect(h).toBe(ZCASH_ORCHARD_ACTIVATION);
      expect(h).toBeLessThan(tip);
    }
  });

  it('clamps a below-activation height up rather than scanning nothing', () => {
    expect(rescanStartHeight(1)).toBe(ZCASH_ORCHARD_ACTIVATION);
    expect(rescanStartHeight(-5)).toBe(ZCASH_ORCHARD_ACTIVATION);
  });

  it('floors fractional heights', () => {
    expect(rescanStartHeight(2_500_000.9)).toBe(2_500_000);
  });
});

describe('safeBirthdayFloor', () => {
  it('rounds down to the nearest 10k and drops one more for margin', () => {
    // 2,536,789 -> floor to 2,530,000 -> minus 10k -> 2,520,000. Always lands
    // before the estimate so no pre-birthday note is skipped.
    expect(safeBirthdayFloor(2_536_789)).toBe(2_520_000);
    expect(safeBirthdayFloor(2_530_000)).toBe(2_520_000);
  });

  it('never returns a height below orchard activation', () => {
    expect(safeBirthdayFloor(ZCASH_ORCHARD_ACTIVATION)).toBe(ZCASH_ORCHARD_ACTIVATION);
    expect(safeBirthdayFloor(ZCASH_ORCHARD_ACTIVATION + 5_000)).toBe(ZCASH_ORCHARD_ACTIVATION);
    expect(safeBirthdayFloor(0)).toBe(ZCASH_ORCHARD_ACTIVATION);
  });

  it('falls back to orchard activation for non-finite input', () => {
    expect(safeBirthdayFloor(NaN)).toBe(ZCASH_ORCHARD_ACTIVATION);
    expect(safeBirthdayFloor(Infinity)).toBe(ZCASH_ORCHARD_ACTIVATION);
  });

  it('stays at or below the input (biases early, never late)', () => {
    for (const h of [1_800_000, 2_000_000, 3_000_000, 3_456_123]) {
      expect(safeBirthdayFloor(h)).toBeLessThanOrEqual(h);
    }
  });
});
