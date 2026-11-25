import { describe, expect, it } from 'vitest';
import type { KeyInfo } from '../../../state/keyring';
import { penumbraKeyGap } from './no-penumbra-key';

const key = (id: string, type: string, insensitive: Record<string, unknown> = {}) =>
  ({ id, type, name: id, insensitive }) as unknown as KeyInfo;

describe('penumbraKeyGap', () => {
  it('offers the zigner scan to a zigner wallet with no penumbra record of its own', () => {
    const zigner = key('v1', 'zigner-zafu', { coldSignerType: 'zigner', zid: 'z' });
    expect(penumbraKeyGap(zigner, [{ vaultId: 'v2' }])).toBe('scan zigner');
    expect(penumbraKeyGap(zigner, [])).toBe('scan zigner');
  });

  it('is no gap once the wallet has its record, or for a seed phrase', () => {
    expect(penumbraKeyGap(key('v1', 'zigner-zafu'), [{ vaultId: 'v1' }])).toBeUndefined();
    expect(penumbraKeyGap(key('v1', 'mnemonic'), [])).toBeUndefined();
  });

  it('trusts a record from before records named their wallet', () => {
    expect(penumbraKeyGap(key('v1', 'zigner-zafu'), [{}])).toBeUndefined();
  });

  it('sends a signer that never holds a penumbra key to another wallet', () => {
    for (const s of ['keystone', 'ledger', 'viewing-key']) {
      expect(penumbraKeyGap(key('v1', 'zigner-zafu', { coldSignerType: s }), [])).toBe(
        'no penumbra',
      );
    }
  });
});
