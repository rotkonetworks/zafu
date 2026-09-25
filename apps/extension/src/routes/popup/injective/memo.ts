import { wordlists } from 'bip39';

/**
 * A memo that looks like a recovery phrase: refuse it, as Keplr does
 * (packages/hooks/src/tx/memo.ts) - 8 to 32 words, at least 3/4 of them BIP39
 * words. A memo is public forever and people paste the wrong thing.
 */
const BIP39_WORDS = new Set(wordlists['english']);
export const looksLikeRecoveryPhrase = (memo: string): boolean => {
  const words = memo.trim().split(/\s+/).filter(Boolean);
  if (words.length < 8 || words.length > 32) {
    return false;
  }
  const hits = words.filter(w => BIP39_WORDS.has(w.toLowerCase())).length;
  return hits >= (words.length / 4) * 3;
};
