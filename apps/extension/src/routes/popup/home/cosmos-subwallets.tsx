/**
 * On the way in: the burner chains under Penumbra that a receive, shield or
 * withdrawal has used, one row each on the Penumbra balance. Their addresses
 * are single-use deposit addresses, each independently shieldable.
 *
 * Nothing is fetched until the user presses check: the row shows the last
 * check from this browser session, with its age. Funded burners, and every
 * other action for a chain, live in that chain's sheet.
 */

import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '@repo/ui/components/ui/button';
import { CopyButton } from '@repo/ui/components/ui/copy-button';
import { Row, RowGroup } from '@repo/ui/components/ui/row';
import { Sheet } from '@repo/ui/components/ui/sheet';
import { StatusSlot } from '@repo/ui/components/ui/status-slot';
import { COSMOS_CHAINS, type CosmosChainId } from '@repo/wallet/networks/cosmos/chains';
import { Sensitive } from '../../../components/sensitive';
import { useChainCheck } from '../../../hooks/cosmos-balance';
import { ago, type DepositWallet } from '../../../transparent/chain-check';
import { getActiveIbcSubnetworks } from '../../../config/networks';
import { useStore } from '../../../state';
import { selectEffectiveKeyInfo, selectEnabledNetworks } from '../../../state/keyring';
import { RpcPoolSheet } from '../settings/transparent-chain-endpoints';
import { BalanceGroup, BalanceRow, Tile } from '../../../components/wallet/balance-rows';
import { PopupPath } from '../paths';

const truncate = (addr: string) =>
  addr.length <= 19 ? addr : `${addr.slice(0, 10)}…${addr.slice(-6)}`;

const fmtDate = (iso: string): string =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });

/** one funded burner: what it holds, its address, and the two ways out */
const DepositRow = ({
  wallet,
  onSend,
  onShield,
}: {
  wallet: DepositWallet;
  onSend: () => void;
  onShield: () => void;
}) => (
  <div className='flex min-h-[52px] items-center gap-2 px-3.5 py-2'>
    <div className='flex min-w-0 flex-1 flex-col gap-0.5'>
      {wallet.assets.map(a => (
        <Sensitive key={a.denom} className='text-sm tabular-nums text-fg-high'>
          {a.formatted}
        </Sensitive>
      ))}
      <span className='flex items-center gap-1 text-[11px] text-fg-muted' title={wallet.address}>
        {truncate(wallet.address)}
        <CopyButton text={wallet.address} className='h-6 px-1' />
      </span>
    </div>
    <Button variant='quiet' size='sm' onClick={onSend} aria-label='send to an external address'>
      <span className='i-ph-arrow-up-right size-4' aria-hidden='true' />
    </Button>
    <Button variant='quiet' size='sm' onClick={onShield} aria-label='shield into penumbra'>
      <span className='i-ph-shield size-4' aria-hidden='true' />
    </Button>
  </div>
);

/** one chain on the Penumbra home: name, state, and the next step */
const ChainRow = ({ chainId }: { chainId: CosmosChainId }) => {
  const navigate = useNavigate();
  const config = COSMOS_CHAINS[chainId];
  const { state, check } = useChainCheck(chainId);
  const [sheet, setSheet] = useState<'chain' | 'pool' | null>(null);
  const funded = 'check' in state ? state.check.funded : [];
  const age = 'check' in state ? ago(state.check.at) : undefined;
  const sub = {
    off: 'off',
    unchecked: 'not checked',
    checking: 'checking…',
    empty: `nothing here · checked ${age}`,
    funded: `checked ${age}`,
    unanswered: "didn't answer",
  }[state.kind];

  // send out, or shield into Penumbra, from one specific burner
  const openSend = (index: number, intent: 'send' | 'shield') => {
    setSheet(null);
    navigate(PopupPath.SEND, {
      state: { cosmosChain: chainId, cosmosAccountIndex: index, cosmosIntent: intent },
    });
  };

  const showRefresh = state.kind !== 'off' && state.kind !== 'funded';
  const checking = state.kind === 'checking';

  return (
    <>
      <BalanceRow
        tile={<Tile tone='quiet'>{config.name.slice(0, 2)}</Tile>}
        label={config.name}
        tag={sub}
        amount={
          state.kind === 'funded'
            ? `${funded[0]?.assets[0]?.formatted ?? ''}${funded.length > 1 ? ` +${funded.length - 1}` : ''}`
            : undefined
        }
        onPress={() => setSheet('chain')}
        action={
          <>
            {showRefresh && (
              <button
                onClick={() => void check()}
                disabled={checking}
                aria-label={`check ${config.name}`}
                className='grid size-10 shrink-0 place-items-center text-fg-muted transition-colors hover:bg-elev-2 hover:text-fg-high disabled:text-fg-dim'
              >
                <span
                  className={`i-lucide-refresh-cw size-[18px] ${checking ? 'animate-spin' : ''}`}
                />
              </button>
            )}
          </>
        }
      />

      <Sheet
        open={sheet === 'chain'}
        onOpenChange={o => setSheet(o ? 'chain' : null)}
        title={config.name}
      >
        {config.deprecation && funded.length > 0 && (
          <StatusSlot tone='warn' icon='i-ph-warning'>
            <span>{config.name} is being deprecated</span>
            <span className='text-fg-muted'>
              move out by {fmtDate(config.deprecation.moveOutBy)} · frozen{' '}
              {fmtDate(config.deprecation.frozenBy)}
            </span>
          </StatusSlot>
        )}
        {funded.length > 0 && (
          <RowGroup>
            {funded.map(w => (
              <DepositRow
                key={w.index}
                wallet={w}
                onSend={() => openSend(w.index, 'send')}
                onShield={() => openSend(w.index, 'shield')}
              />
            ))}
          </RowGroup>
        )}
        <RowGroup>
          {state.kind !== 'off' && (
            <Row
              type='value'
              label='check again'
              value={age}
              onPress={() => {
                setSheet(null);
                void check();
              }}
            />
          )}
          <Row type='screen' label='use another node' onPress={() => setSheet('pool')} />
        </RowGroup>
      </Sheet>
      <RpcPoolSheet
        chainId={chainId}
        open={sheet === 'pool'}
        onOpenChange={o => setSheet(o ? 'pool' : null)}
      />
    </>
  );
};

/** one row per burner chain a flow has used */
export const CosmosSubwallets = () => {
  const selectedKeyInfo = useStore(selectEffectiveKeyInfo);
  const enabledNetworks = useStore(selectEnabledNetworks) as string[];
  // only hot (mnemonic) wallets derive burner addresses here; a chain no
  // flow has used gets no row at all
  const chains = (getActiveIbcSubnetworks('penumbra') as CosmosChainId[]).filter(
    c => COSMOS_CHAINS[c] && enabledNetworks.includes(c),
  );
  if (selectedKeyInfo?.type !== 'mnemonic' || chains.length === 0) {
    return null;
  }
  return (
    <BalanceGroup heading='on the way in'>
      {chains.map(chainId => (
        <ChainRow key={chainId} chainId={chainId} />
      ))}
    </BalanceGroup>
  );
};
