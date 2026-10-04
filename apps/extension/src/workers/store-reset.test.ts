import { describe, expect, it } from 'vitest';
import { storeFellBehind } from './store-reset';

describe('storeFellBehind', () => {
  it('a store that still holds what the run saved is the same store', () => {
    expect(storeFellBehind({ stored: 3_200_400, walletKnown: true, lastSaved: 3_200_400 })).toBe(
      false,
    );
  });

  it('a wiped store (no wallet, no height) is not scanned on from memory', () => {
    expect(storeFellBehind({ stored: 0, walletKnown: false, lastSaved: 3_200_400 })).toBe(true);
  });

  it('a store behind the last save, or without the wallet, is not the one being written', () => {
    expect(storeFellBehind({ stored: 3_180_000, walletKnown: true, lastSaved: 3_200_400 })).toBe(
      true,
    );
    expect(storeFellBehind({ stored: 3_200_400, walletKnown: false, lastSaved: 3_200_400 })).toBe(
      true,
    );
  });
});
