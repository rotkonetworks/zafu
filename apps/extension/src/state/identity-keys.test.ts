import { beforeEach, describe, expect, it, vi } from 'vitest';
import { bytesToHex } from '@noble/hashes/utils';
import { sessionExtStorage } from '@repo/storage-chrome/session';
import { derivePassword, identityKey } from './identity';
import { getIdentityKey } from './identity-keys';

const MN =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

describe('getIdentityKey', () => {
  beforeEach(async () => {
    await sessionExtStorage.remove('identityKeys');
  });

  it('decrypts the phrase once per unlock, then reads the session slot', async () => {
    const getMnemonic = vi.fn(async () => MN);
    const first = await getIdentityKey('vault-1', getMnemonic);
    const second = await getIdentityKey('vault-1', getMnemonic);
    expect(getMnemonic).toHaveBeenCalledTimes(1);
    expect(bytesToHex(second)).toBe(bytesToHex(first));
    expect(bytesToHex(first)).toBe(bytesToHex(identityKey(MN)));
    // the slot holds the identity node, never the phrase
    expect(JSON.stringify(await sessionExtStorage.get('identityKeys'))).not.toContain('abandon');
  });

  it('hands out a copy, so zeroizing it leaves the slot intact', async () => {
    const getMnemonic = async () => MN;
    (await getIdentityKey('vault-2', getMnemonic)).fill(0);
    const again = await getIdentityKey('vault-2', getMnemonic);
    expect(derivePassword(again, 'github.com', 'alice', 32, 0, 2)).toBe(
      derivePassword(identityKey(MN), 'github.com', 'alice', 32, 0, 2),
    );
  });

  it('keeps each wallet apart', async () => {
    await getIdentityKey('vault-a', async () => MN);
    const other = await getIdentityKey(
      'vault-b',
      async () => 'legal winner thank year wave sausage worth useful legal winner thank yellow',
    );
    expect(bytesToHex(other)).not.toBe(bytesToHex(identityKey(MN)));
  });
});
