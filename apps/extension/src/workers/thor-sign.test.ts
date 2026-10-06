import { describe, expect, it } from 'vitest';
import {
  deriveThorAddress,
  deriveThorKey,
  deriveThorKeyFromFvk,
  randomThorKeyHex,
  thorKeyFromHex,
} from '@repo/wallet/networks/thorchain/derive';
import { signedParts, verifyThorSignature } from '@repo/wallet/networks/thorchain/tx';
import { signThorDeposit, thorAddressFrom, type ThorDepositRequest } from './thor-sign';

const DOG = `${'dog '.repeat(23)}fossil`;
// the vector pinned in packages/wallet thorchain/derive.test.ts
const FVK = 'uview1zafuthorchainvectorfixedviewingkeystring0000';

const req = (r: Partial<ThorDepositRequest>): ThorDepositRequest => ({
  source: 'seed',
  index: 1,
  expected: '',
  rune: '100',
  memo: '-:ZEC.ZEC:10000',
  accountNumber: '7',
  sequence: '0',
  ...r,
});

describe('the worker signs for each rune key source', () => {
  it('seed, random and fvk each give their own address, and a signature that verifies', () => {
    const hex = randomThorKeyHex();
    const cases: [ThorDepositRequest['source'], string, Uint8Array][] = [
      ['seed', DOG, deriveThorKey(DOG, 1).publicKey],
      ['random', hex, thorKeyFromHex(hex).publicKey],
      ['fvk', FVK, deriveThorKeyFromFvk(FVK, 1).publicKey],
    ];
    const seen = new Set<string>();
    for (const [source, secret, pub] of cases) {
      const address = thorAddressFrom(source, secret, 1);
      seen.add(address);
      const b64 = signThorDeposit(
        secret,
        req({ source, expected: address, ...(source === 'fvk' ? { fvk: secret } : {}) }),
      );
      const { signBytes, signature } = signedParts(
        Uint8Array.from(atob(b64), c => c.charCodeAt(0)),
        7n,
      );
      expect(verifyThorSignature(pub, signBytes, signature)).toBe(true);
    }
    expect(seen.size).toBe(3);
    expect(thorAddressFrom('fvk', FVK, 1)).toBe('thor1kvnh2vqzpfwr2g3w0wtex5mtx52rfk2lq5fscq');
  });

  it('refuses to sign when the derived address is not the one read, or the source is unclear', () => {
    expect(() =>
      signThorDeposit(DOG, req({ source: 'seed', expected: deriveThorAddress(DOG, 2) })),
    ).toThrow(/not the one zafu read/);
    expect(() =>
      signThorDeposit(DOG, req({ source: 'nope' as never, expected: deriveThorAddress(DOG, 1) })),
    ).toThrow(/source/);
    // an fvk request must name its viewing key
    expect(() =>
      signThorDeposit(FVK, req({ source: 'fvk', expected: deriveThorAddress(DOG, 1) })),
    ).toThrow(/source/);
  });
});
