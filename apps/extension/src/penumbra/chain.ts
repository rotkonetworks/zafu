/**
 * Which penumbra chain zafu reads: mainnet, or a testnet the person points it
 * at. As with zcash, the testnet is a network entry of its own
 * (config/networks `penumbra-testnet`): while it is on, penumbra speaks it and
 * mainnet waits untouched. What a chain keeps stays apart: its view database
 * is named by its chain id (`viewdata/<chainId>/<wallet>`), and its app
 * parameters, the one per-chain value in plain storage, have a key per entry.
 */

import { storedList } from '@repo/storage-chrome/stored-list';
import type { ResolvedStart } from './start';

export const PENUMBRA_MAINNET = 'penumbra-1';

export type PenumbraNetwork = 'penumbra' | 'penumbra-testnet';

interface PenumbraChain {
  /** where its app parameters, and so its chain id, are kept */
  params: 'params' | 'penumbraTestnetParams';
  /** the chain id before any node has said one */
  fallback?: string;
  /**
   * asked of the node on every start, never read from storage first: a stored
   * id is only checked after sync begins, too late to keep a node serving
   * another chain out of this entry's database
   */
  askFirst: boolean;
  /** why a node's chain can't be read into this entry, or undefined when it can */
  refuse: (chainId: string) => string | undefined;
  /** every wallet's start, when not its own (penumbraStarts): a devnet is small enough to read whole */
  start?: ResolvedStart;
}

export const PENUMBRA_CHAINS: Record<PenumbraNetwork, PenumbraChain> = {
  penumbra: {
    params: 'params',
    fallback: PENUMBRA_MAINNET,
    askFirst: false,
    refuse: () => undefined,
  },
  'penumbra-testnet': {
    params: 'penumbraTestnetParams',
    askFirst: true,
    start: { creation: 0 },
    refuse: id =>
      !id
        ? 'that node did not say its chain'
        : id === PENUMBRA_MAINNET
          ? 'that node serves penumbra mainnet · please pick a testnet node'
          : undefined,
  },
};

/** the penumbra entry in use: its testnet while that is on */
export const penumbraNetworkOf = (enabledNetworks: unknown): PenumbraNetwork =>
  storedList<string>(enabledNetworks).includes('penumbra-testnet')
    ? 'penumbra-testnet'
    : 'penumbra';

/** the view databases of exactly one chain; `viewdata/penumbra-1` alone would also match a testnet's */
export const viewDbsOf = (names: readonly string[], chainId: string): string[] =>
  names.filter(n => n.startsWith(`viewdata/${chainId}/`));

/** the line an approval shows for a chain that is not mainnet */
export const testnetLine = (chainId: string | undefined): string | undefined =>
  !chainId || chainId === PENUMBRA_MAINNET
    ? undefined
    : `penumbra testnet · ${chainId} · coins have no value`;
