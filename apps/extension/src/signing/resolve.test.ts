import { describe, expect, it, vi } from 'vitest';

const isPopup = vi.hoisted(() => vi.fn(() => false));
vi.mock('../utils/popup-detection', () => ({ isPopup }));

import { persistentSurface, zcashSignerFor } from './resolve';
import type { SendFlags, WalletKind, ZcashArm } from './wallet-kind';

const ARMS: ZcashArm[] = [
  'hot',
  'zigner',
  'ledger-shielded',
  'ledger-transparent',
  'frost-self',
  'frost-airgap',
];

/** one spy per implementation: a refused signer must reach none of them, and
 *  so none of the seed, multisig secrets, ledger or worker calls they make */
const spies = () =>
  Object.fromEntries(ARMS.map(a => [a, vi.fn(() => Promise.resolve(a))])) as Record<
    ZcashArm,
    ReturnType<typeof vi.fn<() => Promise<string>>>
  >;

const ON: SendFlags = { hardwareWallet: true, ledgerTransparent: true };
const OFF: SendFlags = { hardwareWallet: false, ledgerTransparent: false };

describe('zcashSignerFor', () => {
  it.each([
    ['hot', 'hot'],
    ['zigner', 'zigner'],
    ['keystone', 'zigner'],
    ['ledger-shielded', 'ledger-shielded'],
    ['ledger-transparent', 'ledger-transparent'],
    ['frost-self', 'frost-self'],
    ['frost-airgap', 'frost-airgap'],
  ] as [WalletKind, ZcashArm][])(
    '%s signs with the %s implementation, and only that one',
    async (kind, want) => {
      const arms = spies();
      await expect(zcashSignerFor(kind, ON, arms)()).resolves.toBe(want);
      for (const a of ARMS) {
        expect(arms[a]).toHaveBeenCalledTimes(a === want ? 1 : 0);
      }
    },
  );

  // watch-only cannot sign; neither can a flag-off ledger or an unknown
  // signer. None of them may touch an implementation.
  it.each([
    ['viewing-key', ON, /viewing key/],
    ['viewing-key', OFF, /viewing key/],
    ['unknown', ON, /does not recognise/],
    ['unknown', OFF, /does not recognise/],
    ['ledger-shielded', OFF, /not ready yet/],
    [
      'ledger-shielded',
      { hardwareWallet: false, ledgerTransparent: true },
      /transparent zcash only/,
    ],
    ['ledger-transparent', OFF, /not ready yet/],
  ] as [WalletKind, SendFlags, RegExp][])(
    'refuses %s (%o) without calling any signer',
    async (kind, flags, reason) => {
      const arms = spies();
      await expect(zcashSignerFor(kind, flags, arms)()).rejects.toThrow(reason);
      for (const a of ARMS) {
        expect(arms[a]).not.toHaveBeenCalled();
      }
    },
  );

  // PR 0's regression, kept: a shielded ledger with hardware signing off was
  // shown a zigner QR by the old final `else`.
  it('never hands a flag-off shielded ledger to the zigner flow', async () => {
    const arms = spies();
    await expect(zcashSignerFor('ledger-shielded', OFF, arms)()).rejects.toThrow();
    expect(arms.zigner).not.toHaveBeenCalled();
  });

  it('a t-address ledger with only the shielded flag on takes the PCZT path', async () => {
    const flags = { hardwareWallet: true, ledgerTransparent: false };
    await expect(zcashSignerFor('ledger-transparent', flags, spies())()).resolves.toBe(
      'ledger-shielded',
    );
  });
});

describe('persistentSurface', () => {
  it('refuses in the toolbar popup before the device is touched', async () => {
    isPopup.mockReturnValueOnce(true);
    const next = vi.fn(() => Promise.resolve('signed'));
    await expect(persistentSurface(next)()).rejects.toThrow(/open zafu in a tab/);
    expect(next).not.toHaveBeenCalled();
  });

  it('passes through in a tab or the side panel', async () => {
    await expect(persistentSurface(() => Promise.resolve('signed'))()).resolves.toBe('signed');
  });
});
