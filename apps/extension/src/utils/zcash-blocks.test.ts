import { describe, expect, it } from 'vitest';
import { rescanStartHeight } from './zcash-blocks';
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
