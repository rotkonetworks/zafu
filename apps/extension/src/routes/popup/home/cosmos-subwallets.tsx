/**
 * The transparent off-ramp, surfaced under Penumbra. Noble is not a network -
 * it's a set of single-use BURNER deposit addresses. This is the "full view of
 * all deposit wallets": every funded burner (each independently shieldable) plus
 * one fresh, unused address to receive on.
 *
 * The state is derived from on-chain balances (see useCosmosDepositWallets), not
 * a stored counter - so a fresh address appears only after the current one is
 * funded, and money can never be stranded behind a rotated index.
 */

import { memo } from 'react';
import { useNavigate } from 'react-router-dom';
import { Sensitive } from '../../../components/sensitive';
import { useCosmosDepositWallets, type DepositWallet } from '../../../hooks/cosmos-balance';
import { COSMOS_CHAINS, type CosmosChainId } from '@repo/wallet/networks/cosmos/chains';
import { getActiveIbcSubnetworks } from '../../../config/networks';
import { useStore } from '../../../state';
import { selectEffectiveKeyInfo } from '../../../state/keyring';
import { PopupPath } from '../paths';

const truncate = (addr: string, head = 10, tail = 6) =>
  addr.length <= head + tail + 3 ? addr : `${addr.slice(0, head)}…${addr.slice(-tail)}`;

const DepositRow = memo(
  ({
    chainId,
    wallet,
    onShield,
  }: {
    chainId: CosmosChainId;
    wallet: DepositWallet;
    onShield: () => void;
  }) => {
    const config = COSMOS_CHAINS[chainId];
    return (
      <div className='flex items-center gap-3 rounded-md border border-border/40 bg-card/40 px-3 py-2'>
        <div className='flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium uppercase'>
          {config.symbol.slice(0, 2)}
        </div>
        <div className='flex flex-1 flex-col min-w-0'>
          <Sensitive className='font-mono text-sm tabular-nums'>{wallet.formatted}</Sensitive>
          <div className='font-mono text-label text-fg-muted' title={wallet.address}>
            {truncate(wallet.address)}
          </div>
        </div>
        <button
          type='button'
          onClick={onShield}
          className='flex shrink-0 items-center gap-1 rounded-md bg-blue-500/15 px-2.5 py-1.5 text-xs font-medium text-blue-400 transition-colors hover:bg-blue-500/25'
          title='shield into Penumbra'
        >
          <span className='i-lucide-shield h-3.5 w-3.5' />
          shield
        </button>
      </div>
    );
  },
);
DepositRow.displayName = 'DepositRow';

/** deposit wallets + a fresh receive address for one transparent IBC chain */
const ChainDeposits = ({ chainId }: { chainId: CosmosChainId }) => {
  const navigate = useNavigate();
  const { data } = useCosmosDepositWallets(chainId);
  const config = COSMOS_CHAINS[chainId];

  if (!data?.receive) {
    return null;
  }
  const { receive, funded } = data;

  // Shield a specific funded burner: route the send to this chain AND index,
  // staying on Penumbra (no network switch).
  const shield = (index: number) =>
    navigate(PopupPath.SEND, { state: { cosmosChain: chainId, cosmosAccountIndex: index } });

  return (
    <div className='flex flex-col gap-2'>
      {/* fresh, unused burner address to receive on */}
      <div className='rounded-md border border-border/40 bg-card/40 p-3'>
        <div className='flex items-center justify-between'>
          <span className='text-label text-fg-muted lowercase'>receive on {config.name}</span>
          <span className='rounded bg-red-500/10 px-1.5 py-0.5 text-label leading-none text-red-400 lowercase'>
            transparent
          </span>
        </div>
        <div className='mt-1 break-all font-mono text-xs' title={receive.address}>
          {receive.address}
        </div>
        <button
          type='button'
          onClick={() => void navigator.clipboard.writeText(receive.address)}
          className='mt-1.5 flex items-center gap-1 text-label text-network-accent transition-colors hover:text-fg-high'
        >
          <span className='i-lucide-copy h-3 w-3' /> copy
        </button>
        <p className='mt-1 text-label leading-snug text-fg-muted lowercase'>
          fresh single-use address - public until shielded. a new one appears once this receives
          funds.
        </p>
      </div>

      {/* every funded burner - each independently shieldable */}
      {funded.map(w => (
        <DepositRow key={w.index} chainId={chainId} wallet={w} onShield={() => shield(w.index)} />
      ))}
    </div>
  );
};

export const CosmosSubwallets = () => {
  const selectedKeyInfo = useStore(selectEffectiveKeyInfo);
  // Only hot (mnemonic) wallets can derive/scan burner addresses here.
  if (selectedKeyInfo?.type !== 'mnemonic') {
    return null;
  }
  const chains = getActiveIbcSubnetworks('penumbra') as CosmosChainId[];
  if (chains.length === 0) {
    return null;
  }

  return (
    <div className='mt-4'>
      <div className='kicker mb-2'>unshielded · burner</div>
      <div className='flex flex-col gap-2'>
        {chains.map(chainId => (
          <ChainDeposits key={chainId} chainId={chainId} />
        ))}
      </div>
    </div>
  );
};
