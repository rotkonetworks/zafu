import { useStore } from '../state';
import { generateSelector } from '../state/seed-phrase/generate';
import { importSelector } from '../state/seed-phrase/import';
import { keyRingSelector } from '../state/keyring';

/**
 * creates a new wallet using the keyring system
 * stores mnemonic encrypted, networks are derived lazily
 */
export const useAddWallet = () => {
  const { phrase: generatedPhrase } = useStore(generateSelector);
  const { phrase: importedPhrase } = useStore(importSelector);
  const { setPassword, newMnemonicKey } = useStore(keyRingSelector);

  return async (plaintextPassword: string) => {
    // determine which route user came through
    const seedPhrase = generatedPhrase.length ? generatedPhrase : importedPhrase;
    const mnemonic = seedPhrase.join(' ');

    // set master password (creates encryption key)
    await setPassword(plaintextPassword);

    // store mnemonic in encrypted vault (network-agnostic)
    await newMnemonicKey(mnemonic, 'Wallet 1');
  };
};
