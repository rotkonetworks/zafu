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
import { useNavigate } from 'react-router-dom';
import { Sensitive } from '../../../components/sensitive';
import { useAllCosmosBalances } from '../../../hooks/cosmos-balance';
import { COSMOS_CHAINS, type CosmosChainId } from '@repo/wallet/networks/cosmos/chains';
import { isActiveIbcChain } from '../../../config/networks';
import { useStore } from '../../../state';
import { selectSetActiveNetwork } from '../../../state/keyring';
import type { NetworkType } from '../../../state/keyring';
import { PopupPath } from '../paths';
import { cn } from '@repo/ui/lib/utils';

interface ChainRowProps {
  chainId: CosmosChainId;
  address: string;
  formatted: string;
  loading: boolean;
  onShield: (chainId: CosmosChainId) => void;
}

const truncateAddress = (addr: string, head = 8, tail = 4) =>
  addr.length <= head + tail + 3 ? addr : `${addr.slice(0, head)}…${addr.slice(-tail)}`;

const ChainRow = memo(({ chainId, address, formatted, loading, onShield }: ChainRowProps) => {
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
          <Sensitive className='font-mono text-sm tabular-nums'>
            {loading ? <span className='text-fg-muted'>-</span> : formatted}
          </Sensitive>
        </div>
        <div className='font-mono text-label text-fg-muted' title={address}>
          {truncateAddress(address)}
        </div>
      </div>
      <button
        type='button'
        onClick={() => onShield(chainId)}
        className='flex shrink-0 items-center gap-1 rounded-md bg-blue-500/15 px-2.5 py-1.5 text-xs font-medium text-blue-400 transition-colors hover:bg-blue-500/25'
        title='shield into Penumbra'
      >
        <span className='i-lucide-shield h-3.5 w-3.5' />
        shield
      </button>
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
  const navigate = useNavigate();
  const setActiveNetwork = useStore(selectSetActiveNetwork);

  // Shield: switch to the cosmos chain and open its send flow (destination is
  // the user's Penumbra address = a deposit/shield into the shielded pool).
  const onShield = (chainId: CosmosChainId) => {
    void setActiveNetwork(chainId as NetworkType);
    navigate(PopupPath.SEND);
  };

  if (isError) {
    return null;
  }

  // Compute which chains to render. While loading we render all chains
  // with a dash placeholder so the section doesn't flicker in.
  const entries = (
    data
      ? (Object.entries(data) as [CosmosChainId, NonNullable<typeof data>[CosmosChainId]][])
      : (Object.keys(COSMOS_CHAINS) as CosmosChainId[]).map(id => [id, undefined] as const)
    // only chains with a live IBC channel (Noble) - hide the rest until their
    // channels reopen, so we don't surface an un-shieldable Cosmos Hub row
  ).filter(([chainId]) => isActiveIbcChain(chainId as NetworkType));

  // Hide the section once data arrives if every balance is zero — we
  // don't want an empty "unshielded" header on Penumbra for users with
  // no Cosmos holdings.
  if (data) {
    const anyNonZero = entries.some(([, e]) => e && e.balance > 0n);
    if (!anyNonZero) {
      return null;
    }
  }

  return (
    <div className='mt-4'>
      <div className='kicker mb-2'>unshielded</div>
      <div className='flex flex-col gap-1.5'>
        {entries.map(([chainId, e]) => (
          <ChainRow
            key={chainId}
            chainId={chainId}
            address={e?.address ?? ''}
            formatted={e?.formatted ?? ''}
            loading={isLoading || !e}
            onShield={onShield}
          />
        ))}
      </div>
    </div>
  );
};
