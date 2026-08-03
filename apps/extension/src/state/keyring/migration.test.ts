import { describe, expect, test } from 'vitest';
import {
  backfillMissingMultisigMirrors,
  deriveMirrorFromFrostVault,
  hasOrphanedMultisigs,
} from './migration';
import type { EncryptedVault } from './types';
import type { ZcashWalletJson } from '../wallets';
import type { AllSlices } from '..';
import { selectVisibleMultisigWallets, selectMultisigWallets } from '../wallets';

const frostVault = (over: Partial<EncryptedVault> = {}): EncryptedVault => ({
  id: 'vault-frost-1',
  type: 'frost-multisig',
  name: '2-of-3 multisig',
  createdAt: 1,
  encryptedData: '{}',
  salt: '',
  ...over,
  // insensitive is merged onto the defaults, so overrides add fields
  // (e.g. hidden, custody) without dropping the base multisig metadata.
  insensitive: {
    publicKeyPackage: 'pkp-hex',
    threshold: 2,
    maxSigners: 3,
    relayUrl: 'wss://zcash.rotko.net',
    address: 'u1frostaddr',
    supportedNetworks: ['zcash'],
    ...(over.insensitive ?? {}),
  },
});

const mirrorFor = (vaultId: string): ZcashWalletJson => ({
  id: `zcash-${vaultId}`,
  label: 'existing',
  orchardFvk: 'uview1existing',
  address: 'u1existing',
  accountIndex: 0,
  mainnet: true,
  vaultId,
  multisig: {
    publicKeyPackage: 'pkp-hex',
    threshold: 2,
    maxSigners: 3,
    relayUrl: 'wss://zcash.rotko.net',
  },
});

describe('deriveMirrorFromFrostVault', () => {
  test('reconstructs the display/routing fields from vault insensitive', () => {
    const m = deriveMirrorFromFrostVault(frostVault());
    expect(m.vaultId).toBe('vault-frost-1');
    expect(m.label).toBe('2-of-3 multisig');
    expect(m.address).toBe('u1frostaddr');
    expect(m.mainnet).toBe(true);
    expect(m.multisig?.threshold).toBe(2);
    expect(m.multisig?.maxSigners).toBe(3);
    expect(m.multisig?.publicKeyPackage).toBe('pkp-hex');
    expect(m.multisig?.relayUrl).toBe('wss://zcash.rotko.net');
    // self-custody secrets live in vault.encryptedData, not the mirror
    expect(m.multisig?.keyPackage).toBeUndefined();
    expect(m.multisig?.custody).toBeUndefined();
  });

  test('carries airgap custody + zignerWalletId when present', () => {
    const m = deriveMirrorFromFrostVault(
      frostVault({ insensitive: { custody: 'airgapSigner', zignerWalletId: 'w-42' } }),
    );
    expect(m.multisig?.custody).toBe('airgapSigner');
    expect(m.multisig?.zignerWalletId).toBe('w-42');
  });

  test('propagates hidden flag', () => {
    const m = deriveMirrorFromFrostVault(frostVault({ insensitive: { hidden: true } }));
    expect(m.multisig?.hidden).toBe(true);
  });

  test('orchardFvk falls back to empty string (not stored on vault)', () => {
    expect(deriveMirrorFromFrostVault(frostVault()).orchardFvk).toBe('');
  });
});

describe('backfillMissingMultisigMirrors', () => {
  test('rebuilds a mirror for a frost vault that has none', () => {
    const { zcashWallets, changed } = backfillMissingMultisigMirrors([frostVault()], []);
    expect(changed).toBe(true);
    expect(zcashWallets).toHaveLength(1);
    expect(zcashWallets[0]!.vaultId).toBe('vault-frost-1');
    expect(zcashWallets[0]!.multisig?.threshold).toBe(2);
  });

  test('is a no-op when every frost vault already has a mirror', () => {
    const existing = [mirrorFor('vault-frost-1')];
    const { zcashWallets, changed } = backfillMissingMultisigMirrors([frostVault()], existing);
    expect(changed).toBe(false);
    expect(zcashWallets).toBe(existing);
  });

  test('ignores non-frost vaults', () => {
    const mnemonic: EncryptedVault = {
      id: 'vault-mn',
      type: 'mnemonic',
      name: 'seed',
      createdAt: 1,
      encryptedData: 'x',
      salt: '',
      insensitive: {},
    };
    const { changed } = backfillMissingMultisigMirrors([mnemonic], []);
    expect(changed).toBe(false);
  });

  test('only backfills the vaults that are missing, preserving existing rows', () => {
    const vaults = [frostVault(), frostVault({ id: 'vault-frost-2', name: 'other' })];
    const existing = [mirrorFor('vault-frost-1')];
    const { zcashWallets, changed } = backfillMissingMultisigMirrors(vaults, existing);
    expect(changed).toBe(true);
    expect(zcashWallets).toHaveLength(2);
    // existing row untouched (kept its real orchardFvk)
    expect(zcashWallets.find(w => w.vaultId === 'vault-frost-1')!.orchardFvk).toBe(
      'uview1existing',
    );
    // missing one rebuilt
    expect(zcashWallets.find(w => w.vaultId === 'vault-frost-2')).toBeTruthy();
  });

  test('idempotent: re-running over the backfilled output changes nothing', () => {
    const first = backfillMissingMultisigMirrors([frostVault()], []);
    const second = backfillMissingMultisigMirrors([frostVault()], first.zcashWallets);
    expect(second.changed).toBe(false);
  });
});

describe('backfill + manager selectors', () => {
  const asState = (zcashWallets: ZcashWalletJson[]) =>
    ({ wallets: { zcashWallets } }) as unknown as AllSlices;

  test('a rebuilt visible mirror surfaces in the multisig manager list', () => {
    const { zcashWallets } = backfillMissingMultisigMirrors([frostVault()], []);
    expect(selectVisibleMultisigWallets(asState(zcashWallets))).toHaveLength(1);
  });

  test('a rebuilt hidden mirror (poker vault) stays out of the visible list but is still tracked', () => {
    const { zcashWallets } = backfillMissingMultisigMirrors(
      [frostVault({ id: 'vault-poker', insensitive: { hidden: true } })],
      [],
    );
    expect(selectVisibleMultisigWallets(asState(zcashWallets))).toHaveLength(0);
    expect(selectMultisigWallets(asState(zcashWallets))).toHaveLength(1);
  });

  test('forward backfill is distinct from the reverse orphan migration', () => {
    // reverse case: mirror exists but has no vaultId
    const orphan = { ...mirrorFor(''), vaultId: '' };
    expect(hasOrphanedMultisigs([orphan])).toBe(true);
    // forward backfill leaves it alone (it already has a multisig row)
    const { changed } = backfillMissingMultisigMirrors([], [orphan]);
    expect(changed).toBe(false);
  });
});
