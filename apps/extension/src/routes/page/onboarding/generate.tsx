import { SeedPhraseLength } from '../../../state/seed-phrase/mnemonic';
import { useEffect } from 'react';
import { useStore } from '../../../state';
import { generateSelector } from '../../../state/seed-phrase/generate';
import { usePageNav } from '../../../utils/navigate';
import { SEED_PHRASE_ORIGIN } from './password/types';
import { navigateToNetworkSelection } from './password/utils';

export const GenerateSeedPhrase = () => {
  const navigate = usePageNav();
  const { phrase, generateRandomSeedPhrase } = useStore(generateSelector);

  // On render, asynchronously generate a new seed phrase
  // Use 24 words for better entropy and zcash compatibility
  useEffect(() => {
    if (!phrase.length) {
      generateRandomSeedPhrase(SeedPhraseLength.TWENTY_FOUR_WORDS);
    }
  }, [generateRandomSeedPhrase, phrase.length]);

  useEffect(() => {
    if (phrase.length === Number(SeedPhraseLength.TWENTY_FOUR_WORDS)) {
      navigateToNetworkSelection(navigate, SEED_PHRASE_ORIGIN.NEWLY_GENERATED);
    }
  }, [phrase.length, navigate]);

  return null;
};
