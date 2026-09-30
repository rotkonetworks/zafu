/**
 * Hot (seed) scanning keys for one ZIP 32 account, i.e. one pocket.
 *
 * Account 0 is the historic constructor, byte for byte. Any other account
 * needs the per-account export and fails loudly without it, never silently
 * falling back to account 0 (that would show one pocket's notes as another's).
 */

export interface PocketKeysCtor<K> {
  new (seed: string): K;
  /** absent from wasm blobs that predate pockets */
  from_seed_phrase_account?: (seed: string, account: number) => K;
}

export const pocketWalletKeys = <K>(
  ctor: PocketKeysCtor<K>,
  mnemonic: string,
  account: number,
): K => {
  if (account === 0) {
    return new ctor(mnemonic);
  }
  const derive = ctor.from_seed_phrase_account;
  if (!derive) {
    throw new Error(`pocket ${account} needs a newer zafu-wasm (from_seed_phrase_account)`);
  }
  return derive(mnemonic, account);
};
