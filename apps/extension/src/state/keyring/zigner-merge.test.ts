import { describe, expect, it } from 'vitest';
import { mergeTargetFor } from './zigner-merge';
import type { EncryptedVault } from './types';

const vault = (id: string, zid?: string, accountIndex = 0) =>
  ({
    id,
    type: 'zigner-zafu',
    name: id,
    createdAt: 0,
    encryptedData: '',
    salt: '',
    insensitive: { accountIndex, ...(zid ? { zid } : {}) },
  }) as EncryptedVault;

describe('mergeTargetFor: a code joins a wallet only by proof of the same seed', () => {
  const vaults = [vault('v1', 'zid-a'), vault('v2')];

  it('joins the wallet with the same ZID and account', () => {
    expect(
      mergeTargetFor(vaults, [], { zidPublicKey: 'zid-a', accountIndex: 0 } as never)?.id,
    ).toBe('v1');
  });

  it("never joins another zigner's wallet, or one with no ZID", () => {
    expect(mergeTargetFor(vaults, [], { zidPublicKey: 'zid-b', accountIndex: 0 } as never)).toBe(
      undefined,
    );
    expect(mergeTargetFor(vaults, [], { accountIndex: 0 } as never)).toBe(undefined);
  });

  it('keeps another account of the same zigner apart', () => {
    expect(mergeTargetFor(vaults, [], { zidPublicKey: 'zid-a', accountIndex: 1 } as never)).toBe(
      undefined,
    );
  });
});
