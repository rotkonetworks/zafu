import { describe, expect, it } from 'vitest';
import { isZignerSigner, zignerPocketRecord } from './zigner-pocket';

const ZID = 'ab'.repeat(32);
const vault = { id: 'vault-1', insensitive: { zid: ZID, coldSignerType: 'zigner' } };
const main = { mainnet: true };
const key = (accountIndex: number, ufvk = 'uview1' + 'q'.repeat(300)) => ({
  ufvk,
  accountIndex,
  zidPublicKey: ZID,
});

describe('zignerPocketRecord', () => {
  it("files account 2's key under the same vault, read-only", () => {
    expect(zignerPocketRecord(vault, main, key(2), [0], 'savings', 'zcash-x')).toEqual({
      id: 'zcash-x',
      label: 'savings',
      orchardFvk: key(2).ufvk,
      address: '',
      accountIndex: 2,
      mainnet: true,
      vaultId: 'vault-1',
    });
  });

  it("refuses a key from another seed: its ZID isn't this wallet's", () => {
    expect(() =>
      zignerPocketRecord(vault, main, { ...key(1), zidPublicKey: 'cd'.repeat(32) }, [0], 'x', 'i'),
    ).toThrow(/another zigner seed/);
    expect(() =>
      zignerPocketRecord(vault, main, { ...key(1), zidPublicKey: undefined }, [0], 'x', 'i'),
    ).toThrow(/another zigner seed/);
  });

  it('refuses an account that is already here', () => {
    expect(() => zignerPocketRecord(vault, main, key(0), [0], 'x', 'i')).toThrow(/already/);
  });

  it('refuses a key for the other network', () => {
    expect(() =>
      zignerPocketRecord(vault, main, key(1, 'uviewtest1' + 'q'.repeat(300)), [0], 'x', 'i'),
    ).toThrow(/another zcash network/);
  });

  it('gives pockets to zigner only, never keystone, ledger or a bare viewing key', () => {
    expect(isZignerSigner({})).toBe(true);
    expect(isZignerSigner({ coldSignerType: 'zigner' })).toBe(true);
    for (const t of ['keystone', 'ledger', 'viewing-key']) {
      expect(isZignerSigner({ coldSignerType: t })).toBe(false);
      expect(() =>
        zignerPocketRecord(
          { ...vault, insensitive: { zid: ZID, coldSignerType: t } },
          main,
          key(1),
          [0],
          'x',
          'i',
        ),
      ).toThrow(/zigner wallets/);
    }
  });
});
