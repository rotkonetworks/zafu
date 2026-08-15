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

import { memo, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { localExtStorage } from '@repo/storage-chrome/local';
import { Sensitive } from '../../../components/sensitive';
import { useAllCosmosBalances } from '../../../hooks/cosmos-balance';
import { COSMOS_CHAINS, type CosmosChainId } from '@repo/wallet/networks/cosmos/chains';
import { isActiveIbcChain } from '../../../config/networks';
import type { NetworkType } from '../../../state/keyring';
import { PopupPath } from '../paths';
import { cn } from '@repo/ui/lib/utils';

interface ChainRowProps {
  chainId: CosmosChainId;
  address: string;
  formatted: string;
  loading: boolean;
  onReceive: (chainId: CosmosChainId) => void;
  onSend: (chainId: CosmosChainId) => void;
  onShield: (chainId: CosmosChainId) => void;
}

const truncateAddress = (addr: string, head = 8, tail = 4) =>
  addr.length <= head + tail + 3 ? addr : `${addr.slice(0, head)}…${addr.slice(-tail)}`;

const ActionButton = ({
  icon,
  label,
  onClick,
  accent,
  title,
}: {
  icon: string;
  label: string;
  onClick: () => void;
  accent?: boolean;
  title: string;
}) => (
  <button
    type='button'
    onClick={onClick}
    title={title}
    className={cn(
      'flex flex-1 items-center justify-center gap-1 rounded-md px-2 py-1.5 text-xs font-medium transition-colors',
      accent
        ? 'bg-blue-500/15 text-blue-400 hover:bg-blue-500/25'
        : 'bg-elev-2 text-fg-muted hover:bg-elev-1 hover:text-fg-high',
    )}
  >
    <span className={cn(icon, 'h-3.5 w-3.5')} />
    {label}
  </button>
);

const ChainRow = memo(
  ({ chainId, address, formatted, loading, onReceive, onSend, onShield }: ChainRowProps) => {
    const config = COSMOS_CHAINS[chainId];
    return (
      <div className='flex flex-col gap-2 rounded-md border border-border/40 bg-card/40 px-3 py-2.5'>
        <div className='flex items-center gap-3'>
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
        </div>
        <div className='flex gap-2'>
          <ActionButton
            icon='i-lucide-arrow-down-to-line'
            label='receive'
            onClick={() => onReceive(chainId)}
            title='rotate to a fresh burner address to receive on'
          />
          <ActionButton
            icon='i-lucide-arrow-up'
            label='send'
            onClick={() => onSend(chainId)}
            title='send to an exchange or address'
          />
          <ActionButton
            icon='i-lucide-shield'
            label='shield'
            accent
            onClick={() => onShield(chainId)}
            title='shield into Penumbra'
          />
        </div>
      </div>
    );
  },
);
ChainRow.displayName = 'ChainRow';

/**
 * Sub-wallet section. Hidden when no balances and not loading, to avoid
 * showing an empty unshielded panel for users who only ever interact
 * with shielded assets.
 */
export const CosmosSubwallets = () => {
  const navigate = useNavigate();

  // Current receive-address index. Rotated so transparent addresses are never
  // reused - the whole point of the private off-ramp.
  const [addressIndex, setAddressIndex] = useState(0);
  useEffect(() => {
    void localExtStorage.get('cosmosAddressIndex').then(v => setAddressIndex(v ?? 0));
  }, []);
  const rotateAddress = () => {
    const next = addressIndex + 1;
    setAddressIndex(next);
    void localExtStorage.set('cosmosAddressIndex', next);
  };

  const { data, isLoading, isError } = useAllCosmosBalances(addressIndex);

  const goToSend = (chainId: CosmosChainId) => {
    // Route the send form to the cosmos chain WITHOUT switching networks - the
    // user stays on Penumbra; Noble is a burner doorway, not a network.
    navigate(PopupPath.SEND, { state: { cosmosChain: chainId } });
  };
  // Receive rotates to a fresh burner address; Send/Shield open the send flow
  // (Shield's destination is the user's Penumbra address = shield into the pool).
  const onSend = (chainId: CosmosChainId) => goToSend(chainId);
  const onShield = (chainId: CosmosChainId) => goToSend(chainId);

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
      <div className='kicker mb-2'>unshielded · burner</div>
      <div className='flex flex-col gap-1.5'>
        {entries.map(([chainId, e]) => (
          <ChainRow
            key={chainId}
            chainId={chainId}
            address={e?.address ?? ''}
            formatted={e?.formatted ?? ''}
            loading={isLoading || !e}
            onReceive={() => rotateAddress()}
            onSend={onSend}
            onShield={onShield}
          />
        ))}
      </div>
    </div>
  );
};
