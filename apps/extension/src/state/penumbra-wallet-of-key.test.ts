import { describe, expect, it, vi } from 'vitest';

vi.mock('./keyring', () => ({
  selectEffectiveKeyInfo: (s: { key?: { id: string } }) => s.key,
  selectActiveNetwork: () => 'penumbra',
}));

const { selectPenumbraWalletOfKey } = await import('./wallets');

const at = (id: string, all: { vaultId?: string }[], activeIndex: number) =>
  selectPenumbraWalletOfKey({ key: { id }, wallets: { all, activeIndex } } as never);

describe("the selected wallet's penumbra viewing key", () => {
  const hot = { vaultId: 'hot' };
  const cold = { vaultId: 'cold' };

  it('is found by vault, whatever the active index says', () => {
    expect(at('cold', [hot, cold], 0)).toBe(cold);
  });

  it("is nothing when the wallet has no record, never the last wallet's", () => {
    expect(at('ledger', [hot, cold], 1)).toBeUndefined();
  });

  it('a record from before vault ids is trusted at its index', () => {
    const old = {};
    expect(at('any', [old], 0)).toBe(old);
  });
});
