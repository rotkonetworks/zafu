/**
 * Whether a tx on a transparent chain can have its gas paid by the chain's
 * sponsor (x/feegrant, apps/feegrant): the address holds a supported
 * stablecoin but not enough of the gas asset. The sponsor is contacted only
 * then - no request, and no IP to the sponsor, otherwise.
 */

import { useQuery } from '@tanstack/react-query';
import { COSMOS_CHAINS, type CosmosChainId } from '@repo/wallet/networks/cosmos/chains';
import { conduitFor, type TxKind } from '@repo/wallet/networks/transparent/conduit';
import { holdsSponsorStable } from '@repo/wallet/networks/injective/feegrant';

export interface GasState {
  /** fee for one tx, in the gas asset's base units */
  fee: bigint;
  /** gas limit the tx is signed with */
  gasLimit: string;
  gasAsset: { symbol: string; denom: string; decimals: number };
  /** the address can pay the fee itself (true while balances are unknown) */
  gasOk: boolean;
  /** the sponsor will pay it */
  sponsored: boolean;
}

export function useGasSponsor(
  chainId: CosmosChainId,
  kind: TxKind,
  balances: readonly { denom: string; amount: bigint }[] | undefined,
): GasState {
  const cfg = COSMOS_CHAINS[chainId];
  const gasAsset = cfg.gasAsset ?? { symbol: cfg.symbol, denom: cfg.denom, decimals: cfg.decimals };
  const { amount: fee, gas: gasLimit } = conduitFor(chainId).feeFor(kind);
  const gasBal =
    balances?.find(b => b.denom.toLowerCase() === gasAsset.denom.toLowerCase())?.amount ?? 0n;
  // don't block on balances that haven't loaded
  const gasOk = !balances || gasBal >= fee;
  const wants = !!cfg.gasSponsorUrl && !!balances && !gasOk && holdsSponsorStable(balances);

  const granter = useQuery({
    queryKey: ['gas-sponsor', chainId],
    enabled: wants,
    staleTime: 5 * 60_000,
    retry: false,
    queryFn: async () => {
      const res = await fetch(`${cfg.gasSponsorUrl}/v1/injective/granter`);
      if (!res.ok) {
        throw new Error(`gas sponsor unavailable (${res.status})`);
      }
      return (await res.json()) as { granter?: string };
    },
  });

  return { fee, gasLimit, gasAsset, gasOk, sponsored: wants && !!granter.data?.granter };
}
