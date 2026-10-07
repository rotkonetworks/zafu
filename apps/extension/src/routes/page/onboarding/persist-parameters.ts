import { localExtStorage } from '@repo/storage-chrome/local';
import { SEED_PHRASE_ORIGIN } from './password/types';

// Onboarding contacts nothing: a penumbra wallet resolves its node from the
// shipped default (resolvePenumbraEndpoint) and its numeraires from the
// bundled registry (wallet-services numerairesFor). The old registry fetch
// here hit raw.githubusercontent.com, which the egress policy refuses, and
// failed every onboarding that had penumbra on.
export const setOnboardingValuesInStorage = async (seedPhraseOrigin: SEED_PHRASE_ORIGIN) => {
  if (seedPhraseOrigin === SEED_PHRASE_ORIGIN.IMPORTED) {
    // Importing means the user typed the phrase from an existing backup -
    // they demonstrably possess it. Suppress the home backup nudge.
    await localExtStorage.set('seedPhraseBackedUp', true);
  }
};
