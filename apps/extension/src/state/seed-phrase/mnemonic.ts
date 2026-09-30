import { generateMnemonic, validateMnemonic, wordlists } from 'bip39';

const wordlist = wordlists['EN'] ?? [];

export enum SeedPhraseLength {
  TWELVE_WORDS = 12, // 128bits
  TWENTY_FOUR_WORDS = 24, // 256bits
}

export const generateSeedPhrase = (length: SeedPhraseLength): string[] => {
  const entropy = length === SeedPhraseLength.TWELVE_WORDS ? 128 : 256;
  return generateMnemonic(entropy).split(' ');
};

export const validateSeedPhrase = (seedPhrase: string[]): boolean => {
  return validateMnemonic(seedPhrase.join(' '));
};

export const isInWordList = (word: string): boolean => {
  return wordlist.includes(word);
};

/** plain levenshtein distance - small inputs only (bip39 words, <= ~10 chars). */
const editDistance = (a: string, b: string): number => {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const d: number[][] = Array.from({ length: rows }, (_, i) => [i, ...Array(cols - 1).fill(0)]);
  for (let j = 0; j < cols; j++) {
    d[0]![j] = j;
  }
  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      d[i]![j] =
        a[i - 1] === b[j - 1]
          ? d[i - 1]![j - 1]!
          : 1 + Math.min(d[i - 1]![j]!, d[i]![j - 1]!, d[i - 1]![j - 1]!);
    }
  }
  return d[rows - 1]![cols - 1]!;
};

/**
 * Nearest bip39 word for a typo'd entry ("harbour" -> "harbor"), for the
 * import paste screen's calm "did you mean" note. Returns null when the word
 * is already valid or nothing in the wordlist is close (distance > 2).
 */
export const suggestWord = (word: string): string | null => {
  if (!word || isInWordList(word)) {
    return null;
  }
  let best: string | null = null;
  let bestDist = 3; // > 2 means "not close enough to suggest"
  for (const candidate of wordlist) {
    if (Math.abs(candidate.length - word.length) >= bestDist) {
      continue;
    }
    const dist = editDistance(word, candidate);
    if (dist < bestDist) {
      bestDist = dist;
      best = candidate;
      if (dist === 1) {
        break;
      }
    }
  }
  return best;
};

export interface ValidationField {
  word: string;
  index: number;
}

export const generateValidationFields = (
  seedPhrase: string[],
  amount: number,
): { word: string; index: number }[] => {
  const allWords = seedPhrase.map((word, index) => ({ word, index }));
  const shuffleWords = allWords.sort(() => 0.5 - Math.random());
  const pickWords = shuffleWords.slice(0, amount);
  return pickWords.sort((a, b) => a.index - b.index);
};
