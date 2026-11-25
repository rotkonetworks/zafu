/**
 * Which penumbra wallets already have a view database on this computer, for
 * one chain.
 *
 * `IndexedDb.initialize` names each wallet's database
 * `viewdata/<chainId>/<bech32mWalletId>`: a testnet's database says nothing
 * about what the wallet holds on mainnet.
 */

import { bech32mWalletId } from '@penumbra-zone/bech32m/penumbrawalletid';
import { WalletId } from '@penumbra-zone/protobuf/penumbra/core/keys/v1/keys_pb';
import { viewDbsOf } from './chain';

/** the ids among `walletIds` with a database among `dbNames` (pure, for tests) */
export const withStoredView = (
  walletIds: readonly string[],
  dbNames: readonly string[],
  chainId: string,
): Set<string> => {
  const views = viewDbsOf(dbNames, chainId);
  return new Set(
    walletIds.filter(id => {
      let bech32: string;
      try {
        bech32 = bech32mWalletId(WalletId.fromJsonString(id));
      } catch {
        // an id we cannot read: count it as stored, the safe side (see below)
        return true;
      }
      return views.some(n => n.endsWith(`/${bech32}`));
    }),
  );
};

/**
 * The wallets that must read on from what they hold. "Sync from now" skips
 * trial decryption below the tip, so applied to a wallet with a stored height
 * it would skip every block between that height and now, and lose whatever
 * arrived there without a word. When the databases can't be listed, every
 * wallet counts as stored: reading too much only costs time.
 */
export const walletsWithStoredView = async (
  walletIds: readonly string[],
  chainId: string,
): Promise<Set<string>> => {
  try {
    const names = (await indexedDB.databases()).map(d => d.name).filter((n): n is string => !!n);
    return withStoredView(walletIds, names, chainId);
  } catch {
    return new Set(walletIds);
  }
};
