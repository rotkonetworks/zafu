import { describe, expect, it, vi } from 'vitest';

// zafu-deps pulls in the worker bridge; only the pure KeyInfo reader is under test.
vi.mock('../../state/keyring/network-worker', () => ({}));
vi.mock('../../tx-ops', () => ({ writeTxOp: vi.fn() }));

import { buildLedgerVault } from '../../state/keyring/vault-ops';
import { toLedgerZcashImport } from './import-account';
import { ledgerAccountFromKeyInfo } from './zafu-deps';

/**
 * The import writes the account fingerprint; the signer reads it back to stamp
 * PCZT derivations. They were built on separate branches - this pins the
 * hand-off: same key (`insensitive.seedFingerprint`), same format (64-char
 * hex), same bytes.
 */
describe('ledger seed fingerprint hand-off', () => {
  const fp = Uint8Array.from({ length: 32 }, (_, i) => i * 7);
  const fpHex = Array.from(fp, b => b.toString(16).padStart(2, '0')).join('');

  it('the signer reads exactly what the import stored', () => {
    const data = toLedgerZcashImport(
      {
        ufvk: 'uview1test',
        seedFingerprintHex: fpHex,
        accountIndex: 2,
        appVersion: '3.9.4',
        deviceLabel: 'Nano S Plus',
      },
      { address: 'u1test', mainnet: true },
    );
    const vault = buildLedgerVault('v1', 'ledger', 'sealed', data);

    expect(vault.insensitive['seedFingerprint']).toBe(fpHex);
    expect(vault.insensitive['seedFingerprint']).toMatch(/^[0-9a-f]{64}$/);

    const account = ledgerAccountFromKeyInfo(vault.insensitive, 2);
    expect(Array.from(account.seedFingerprint)).toEqual(Array.from(fp));
    expect(account.accountIndex).toBe(2);
  });

  it('fails closed for an account imported without a fingerprint', () => {
    expect(() => ledgerAccountFromKeyInfo({ coldSignerType: 'ledger' }, 0)).toThrow(
      /no seed fingerprint/,
    );
  });
});
