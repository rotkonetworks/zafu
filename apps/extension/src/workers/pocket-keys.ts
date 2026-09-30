import { secp256k1 } from '@noble/curves/secp256k1';
import { ripemd160 } from '@noble/hashes/ripemd160';
import { sha256 } from '@noble/hashes/sha256';

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

/** true when `script` is the P2PKH lock (OP_DUP OP_HASH160 <20> OP_EQUALVERIFY OP_CHECKSIG) of this key */
export const isP2pkhOf = (script: Uint8Array, privkeyHex: string): boolean => {
  const hash = ripemd160(sha256(secp256k1.getPublicKey(privkeyHex, true)));
  const want = [0x76, 0xa9, 0x14, ...hash, 0x88, 0xac];
  return script.length === want.length && want.every((b, i) => script[i] === b);
};
