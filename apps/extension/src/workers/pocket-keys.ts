import { ripemd160 } from '@noble/hashes/ripemd160';
import { sha256 } from '@noble/hashes/sha256';
import { hexToBytes } from '@noble/hashes/utils';

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

/** true when `script` is the P2PKH lock (OP_DUP OP_HASH160 <20> OP_EQUALVERIFY OP_CHECKSIG) of this compressed pubkey */
export const isP2pkhOf = (script: Uint8Array, pubkeyHex: string): boolean => {
  const hash = ripemd160(sha256(hexToBytes(pubkeyHex)));
  const want = [0x76, 0xa9, 0x14, ...hash, 0x88, 0xac];
  return script.length === want.length && want.every((b, i) => script[i] === b);
};

/**
 * The t-branch index of a UTXO's address, where `tAddresses[i]` is index i.
 * An address missing from the reply falls back to index 0, as before; the
 * hot signer still refuses any input not locked to that index's key.
 */
export const tIndexOf =
  (tAddresses: string[]) =>
  ({ address }: { address: string }): number =>
    Math.max(0, tAddresses.indexOf(address));

/** UTXOs grouped by t-branch index, so each group signs with one key */
export const utxosByTIndex = <U extends { address: string }>(
  utxos: U[],
  tAddresses: string[],
): Map<number, U[]> => {
  const indexOf = tIndexOf(tAddresses);
  const groups = new Map<number, U[]>();
  for (const u of utxos) {
    const i = indexOf(u);
    groups.set(i, [...(groups.get(i) ?? []), u]);
  }
  return groups;
};
