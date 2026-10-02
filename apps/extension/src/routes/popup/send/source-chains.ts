/**
 * The "send from" sheet of transparent chains: every chain Penumbra has a live
 * route to, plus any chain still holding your funds after its channel closed
 * (so they stay reachable for a send within that chain). Chains holding funds
 * come first, a deprecated chain sinks to the bottom.
 */

import { COSMOS_CHAINS, type CosmosChainId } from '@repo/wallet/networks/cosmos/chains';
import type { Pick } from './send-fields';

/** what a chain's deposit addresses held at the last check */
export interface ChainHeld {
  /** formatted amounts, e.g. "22.282909 osmo" */
  amounts: string[];
}

export const sourceChainPicks = (
  candidates: readonly CosmosChainId[],
  offered: ReadonlySet<CosmosChainId>,
  /** chains this session has checked (a flow turned them on) */
  checked: ReadonlySet<CosmosChainId>,
  held: ReadonlyMap<CosmosChainId, ChainHeld>,
): Pick<CosmosChainId>[] => {
  const rows = candidates
    .filter(c => offered.has(c) || held.has(c))
    .map(c => {
      const cfg = COSMOS_CHAINS[c];
      const amounts = held.get(c)?.amounts ?? [];
      const description = !offered.has(c)
        ? 'channel closed'
        : cfg.deprecation
          ? `closing · move out by ${cfg.deprecation.moveOutBy}`
          : cfg.symbol.toLowerCase();
      const value = amounts.length
        ? `${amounts[0]}${amounts.length > 1 ? ` +${amounts.length - 1}` : ''}`
        : checked.has(c)
          ? 'empty'
          : 'not checked';
      return {
        pick: { key: c, label: cfg.name.toLowerCase(), description, value },
        rank: (cfg.deprecation ? 2 : 0) + (amounts.length ? 0 : 1),
      };
    });
  return rows.sort((a, b) => a.rank - b.rank).map(r => r.pick);
};
