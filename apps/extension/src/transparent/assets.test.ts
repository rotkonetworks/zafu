import { describe, expect, it } from 'vitest';
import { formatBaseUnits, fullDecimalString, heldAssets, knownAssets, totalHeld } from './assets';

const USDC = 'erc20:0xa00C59fF5a080D2b954d0c75e46E22a0c371235a';

describe('transparent assets', () => {
  it('knows injective assets from the bundled registry and the chain config', () => {
    const known = knownAssets('injective');
    expect(known.get(USDC.toLowerCase())).toMatchObject({
      symbol: 'USDC.inj',
      decimals: 6,
      shieldable: true,
    });
    expect(known.get('inj')).toMatchObject({ symbol: 'INJ', decimals: 18 });
  });

  it('knows UM that came back to noble', () => {
    const um = knownAssets('noble').get(
      'ibc/955a03d0bc92b11738a1e4b0c9f2aaf05b79929703f907d2d7af5a0d405ae8c1',
    );
    expect(um).toMatchObject({ symbol: 'UM', decimals: 6, shieldable: true });
  });

  it('lists held known assets, the ramp asset first, skipping zero and unknown', () => {
    const held = heldAssets('injective', [
      { denom: 'inj', amount: 5n },
      { denom: USDC, amount: 20_000_000n },
      { denom: 'factory/unknown/thing', amount: 9n },
      { denom: 'peggy0xdAC17F958D2ee523a2206206994597C13D831ec7', amount: 0n },
    ]);
    expect(held.map(h => h.symbol)).toEqual(['USDC.inj', 'INJ']);
  });

  it('sums per asset across addresses', () => {
    const t = totalHeld('injective', [
      [{ denom: USDC, amount: 1n }],
      [
        { denom: USDC.toLowerCase(), amount: 2n },
        { denom: 'inj', amount: 3n },
      ],
    ]);
    expect(t.map(h => [h.symbol, h.amount])).toEqual([
      ['USDC.inj', 3n],
      ['INJ', 3n],
    ]);
  });

  it('keeps the bank spelling of the denom for transfers', () => {
    const bankSpelling = USDC.toLowerCase();
    const [h] = heldAssets('injective', [{ denom: bankSpelling, amount: 1n }]);
    expect(h?.denom).toBe(bankSpelling);
    expect(h?.symbol).toBe('USDC.inj');
  });

  it('formats without floats and never shows dust as zero', () => {
    expect(formatBaseUnits(1_500_000n, 6)).toBe('1.5');
    expect(formatBaseUnits(1n, 18, 6)).toBe('<0.000001');
    expect(fullDecimalString(123_000_000_000_000_000_001n, 18)).toBe('123.000000000000000001');
  });
});
