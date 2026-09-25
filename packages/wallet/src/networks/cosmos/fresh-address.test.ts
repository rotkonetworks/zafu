import { describe, it, expect } from 'vitest';
import { generateMnemonic } from 'bip39';
import { deriveFreshChainAddress } from './fresh-address';

// Real derivation across both cosmos code paths (coin-118 secp256k1 for osmo /
// noble / cosmoshub, coin-60 eth_secp256k1 for injective). No storage / no
// mock: the counter contract is exercised in storage-chrome's own suite; this
// file confirms that FEEDING DIFFERENT hd indices produces DIFFERENT addresses,
// which is the actual guarantee the burner-rotation flow relies on.

const M = generateMnemonic();

describe('deriveFreshChainAddress', () => {
  it('returns a valid bech32 address with the requested prefix (osmosis)', async () => {
    const derived = await deriveFreshChainAddress('osmosis', M, 1);
    expect(derived.address.startsWith('osmo1')).toBe(true);
    expect(derived.hdIndex).toBe(1);
    expect(derived.chainId).toBe('osmosis');
  });

  it('returns a valid inj1 address for the Ethermint chain (injective)', async () => {
    const derived = await deriveFreshChainAddress('injective', M, 1);
    expect(derived.address.startsWith('inj1')).toBe(true);
    expect(derived.hdIndex).toBe(1);
  });

  it('gives DIFFERENT addresses at different HD indices (unlinkability guarantee)', async () => {
    // If two "burner" derivations produced the same address, an on-chain
    // observer would trivially link the corresponding unshields - the whole
    // reason rotation exists. Check across BOTH derivation paths.
    for (const chainId of ['injective', 'osmosis'] as const) {
      const seen = new Set<string>();
      for (let i = 1; i <= 5; i++) {
        const d = await deriveFreshChainAddress(chainId, M, i);
        seen.add(d.address);
      }
      expect(seen.size, `${chainId} produced duplicates across indices 1..5`).toBe(5);
    }
  });

  it('is deterministic: the same (mnemonic, chain, index) always gives the same address', async () => {
    const a = await deriveFreshChainAddress('injective', M, 7);
    const b = await deriveFreshChainAddress('injective', M, 7);
    expect(a.address).toBe(b.address);
  });

  it('rejects an unknown chainId', async () => {
    // Cast is intentional: the runtime guard exists precisely for the case a
    // caller reaches this via the wire (string chainId), not through the type.
    await expect(deriveFreshChainAddress('made-up-chain' as never, M, 1)).rejects.toThrow(
      /unknown cosmos chain/,
    );
  });
});
