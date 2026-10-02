/**
 * Transparent chains from the penumbrafi registry. Each Penumbra IBC connection
 * there carries a `transparent` block (address prefix, coin type, fee token,
 * nodes from trusted operators) compiled from the cosmos chain-registry, with
 * corrections made in the registry's input. A chain Penumbra connects to is
 * therefore usable without a zafu release: publish the registry, and the
 * channel's liveness comes from the user's own Penumbra node at run time.
 */

import type { Chain } from '@penumbrafi/registry';
import type { CosmosChainConfig } from './chains';

const channelNumber = (id: string): number => Number(id.replace(/^channel-/, ''));

/** lower sorts first: active before anything else, then lowest active / newest other */
const rank = (c: Chain): [number, number] =>
  c.status === 'active' ? [0, channelNumber(c.channelId)] : [1, -channelNumber(c.channelId)];

const before = (a: Chain, b: Chain): boolean => {
  const [x, y] = [rank(a), rank(b)];
  return x[0] !== y[0] ? x[0] < y[0] : x[1] < y[1];
};

/**
 * One config per counterparty chain, keyed by its chain-registry name. When a
 * chain has several connections the active one supplies the channel pin
 * (the lowest-numbered if several are active), else the newest.
 */
export function chainsFromRegistry(
  connections: readonly Chain[],
): Record<string, CosmosChainConfig> {
  const best = new Map<string, Chain>();
  for (const c of connections) {
    const t = c.transparent;
    if (!t) {
      continue;
    }
    const prev = best.get(t.chainName);
    if (!prev || before(c, prev)) {
      best.set(t.chainName, c);
    }
  }

  const chains: Record<string, CosmosChainConfig> = {};
  for (const [id, c] of best) {
    const t = c.transparent!;
    chains[id] = {
      id,
      name: c.displayName.replace(/\s*\(legacy\)$/i, ''),
      chainId: c.chainId,
      bech32Prefix: t.bech32Prefix,
      symbol: t.symbol,
      denom: t.denom,
      decimals: t.decimals,
      rpcEndpoint: t.rpc[0]!,
      rpcEndpoints: t.rpc,
      restEndpoint: t.rest[0]!,
      gasPrice: t.gasPrice,
      penumbraChannel: c.counterpartyChannelId,
      penumbraSourceChannel: c.channelId,
      ...(t.coinType !== 118 ? { coinType: t.coinType } : {}),
    };
  }
  return chains;
}
