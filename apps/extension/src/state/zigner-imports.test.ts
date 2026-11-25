import { describe, expect, it, vi } from 'vitest';
import { addPendingZignerWallets, keepCompanionExports, pendingZignerAdds } from './zigner-imports';

describe('keepCompanionExports', () => {
  const penumbra = {
    accountIndex: 0,
    label: null,
    fvkBytes: new Uint8Array([1]),
    walletIdBytes: new Uint8Array([2]),
    fvkBech32m: 'penumbrafullviewingkey1example',
    zidPublicKey: 'aa',
  };
  const zcash = {
    accountIndex: 0,
    label: null,
    orchardFvk: null,
    transparentXpub: null,
    mainnet: true,
    address: null,
    ufvk: 'uview1example',
    zidPublicKey: 'aa',
    coldSignerType: 'zigner' as const,
  };

  it('keeps the first network when the other network is scanned next', () => {
    const afterFirst = keepCompanionExports({}, { parsedPenumbraExport: penumbra });
    const afterSecond = keepCompanionExports(afterFirst, { parsedZcashExport: zcash });
    expect(afterSecond.parsedPenumbraExport).toBe(penumbra);
    expect(afterSecond.parsedZcashExport).toBe(zcash);
  });

  it('replaces only the network that was scanned again', () => {
    const first = keepCompanionExports(
      {},
      { parsedPenumbraExport: penumbra, parsedZcashExport: zcash },
    );
    const later = { ...penumbra, fvkBech32m: 'penumbrafullviewingkey1other' };
    const after = keepCompanionExports(first, { parsedPenumbraExport: later });
    expect(after.parsedPenumbraExport).toBe(later);
    expect(after.parsedZcashExport).toBe(zcash);
  });
});

describe('pendingZignerAdds', () => {
  const walletImport = {
    fullViewingKey: { inner: new Uint8Array([1, 2, 3]) },
    walletId: { inner: new Uint8Array([4, 5, 6]) },
    accountIndex: 0,
    zidPublicKey: 'ab'.repeat(32),
  };
  const zcashWalletImport = {
    ufvk: 'uview1example',
    accountIndex: 0,
    zidPublicKey: 'ab'.repeat(32),
    coldSignerType: 'zigner' as const,
  };

  it('lists both networks so they can join one wallet', () => {
    const adds = pendingZignerAdds({ walletImport, zcashWalletImport, walletLabel: 'zigner' });
    expect(adds).toHaveLength(2);
    expect(adds[0]!.data.fullViewingKey).toBeDefined();
    expect(adds[0]!.data.zidPublicKey).toBe('ab'.repeat(32));
    expect(adds[1]!.data.viewingKey).toBe('uview1example');
    expect(adds[1]!.data.zidPublicKey).toBe('ab'.repeat(32));
  });

  it('still lists a single network when only one code was scanned', () => {
    expect(pendingZignerAdds({ zcashWalletImport })).toHaveLength(1);
    expect(pendingZignerAdds({ walletImport })).toHaveLength(1);
  });
});

describe('addPendingZignerWallets', () => {
  it('adds each code in order; codes from one zigner join by their ZID, not by being next', async () => {
    const add = vi.fn().mockResolvedValueOnce('vault-1').mockResolvedValueOnce('vault-1');
    const id = await addPendingZignerWallets(
      [
        { data: { accountIndex: 0, deviceId: 'a' }, name: 'one' },
        { data: { accountIndex: 0, deviceId: 'a', viewingKey: 'uview1example' }, name: 'two' },
      ],
      add,
    );
    expect(id).toBe('vault-1');
    expect(add).toHaveBeenNthCalledWith(1, expect.objectContaining({ deviceId: 'a' }), 'one');
    expect(add).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ viewingKey: 'uview1example' }),
      'two',
    );
  });
});
