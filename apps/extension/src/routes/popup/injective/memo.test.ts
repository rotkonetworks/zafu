import { describe, expect, it } from 'vitest';
import { looksLikeRecoveryPhrase } from './memo';

describe('looksLikeRecoveryPhrase', () => {
  it('catches a pasted recovery phrase', () => {
    expect(
      looksLikeRecoveryPhrase(
        'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
      ),
    ).toBe(true);
  });
  it('lets exchange memos through', () => {
    expect(looksLikeRecoveryPhrase('104829331')).toBe(false);
    expect(looksLikeRecoveryPhrase('')).toBe(false);
    expect(looksLikeRecoveryPhrase('deposit for my kraken account please thanks')).toBe(false);
  });
});
