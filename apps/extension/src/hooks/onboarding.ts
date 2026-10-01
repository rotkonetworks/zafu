import { useStore } from '../state';
import { generateSelector } from '../state/seed-phrase/generate';
import { importSelector } from '../state/seed-phrase/import';
import { keyRingSelector } from '../state/keyring';
import { SEED_PHRASE_ORIGIN } from '../routes/page/onboarding/password/types';

/**
 * creates a new wallet using the keyring system
 * stores mnemonic encrypted, networks are derived lazily
 */
export const useAddWallet = () => {
  const { phrase: generatedPhrase } = useStore(generateSelector);
  const { phrase: importedPhrase } = useStore(importSelector);
  const { setPassword, newMnemonicKey } = useStore(keyRingSelector);

  return async (plaintextPassword: string, origin: SEED_PHRASE_ORIGIN) => {
    // by origin, never by which phrase is non-empty: a create abandoned for an
    // import leaves its generated phrase behind, and must not become the wallet.
    const seedPhrase =
      origin === SEED_PHRASE_ORIGIN.NEWLY_GENERATED ? generatedPhrase : importedPhrase;
    const mnemonic = seedPhrase.join(' ');

    // set master password (creates encryption key)
    await setPassword(plaintextPassword);

    // store mnemonic in encrypted vault (network-agnostic)
    await newMnemonicKey(mnemonic, 'Wallet 1', origin === SEED_PHRASE_ORIGIN.NEWLY_GENERATED);
  };
};
