import { describe, expect, it } from 'vitest';
import { CAPS, walletKind, zcashSendRefusal, type SendFlags } from './wallet-kind';

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
    [
      'zcash app ledger with a t-address',
      { type: 'zigner-zafu', insensitive: { coldSignerType: 'ledger', custody: 'ledger-zcash' } },
      { transparentAddress: 't1x' },
      'ledger-shielded',
    ],
    ['frost self-custody', { type: 'frost-multisig' }, { multisig: {} }, 'frost-self'],
    ['frost vault without its zcash record', { type: 'frost-multisig' }, undefined, 'frost-self'],
    [
      'frost airgap',
      { type: 'frost-multisig' },
      { multisig: { custody: 'airgapSigner' } },
      'frost-airgap',
    ],
    // an unrecognised record refuses; it is never guessed to be a zigner
    ['trezor vault', { type: 'trezor' }, undefined, 'unknown'],
    ['a vault type zafu has never seen', { type: 'satchel' }, undefined, 'unknown'],
    ['zigner-zafu with a foreign cold signer', cold('abacus'), undefined, 'unknown'],
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
      const r = zcashSendRefusal(
        kind,
        { hardwareWallet: false, ledgerTransparent: true },
        'orchard',
      );
      expect(r?.title).toBe('ledger signs transparent zcash only for now');
      expect(r?.body).toBe("shielded sends need a zigner or this wallet's phrase");
    },
  );

  it('lets a shielded ledger through only when hardware signing is on', () => {
    expect(
      zcashSendRefusal(
        'ledger-shielded',
        { hardwareWallet: true, ledgerTransparent: false },
        'ironwood',
      ),
    ).toBeNull();
  });

  // the bitcoin app holds no viewing key, so the shielded flag never routes it
  it('lets a transparent ledger through only with the transparent flag', () => {
    for (const f of FLAG_SETS) {
      const r = zcashSendRefusal('ledger-transparent', f, 'orchard');
      expect(r === null).toBe(f.ledgerTransparent);
    }
  });

  it.each(FLAG_SETS)('always refuses a viewing key (%o)', f => {
    expect(zcashSendRefusal('viewing-key', f, 'orchard')?.title).toBe(
      'this wallet is a viewing key',
    );
  });

  it.each(FLAG_SETS)('always refuses an unknown signer, calmly (%o)', f => {
    expect(zcashSendRefusal('unknown', f, 'orchard')).toMatchObject({
      title: "zafu does not recognise this wallet's signer",
      body: 'nothing was sent · please send from a zigner or a phrase wallet',
    });
  });

  it.each(FLAG_SETS)('never refuses a kind that has a signer for both pools (%o)', f => {
    for (const k of ['hot', 'zigner', 'frost-self', 'frost-airgap'] as const) {
      expect(zcashSendRefusal(k, f, 'orchard')).toBeNull();
      expect(zcashSendRefusal(k, f, 'ironwood')).toBeNull();
    }
  });

  // founder decision: keystone stays orchard-only after NU6.3. An ironwood
  // build rides zigner's ur:zigner-module envelope, which keystone cannot read.
  it.each(FLAG_SETS)('keystone signs orchard, and is refused an ironwood send (%o)', f => {
    expect(zcashSendRefusal('keystone', f, 'orchard')).toBeNull();
    expect(zcashSendRefusal('keystone', f, 'ironwood')).toEqual({
      icon: 'i-ph-qr-code',
      title: 'keystone signs orchard only for now',
      body: "ironwood sends need a zigner or this wallet's phrase",
    });
  });

  // app 3.9.4 signs ironwood and refuses post-NU6.3 orchard spends
  it('a shielded ledger sends ironwood and is refused orchard before any build', () => {
    const on = { hardwareWallet: true, ledgerTransparent: true };
    expect(zcashSendRefusal('ledger-shielded', on, 'ironwood')).toBeNull();
    expect(zcashSendRefusal('ledger-shielded', on, 'orchard')?.title).toBe(
      'orchard waits for a newer ledger app',
    );
  });
});

describe('CAPS', () => {
  it('offers the ironwood migration only to kinds that sign ironwood on its QR', () => {
    const offered = Object.entries(CAPS)
      .filter(([, c]) => c.migrate)
      .map(([k]) => k);
    expect(offered).toEqual(['hot', 'zigner']);
  });

  it('signs a thorchain deposit only where zafu holds the key and shows the memo', () => {
    const signs = Object.entries(CAPS)
      .filter(([, c]) => c.opReturn)
      .map(([k]) => k);
    expect(signs).toEqual(['hot']);
  });

  it('asks for a password only where zafu holds the secret', () => {
    expect(CAPS.hot.unlockToSign).toBe(true);
    expect(CAPS['frost-self'].unlockToSign).toBe(true);
    for (const k of ['zigner', 'keystone', 'frost-airgap', 'ledger-shielded'] as const) {
      expect(CAPS[k].unlockToSign).toBe(false);
    }
  });

  it('refuses a zafu identity for every kind but hot, zigner and frost', () => {
    for (const k of [
      'keystone',
      'ledger-shielded',
      'ledger-transparent',
      'viewing-key',
      'unknown',
    ] as const) {
      expect(CAPS[k].zid).toEqual(expect.any(String));
    }
    for (const k of ['hot', 'zigner', 'frost-self', 'frost-airgap'] as const) {
      expect(CAPS[k].zid).toBeNull();
    }
  });
});
