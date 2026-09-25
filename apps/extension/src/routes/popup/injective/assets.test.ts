import { describe, expect, it } from 'vitest';
import { acceptedInjectiveAssets, heldAcceptedAssets, totalHeld } from './assets';

const USDC = 'erc20:0xa00C59fF5a080D2b954d0c75e46E22a0c371235a';

describe('injective assets', () => {
  const accepted = acceptedInjectiveAssets('channel-18');

  it('reads accepted assets from the bundled registry', () => {
    expect(accepted.get(USDC.toLowerCase())).toMatchObject({ symbol: 'USDC.inj', decimals: 6 });
    expect(accepted.get('inj')).toMatchObject({ symbol: 'INJ', decimals: 18 });
  });

  it('lists held accepted assets, USDC.inj first, skipping zero and unknown', () => {
    const held = heldAcceptedAssets(
      [
        { denom: 'inj', amount: 5n },
        { denom: USDC, amount: 20_000_000n },
        { denom: 'factory/unknown/thing', amount: 9n },
        { denom: 'peggy0xdAC17F958D2ee523a2206206994597C13D831ec7', amount: 0n },
      ],
      accepted,
      USDC,
    );
    expect(held.map(h => h.symbol)).toEqual(['USDC.inj', 'INJ']);
  });

  it('sums per asset across addresses', () => {
    const t = totalHeld(
      [
        [{ denom: USDC, amount: 1n }],
        [
          { denom: USDC.toLowerCase(), amount: 2n },
          { denom: 'inj', amount: 3n },
        ],
      ],
      accepted,
      USDC,
    );
    expect(t.map(h => [h.symbol, h.amount])).toEqual([
      ['USDC.inj', 3n],
      ['INJ', 3n],
    ]);
  });

  it('keeps the bank spelling of the denom for transfers', () => {
    const bankSpelling = USDC.toLowerCase();
    const [h] = heldAcceptedAssets([{ denom: bankSpelling, amount: 1n }], accepted, USDC);
    expect(h?.denom).toBe(bankSpelling);
    expect(h?.symbol).toBe('USDC.inj');
  });
});
