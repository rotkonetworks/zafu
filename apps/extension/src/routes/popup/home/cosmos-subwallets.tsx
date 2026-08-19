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

import { memo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Sensitive } from '../../../components/sensitive';
import { Hint } from '../../../components/hint';
import { cn } from '@repo/ui/lib/utils';
import { useCosmosDepositWallets, type DepositWallet } from '../../../hooks/cosmos-balance';
import {
  COSMOS_CHAINS,
  rpcEndpointPool,
  type CosmosChainId,
} from '@repo/wallet/networks/cosmos/chains';
import { useNobleRpcPool } from '../../../hooks/noble-rpc';
import { getActiveIbcSubnetworks } from '../../../config/networks';
import { useStore } from '../../../state';
import { selectEffectiveKeyInfo } from '../../../state/keyring';
import { PopupPath } from '../paths';

const truncate = (addr: string, head = 10, tail = 6) =>
  addr.length <= head + tail + 3 ? addr : `${addr.slice(0, head)}…${addr.slice(-tail)}`;

const hostOf = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

/** small hover badge: which RPC endpoint this address is queried through */
const RpcHint = ({ endpoint }: { endpoint?: string }) =>
  endpoint ? (
    <Hint label={`queried via ${hostOf(endpoint)}`}>
      <span className='i-ph-shuffle h-3 w-3 shrink-0 text-fg-dim' />
    </Hint>
  ) : null;

/** Copy-to-clipboard icon button with a transient check. */
const CopyButton = ({ value, label }: { value: string; label?: string }) => {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type='button'
      onClick={() => {
        void navigator.clipboard.writeText(value);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
      className='shrink-0 text-fg-muted transition-colors hover:text-fg-high'
      title={copied ? 'copied' : (label ?? `copy ${value}`)}
    >
      <span className={cn('h-3.5 w-3.5', copied ? 'i-ph-check text-green-400' : 'i-ph-copy')} />
    </button>
  );
};

/** Fresh receive address. Explanation is in the badge tooltip, not a paragraph. */
const ReceiveCard = ({
  chainName,
  address,
  endpoint,
}: {
  chainName: string;
  address: string;
  endpoint?: string;
}) => (
  <div className='rounded-md border border-border/40 bg-card/40 px-3 py-2'>
    <div className='flex items-center justify-between'>
      <span className='text-label text-fg-muted lowercase'>receive on {chainName}</span>
      <Hint label='fresh single-use address, public until shielded. a new one appears once this is funded.'>
        <span className='rounded bg-red-500/10 px-1.5 py-0.5 text-label leading-none text-red-400 lowercase'>
          transparent
        </span>
      </Hint>
    </div>
    <div className='mt-1 flex items-center gap-2'>
      <span className='truncate font-mono text-xs' title={address}>
        {truncate(address, 14, 8)}
      </span>
      <RpcHint endpoint={endpoint} />
      <CopyButton value={address} label='copy address' />
    </div>
  </div>
);

const DepositRow = memo(
  ({
    chainId,
    wallet,
    endpoint,
    onSend,
    onShield,
  }: {
    chainId: CosmosChainId;
    wallet: DepositWallet;
    endpoint?: string;
    onSend: () => void;
    onShield: () => void;
  }) => {
    const config = COSMOS_CHAINS[chainId];
    // an address used before but since drained: shown for reference (copy), but
    // there's nothing to send or shield.
    const hasBalance = wallet.balance > 0n;
    return (
      <div className='flex items-center gap-3 rounded-md border border-border/40 bg-card/40 px-3 py-2'>
        <div className='flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium uppercase'>
          {config.symbol.slice(0, 2)}
        </div>
        <div className='flex flex-1 flex-col min-w-0'>
          {/* every asset the address holds (UM, USDC, ...) - each can be shielded
              or sent from the form the buttons open */}
          {wallet.assets.length > 0 ? (
            wallet.assets.map(a => (
              <Sensitive key={a.denom} className='font-mono text-sm tabular-nums'>
                {a.formatted}
              </Sensitive>
            ))
          ) : (
            <span className='text-label text-fg-dim lowercase'>empty</span>
          )}
          <div className='flex items-center gap-1 font-mono text-label text-fg-muted'>
            <span className='truncate' title={wallet.address}>
              {truncate(wallet.address)}
            </span>
            <RpcHint endpoint={endpoint} />
            <CopyButton value={wallet.address} label='copy address' />
          </div>
        </div>
        {/* icon-only actions (only when there's a balance to move) - labels live
            in the tooltip. blue = send out, penumbra purple = shield back in. */}
        {hasBalance && (
          <>
            <button
              type='button'
              onClick={onSend}
              className='flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-blue-500/15 text-blue-400 transition-colors hover:bg-blue-500/25'
              title='send to an external address'
            >
              <span className='i-ph-arrow-up-right h-4 w-4' />
            </button>
            <button
              type='button'
              onClick={onShield}
              className='flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-penumbra-purple/15 text-penumbra-purple transition-colors hover:bg-penumbra-purple/25'
              title='shield into Penumbra'
            >
              <span className='i-ph-shield h-4 w-4' />
            </button>
          </>
        )}
      </div>
    );
  },
);
DepositRow.displayName = 'DepositRow';

/**
 * Deposit view for one transparent IBC chain.
 * - `view='home'`: balances only, and only when funded (nothing otherwise) -
 *   the home page shows what you hold, not an address to receive on.
 * - `view='receive'`: the fresh address to receive on + every address used over
 *   time (address management, lives on the Receive page's Noble tab).
 */
const ChainDeposits = ({ chainId, view }: { chainId: CosmosChainId; view: 'home' | 'receive' }) => {
  const navigate = useNavigate();
  const { data } = useCosmosDepositWallets(chainId);
  const config = COSMOS_CHAINS[chainId];
  // which RPC each address is queried through (rotated per index) - surfaced on
  // hover. Noble's pool is user-editable; other chains use their config pool.
  const { pool: noblePool } = useNobleRpcPool();
  const pool = chainId === 'noble' ? noblePool : rpcEndpointPool(chainId);
  const endpointFor = (index: number): string | undefined =>
    pool.length ? pool[index % pool.length] : undefined;

  if (!data?.receive) {
    return null;
  }
  const { receive, funded, used, rpcError } = data;

  // An unreachable RPC leaves burners looking empty - say so plainly rather than
  // render a silent zero the user reads as lost funds. Non-alarming inline note.
  const staleNote = rpcError ? (
    <div className='flex items-center gap-1.5 rounded-md border border-border/40 bg-card/40 px-3 py-2 text-label text-fg-muted lowercase'>
      <span className='i-ph-warning-circle h-3.5 w-3.5 shrink-0 text-amber-400/80' />
      <span>couldn't reach {config.name} rpc - balance may be stale</span>
    </div>
  ) : null;

  // Send out to any address (exchange, another chain): the cosmos send form for
  // this specific address, staying on Penumbra (no network switch).
  const openSend = (index: number) =>
    navigate(PopupPath.SEND, {
      state: { cosmosChain: chainId, cosmosAccountIndex: index, cosmosIntent: 'send' },
    });

  // Shield a specific address back INTO Penumbra: the real IBC deposit flow lives
  // on the Receive page's "ibc shield" tab. Pass chain + index so it shields THAT
  // address, not account 0.
  const shieldIntoPenumbra = (index: number) =>
    navigate(PopupPath.RECEIVE, {
      state: { mode: 'shield', cosmosChain: chainId, cosmosAccountIndex: index },
    });

  const row = (w: DepositWallet) => (
    <DepositRow
      key={w.index}
      chainId={chainId}
      wallet={w}
      endpoint={endpointFor(w.index)}
      onSend={() => openSend(w.index)}
      onShield={() => shieldIntoPenumbra(w.index)}
    />
  );

  if (view === 'home') {
    if (funded.length === 0) {
      // Nothing funded: normally render nothing, but if the RPC was unreachable
      // the "nothing" is unverified - show the stale note so an empty screen
      // isn't mistaken for a zero balance.
      return staleNote;
    }
    return (
      <div className='flex flex-col gap-2'>
        {staleNote}
        {funded.map(row)}
      </div>
    );
  }

  // receive view
  return (
    <div className='flex flex-col gap-2'>
      <ReceiveCard
        chainName={config.name}
        address={receive.address}
        endpoint={endpointFor(receive.index)}
      />
      {used.length > 0 && (
        <>
          <div className='kicker mt-1'>addresses used</div>
          {used.map(row)}
        </>
      )}
    </div>
  );
};

/** Home: Noble balances, shown only when there is something funded. */
export const CosmosSubwallets = () => {
  const selectedKeyInfo = useStore(selectEffectiveKeyInfo);
  // Only hot (mnemonic) wallets can derive/scan deposit addresses here.
  if (selectedKeyInfo?.type !== 'mnemonic') {
    return null;
  }
  const chains = getActiveIbcSubnetworks('penumbra') as CosmosChainId[];
  if (chains.length === 0) {
    return null;
  }
  return (
    <div className='flex flex-col gap-2'>
      {chains.map(chainId => (
        <ChainDeposits key={chainId} chainId={chainId} view='home' />
      ))}
    </div>
  );
};

/** Receive page (Noble tab): fresh receive address + addresses used over time. */
export const NobleReceivePanel = () => {
  const selectedKeyInfo = useStore(selectEffectiveKeyInfo);
  if (selectedKeyInfo?.type !== 'mnemonic') {
    return (
      <div className='rounded-md border border-border-soft bg-elev-1 p-4 text-sm text-fg-muted lowercase'>
        cold wallets can't derive a Noble deposit address in-app yet.
      </div>
    );
  }
  return <ChainDeposits chainId='noble' view='receive' />;
};
