import { describe, expect, it } from 'vitest';
import { walletKind, zcashSendRefusal, type SendFlags } from './wallet-kind';

const cold = (coldSignerType?: string) => ({
  type: 'zigner-zafu',
  insensitive: coldSignerType ? { coldSignerType } : {},
});

const FLAG_SETS: SendFlags[] = [
  { hardwareWallet: false, ledgerTransparent: false },
  { hardwareWallet: false, ledgerTransparent: true },
  { hardwareWallet: true, ledgerTransparent: false },
  { hardwareWallet: true, ledgerTransparent: true },
];

describe('walletKind', () => {
  it.each([
    ['mnemonic', { type: 'mnemonic' }, undefined, 'hot'],
    ['zigner', cold('zigner'), undefined, 'zigner'],
    ['zigner, older record without coldSignerType', cold(), undefined, 'zigner'],
    ['keystone', cold('keystone'), undefined, 'keystone'],
    ['viewing key', cold('viewing-key'), undefined, 'viewing-key'],
    ['ledger vault', { type: 'ledger' }, undefined, 'ledger-shielded'],
    ['ledger cold import', cold('ledger'), {}, 'ledger-shielded'],
    [
      'ledger with a t-address',
      cold('ledger'),
      { transparentAddress: 't1x' },
      'ledger-transparent',
    ],
    ['frost self-custody', { type: 'frost-multisig' }, { multisig: {} }, 'frost-self'],
    ['frost vault without its zcash record', { type: 'frost-multisig' }, undefined, 'frost-self'],
    [
      'frost airgap',
      { type: 'frost-multisig' },
      { multisig: { custody: 'airgapSigner' } },
      'frost-airgap',
    ],
  ] as const)('%s', (_, key, zcash, want) => {
    expect(walletKind(key, zcash)).toBe(want);
  });
});

describe('zcashSendRefusal', () => {
  // the bug: with HARDWARE_WALLET_ENABLED off, a shielded ledger fell through
  // to the zigner arm of handleSign and was shown a zigner QR.
  it.each([{ type: 'ledger' }, cold('ledger')])(
    'refuses a shielded ledger when hardware signing is off (%o)',
    key => {
      const kind = walletKind(key, {});
      expect(kind).not.toBe('zigner');
      const r = zcashSendRefusal(kind, { hardwareWallet: false, ledgerTransparent: true });
      expect(r?.title).toBe('ledger signs transparent zcash only for now');
      expect(r?.body).toBe("shielded sends need a zigner or this wallet's phrase");
    },
  );

  it('lets a shielded ledger through only when hardware signing is on', () => {
    expect(
      zcashSendRefusal('ledger-shielded', { hardwareWallet: true, ledgerTransparent: false }),
    ).toBeNull();
  });

  it('lets a transparent ledger through when either ledger flag is on', () => {
    for (const f of FLAG_SETS) {
      const r = zcashSendRefusal('ledger-transparent', f);
      expect(r === null).toBe(f.ledgerTransparent || f.hardwareWallet);
    }
  });

  it.each(FLAG_SETS)('always refuses a viewing key (%o)', f => {
    expect(zcashSendRefusal('viewing-key', f)?.title).toBe('this wallet is a viewing key');
  });

  it.each(FLAG_SETS)('never refuses a kind that has a signer (%o)', f => {
    for (const k of ['hot', 'zigner', 'keystone', 'frost-self', 'frost-airgap'] as const) {
      expect(zcashSendRefusal(k, f)).toBeNull();
    }
  });
});
