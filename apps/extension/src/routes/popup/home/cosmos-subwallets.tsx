/**
 * Unshielded Cosmos balances rendered as sub-wallets under the active
 * Penumbra wallet.
 *
 * The user's Penumbra spend key is derived from the same mnemonic that
 * derives Cosmos addresses (or, for zigner-zafu wallets, addresses are
 * stored in the keyInfo's insensitive blob), so the Penumbra wallet IS
 * the Cosmos wallet — the rows below are the same identity, just on
 * a transparent chain. Clicking a row will eventually open the shield
 * flow with the asset pre-filled; v1 just surfaces the balances.
 */

import { memo } from 'react';
import { useAllCosmosBalances } from '../../../hooks/cosmos-balance';
import { COSMOS_CHAINS, type CosmosChainId } from '@repo/wallet/networks/cosmos/chains';
import { cn } from '@repo/ui/lib/utils';

interface ChainRowProps {
  chainId: CosmosChainId;
  address: string;
  formatted: string;
  loading: boolean;
}

const truncateAddress = (addr: string, head = 8, tail = 4) =>
  addr.length <= head + tail + 3 ? addr : `${addr.slice(0, head)}…${addr.slice(-tail)}`;

const ChainRow = memo(({ chainId, address, formatted, loading }: ChainRowProps) => {
  const config = COSMOS_CHAINS[chainId];
  return (
    <div
      className={cn(
        'flex items-center gap-3 rounded-md border border-border/40 bg-card/40 px-3 py-2',
        'transition-colors hover:bg-card/60',
      )}
    >
      <div className='flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium uppercase'>
        {config.symbol.slice(0, 2)}
      </div>
      <div className='flex flex-1 flex-col min-w-0'>
        <div className='flex items-center justify-between gap-2'>
          <span className='text-sm font-medium'>{config.name}</span>
          <span className='font-mono text-sm tabular-nums'>
            {loading ? <span className='text-muted-foreground'>—</span> : formatted}
          </span>
        </div>
        <div className='font-mono text-[10px] text-muted-foreground' title={address}>
          {truncateAddress(address)}
        </div>
      </div>
    </div>
  );
});
ChainRow.displayName = 'ChainRow';

/**
 * Sub-wallet section. Hidden when no balances and not loading, to avoid
 * showing an empty unshielded panel for users who only ever interact
 * with shielded assets.
 */
export const CosmosSubwallets = () => {
  const { data, isLoading, isError } = useAllCosmosBalances();

  if (isError) {
    return null;
  }

  // Compute which chains to render. While loading we render all chains
  // with a dash placeholder so the section doesn't flicker in.
  const entries = data
    ? Object.entries(data) as [CosmosChainId, NonNullable<typeof data>[CosmosChainId]][]
    : (Object.keys(COSMOS_CHAINS) as CosmosChainId[]).map(id => [id, undefined] as const);

  // Hide the section once data arrives if every balance is zero — we
  // don't want an empty "unshielded" header on Penumbra for users with
  // no Cosmos holdings.
  if (data) {
    const anyNonZero = entries.some(([, e]) => e && e.balance > 0n);
    if (!anyNonZero) return null;
  }

  return (
    <div className='mt-4'>
      <div className='kicker mb-2 flex items-center justify-between'>
        <span>unshielded</span>
        <span className='text-[10px] font-normal text-muted-foreground normal-case'>
          shieldable to Penumbra
        </span>
      </div>
      <div className='flex flex-col gap-1.5'>
        {entries.map(([chainId, e]) => (
          <ChainRow
            key={chainId}
            chainId={chainId}
            address={e?.address ?? ''}
            formatted={e?.formatted ?? ''}
            loading={isLoading || !e}
          />
        ))}
      </div>
    </div>
  );
};
