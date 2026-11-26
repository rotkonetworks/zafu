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
import { isLocalDeviceHost } from '../net/destination';

export const PENUMBRA_MAINNET = 'penumbra-1';

export type PenumbraNetwork = 'penumbra' | 'penumbra-testnet';

interface PenumbraChain {
  /** where its app parameters, and so its chain id, are kept */
  params: 'params' | 'penumbraTestnetParams';
  /** the chain id before any node has said one */
  fallback?: string;
  /**
   * the node is anyone's: asked on every start, never read from storage
   * first (a stored id is only checked after sync begins, too late to keep a
   * node serving another chain out of this entry's database), and watched
   * while it is read (penumbra/chain-check `watch`)
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

/** the penumbra chain in use: the entry, and the id its node said (none yet on a fresh testnet) */
export interface ChainInUse {
  network: PenumbraNetwork;
  chainId?: string;
}

/** the line an approval shows while a testnet is in use; none on mainnet */
export const chainLine = ({ network, chainId }: ChainInUse): string | undefined =>
  network === 'penumbra'
    ? undefined
    : chainId
      ? `penumbra testnet · ${chainId} · coins have no value`
      : 'penumbra testnet · no node yet';

/** why a plan can't be signed on the chain in use: it must name exactly that chain */
export const planChainProblem = (
  planChainId: string | undefined,
  active: ChainInUse,
): string | undefined =>
  !active.chainId
    ? 'penumbra testnet has no node yet'
    : !planChainId
      ? 'this transaction names no chain'
      : planChainId !== active.chainId
        ? `this transaction names ${planChainId} · zafu is on ${active.chainId}`
        : undefined;

/** why a testnet node's address can't be used: only one on this computer may skip https */
export const testnetNodeProblem = (url: string): string | undefined => {
  let u: URL;
  try {
    u = new URL(url.trim());
  } catch {
    return 'that is not a node address';
  }
  return u.protocol === 'https:' || (u.protocol === 'http:' && isLocalDeviceHost(u.host))
    ? undefined
    : 'a node away from this computer needs https';
};
