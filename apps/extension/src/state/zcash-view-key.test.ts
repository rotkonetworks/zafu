import { describe, expect, test } from 'vitest';
import { encodeOrchardUfvk } from '@repo/wallet/networks/zcash/unified-address';
import { zcashViewKey } from './zcash-view-key';

const FVK = Uint8Array.from({ length: 96 }, (_, i) => i);
const base64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));

describe('zcashViewKey', () => {
  test('a unified key is used as stored', () => {
    expect(zcashViewKey({ ufvk: 'uview1abc', orchardFvk: '', mainnet: true })).toBe('uview1abc');
    expect(zcashViewKey({ orchardFvk: 'uviewtest1abc', mainnet: false })).toBe('uviewtest1abc');
  });

  test('a raw orchard key from an old zigner code reads as its orchard-only unified key', () => {
    expect(zcashViewKey({ orchardFvk: base64(FVK), mainnet: true })).toBe(
      encodeOrchardUfvk(FVK, true),
    );
    expect(zcashViewKey({ orchardFvk: base64(FVK), mainnet: false })).toMatch(/^uviewtest1/);
  });

  test('nothing readable is no key, never a guess', () => {
    expect(zcashViewKey(undefined)).toBeUndefined();
    expect(zcashViewKey({ orchardFvk: '', mainnet: true })).toBeUndefined();
    expect(zcashViewKey({ orchardFvk: base64(FVK.slice(0, 64)), mainnet: true })).toBeUndefined();
    expect(zcashViewKey({ orchardFvk: 'not base64 !', mainnet: true })).toBeUndefined();
  });
});
