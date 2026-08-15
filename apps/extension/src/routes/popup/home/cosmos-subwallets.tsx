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
    return (
      <div className='flex items-center gap-3 rounded-md border border-border/40 bg-card/40 px-3 py-2'>
        <div className='flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium uppercase'>
          {config.symbol.slice(0, 2)}
        </div>
        <div className='flex flex-1 flex-col min-w-0'>
          {/* every asset the burner holds (UM, USDC, ...) - each can be shielded
              or sent from the form the buttons open */}
          {wallet.assets.length > 0 ? (
            wallet.assets.map(a => (
              <Sensitive key={a.denom} className='font-mono text-sm tabular-nums'>
                {a.formatted}
              </Sensitive>
            ))
          ) : (
            <Sensitive className='font-mono text-sm tabular-nums'>{wallet.formatted}</Sensitive>
          )}
          <div className='flex items-center gap-1 font-mono text-label text-fg-muted'>
            <span className='truncate' title={wallet.address}>
              {truncate(wallet.address)}
            </span>
            <RpcHint endpoint={endpoint} />
            <CopyButton value={wallet.address} label='copy address' />
          </div>
        </div>
        {/* icon-only actions - labels live in the tooltip. blue = send out,
            penumbra purple = shield back in. */}
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
  // which RPC each address is queried through (rotated per index) - surfaced on
  // hover. Noble's pool is user-editable; other chains use their config pool.
  const { pool: noblePool } = useNobleRpcPool();
  const pool = chainId === 'noble' ? noblePool : rpcEndpointPool(chainId);
  const endpointFor = (index: number): string | undefined =>
    pool.length ? pool[index % pool.length] : undefined;

  if (!data?.receive) {
    return null;
  }
  const { receive, funded } = data;

  // Send out to any address (exchange, another chain): the cosmos send form for
  // this specific funded burner index, staying on Penumbra (no network switch).
  const openSend = (index: number) =>
    navigate(PopupPath.SEND, {
      state: { cosmosChain: chainId, cosmosAccountIndex: index, cosmosIntent: 'send' },
    });

  // Shield a specific funded burner back INTO Penumbra: the real IBC deposit
  // flow lives on the Receive page's "ibc shield" tab - not a cosmos send. Pass
  // the chain + burner index so it shields THAT wallet, not account 0.
  const shieldIntoPenumbra = (index: number) =>
    navigate(PopupPath.RECEIVE, {
      state: { mode: 'shield', cosmosChain: chainId, cosmosAccountIndex: index },
    });

  return (
    <div className='flex flex-col gap-2'>
      {/* fresh, unused address to receive on - the how/why lives in the badge
          tooltip rather than a paragraph under it */}
      <ReceiveCard
        chainName={config.name}
        address={receive.address}
        endpoint={endpointFor(receive.index)}
      />

      {/* every funded address - send out or shield back, each from its own index.
          The editable RPC pool lives in Settings -> networks -> Penumbra -> Noble. */}
      {funded.map(w => (
        <DepositRow
          key={w.index}
          chainId={chainId}
          wallet={w}
          endpoint={endpointFor(w.index)}
          onSend={() => openSend(w.index)}
          onShield={() => shieldIntoPenumbra(w.index)}
        />
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
      <div className='flex flex-col gap-2'>
        {chains.map(chainId => (
          <ChainDeposits key={chainId} chainId={chainId} />
        ))}
      </div>
    </div>
  );
};
