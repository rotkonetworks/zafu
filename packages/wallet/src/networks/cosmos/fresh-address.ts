/**
 * Fresh burner-address derivation for cosmos-family chains.
 *
 * Pairs with `@repo/storage-chrome/cosmos-chain-counters`'s `nextHdIndex` to
 * back the wallet's `zafu_get_fresh_chain_address` provider method. The two
 * pieces intentionally live in separate packages: the counter is persistence,
 * this file is derivation, and only the extension service worker composes them
 * (so a build like `@repo/wallet`'s unit tests never has to stub chrome
 * storage to exercise a derivation).
 *
 * Rotation rationale: on the unshield side of a shielded pool (Penumbra),
 * sending every exit to the same destination inj1… defeats receiver
 * unlinkability - an observer can group every unshield to the same account.
 * Deriving at a fresh HD index per exit closes that hole. Deposits stay on a
 * stable address for CEX compliance and are unaffected.
 *
 * FUND SAFETY: Ethermint chains (Injective, keyAlgo `eth_secp256k1`) MUST go
 * through `deriveInjectiveWallet` (coin type 60, keccak address). Every other
 * currently-registered `CosmosChainId` is coin-type 118, and derives via the
 * standard `Secp256k1HdWallet` path. `deriveFreshChainAddress` picks the
 * correct branch off `COSMOS_CHAINS[chainId].keyAlgo`.
 */

import { deriveCosmosWallet } from './signer';
import { COSMOS_CHAINS, type CosmosChainId } from './chains';
import { deriveInjectiveWallet } from '../injective/derive';

export interface FreshChainAddress {
  /** the bech32 address at the freshly-allocated HD index */
  address: string;
  /** the HD index the address was derived at */
  hdIndex: number;
  /** the chain the address is on */
  chainId: CosmosChainId;
}

/**
 * Derive a cosmos-family address at a specific HD index (no counter mutation).
 *
 * The counter is threaded in by the caller so this stays a pure function of
 * (mnemonic, chain, index) - the extension service worker calls
 * `nextHdIndex(chainId)` first, then hands the allocated integer to this
 * helper. Tests exercise both directions independently.
 */
export const deriveFreshChainAddress = async (
  chainId: CosmosChainId,
  mnemonic: string,
  hdIndex: number,
): Promise<FreshChainAddress> => {
  const config = COSMOS_CHAINS[chainId];
  if (!config) {
    throw new Error(`unknown cosmos chain '${chainId}'`);
  }

  // Ethermint branch (coin type 60, eth_secp256k1, keccak address).
  if (config.keyAlgo === 'eth_secp256k1') {
    const wallet = await deriveInjectiveWallet(mnemonic, hdIndex);
    // The private key is not returned - zero it before we drop the reference.
    wallet.privateKey.fill(0);
    return { address: wallet.address, hdIndex, chainId };
  }

  // Standard cosmos branch (coin type 118, secp256k1, ripemd160 address).
  const wallet = await deriveCosmosWallet(mnemonic, hdIndex, config.bech32Prefix);
  return { address: wallet.address, hdIndex, chainId };
};
