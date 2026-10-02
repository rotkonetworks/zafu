/**
 * multi-network send screen
 * penumbra supports IBC withdrawals to cosmos chains
 * cosmos chains use skip go api for routing
 */

import { useState, type ReactNode } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { PopupPath } from '../paths';
import { ZcashSend } from './zcash-send';
import { useStore } from '../../../state';
import { selectActiveNetwork } from '../../../state/keyring';
import { activeAccountIndex } from '../../../state/pockets';
import { isActiveIbcChain, getNetwork, getActiveIbcSubnetworks } from '../../../config/networks';
import type { NetworkType } from '../../../state/keyring';
import type { CosmosChainId } from '@repo/wallet/networks/cosmos/chains';
import { Segmented } from '@repo/ui/components/ui/segmented';
import { StatusSlot } from '@repo/ui/components/ui/status-slot';
import { COSMOS_CHAINS } from '@repo/wallet/networks/cosmos/chains';
import { NetworkUnavailable } from '../../../shared/components/network-unavailable';
import { Main } from './send-ui';
import { ScreenHeader } from '../../../components/screen-header';
import { isDedicatedWindow } from '../../../utils/popup-detection';
import { orderTransparentChains } from '../../../components/privacy-switch';
import { resolveNetworkCosmosChain } from './chain-identity';
import { CosmosSend } from './cosmos-send';
import { PenumbraSend } from './penumbra-send';
import { PenumbraIbcSend } from './ibc-send';
import { sendPrefill, type SendLocationState } from './prefill';
import { PickSheet } from './send-fields';
import { sourceChainPicks, type ChainHeld } from './source-chains';
import { Row, RowGroup } from '@repo/ui/components/ui/row';
import { offeredChains, usePenumbraRoutes } from '../../../transparent/penumbra-routes';
import { useTransparentHoldings } from '../../../hooks/transparent-holdings';

export function SendPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const activeNetwork = useStore(selectActiveNetwork);
  const activePocket = useStore(activeAccountIndex);
  // dedicated window should close on completion, side panel navigates normally
  const [inDedicatedWindow] = useState(() => isDedicatedWindow());

  // get prefill from location state (inbox compose), URL params (external message), or hash params
  const locationState = location.state as SendLocationState | undefined;
  const searchParams = new URLSearchParams(location.search);
  // `[primary]` expands to the user's oldest non-multisig Zcash wallet (the original onboarding
  // wallet - new wallets are prepended, so the oldest sits at the END of the array). `[self]`
  // is kept as an alias for backward compatibility. Letting callers reference the address by
  // token saves a "what's my address" round-trip; the user can still edit the memo before send.
  const allZcashWallets = useStore(s => s.wallets.zcashWallets);
  const primaryAddr = allZcashWallets.filter(w => !w.multisig).at(-1)?.address;
  const rawMemo = searchParams.get('memo');
  const memoHasToken = !!rawMemo && (rawMemo.includes('[primary]') || rawMemo.includes('[self]'));
  // wallets persist asynchronously; if a token is in the memo but the store hasn't hydrated yet,
  // we show a brief loading state instead of leaking the literal token into the form.
  const waitingForWallets = memoHasToken && !primaryAddr && allZcashWallets.length === 0;
  const externalMemo = (() => {
    if (!rawMemo) {
      return undefined;
    }
    if (!memoHasToken) {
      return rawMemo;
    }
    if (!primaryAddr) {
      return rawMemo;
    }
    return rawMemo.replaceAll('[primary]', primaryAddr).replaceAll('[self]', primaryAddr);
  })();
  const prefill = sendPrefill(locationState, searchParams, externalMemo);

  const goBack = () => (inDedicatedWindow ? window.close() : navigate(PopupPath.INDEX));
  // a zcash: payment link (clicked on a website) is a zcash send whatever
  // network is active
  const zcashLink = /^zcash:/i.test(searchParams.get('to') ?? '');
  // the burner off-ramp (route state) names its chain; otherwise the active
  // network may itself be a cosmos ibc destination, resolved through the registry
  const cosmosChain = locationState?.cosmosChain ?? resolveNetworkCosmosChain(activeNetwork);

  const network = locationState?.network ?? activeNetwork;
  if (!locationState?.cosmosChain && (zcashLink || network === 'zcash')) {
    if (waitingForWallets) {
      return (
        <div className='flex h-full items-center justify-center p-6 text-xs text-fg-muted'>
          loading wallets…
        </div>
      );
    }
    return (
      <ZcashSend onClose={goBack} accountIndex={activePocket} mainnet={true} prefill={prefill} />
    );
  }
  if (cosmosChain) {
    return (
      <TransparentSend
        chain={cosmosChain}
        onClose={goBack}
        accountIndex={locationState?.cosmosAccountIndex}
        intent={locationState?.cosmosIntent ?? 'send'}
      />
    );
  }
  if (network === 'penumbra') {
    return (
      <PenumbraSendScreen
        onClose={goBack}
        prefillAsset={locationState?.prefillAsset}
        prefillRecipient={prefill?.recipient}
        initialMode={locationState?.penumbraMode}
      />
    );
  }
  return (
    <div className='flex h-full flex-col'>
      <ScreenHeader title='send' onBack={goBack} />
      <NetworkUnavailable feature='sending' iconClass='i-ph-paper-plane-tilt' />
    </div>
  );
}

/** a send out of a transparent chain, or its calm refusal while no channel is open */
function TransparentSend({
  chain,
  onClose,
  accountIndex,
  intent,
  meta,
  above,
}: {
  chain: CosmosChainId;
  onClose: () => void;
  accountIndex?: number;
  intent: 'send' | 'shield';
  meta?: ReactNode;
  above?: ReactNode;
}) {
  // channels close on network upgrades and reopen later
  if (!isActiveIbcChain(chain as NetworkType)) {
    return (
      <div className='flex h-full flex-col'>
        <ScreenHeader title='send' onBack={onClose} meta={meta} />
        <Main className='gap-[18px] pt-5'>
          {above}
          <StatusSlot tone='warn' icon='i-ph-warning'>
            {getNetwork(chain as NetworkType).name.toLowerCase()} has no open channel with penumbra
            right now · please try again later
          </StatusSlot>
        </Main>
      </div>
    );
  }
  return (
    <CosmosSend
      key={chain}
      sourceChainId={chain}
      initialAccountIndex={accountIndex}
      intent={intent}
      onClose={onClose}
      meta={meta}
      above={above}
    />
  );
}

type PenumbraMode = 'send' | 'withdraw' | 'transparent';

/**
 * Penumbra's three ways out, picked in the header: a private send, an ibc
 * withdraw to a cosmos chain, or a send from one of its transparent chains.
 */
function PenumbraSendScreen({
  onClose,
  prefillAsset,
  prefillRecipient,
  initialMode,
}: {
  onClose: () => void;
  prefillAsset?: string;
  prefillRecipient?: string;
  initialMode?: PenumbraMode;
}) {
  const routes = usePenumbraRoutes();
  const holdings = useTransparentHoldings();
  const candidates = orderTransparentChains(getActiveIbcSubnetworks('penumbra') as CosmosChainId[]);
  const held = new Map<CosmosChainId, ChainHeld>();
  for (const list of holdings.holdings.values()) {
    for (const h of list) {
      held.set(h.chainId, {
        amounts: [
          ...(held.get(h.chainId)?.amounts ?? []),
          `${h.asset.formatted} ${h.asset.symbol.toLowerCase()}`,
        ],
      });
    }
  }
  const picks = sourceChainPicks(
    candidates,
    new Set(offeredChains(candidates, routes)),
    new Set(holdings.chains.filter(c => holdings.statusOf(c).at > 0)),
    held,
  );
  const chains = picks.map(p => p.key);
  const [mode, setMode] = useState<PenumbraMode>(initialMode ?? 'send');
  const [chain, setChain] = useState<CosmosChainId>();
  const [picking, setPicking] = useState(false);
  const source = chain ?? chains[0];
  const sourcePick = picks.find(p => p.key === source);
  const meta = (
    <Segmented
      label='send mode'
      value={mode}
      onChange={setMode}
      options={[
        { value: 'send', label: 'send' },
        { value: 'withdraw', label: 'withdraw' },
        ...(source ? [{ value: 'transparent' as const, label: 'transparent' }] : []),
      ]}
    />
  );
  const screens: Record<PenumbraMode, () => ReactNode> = {
    send: () => (
      <PenumbraSend
        onClose={onClose}
        prefillAsset={prefillAsset}
        prefillRecipient={prefillRecipient}
        meta={meta}
      />
    ),
    withdraw: () => <PenumbraIbcSend onClose={onClose} meta={meta} />,
    transparent: () =>
      source && (
        <TransparentSend
          chain={source}
          onClose={onClose}
          intent='send'
          meta={meta}
          above={
            <>
              <RowGroup>
                <Row
                  type='value'
                  label='chain'
                  description={sourcePick?.description}
                  value={COSMOS_CHAINS[source].name.toLowerCase()}
                  disabled={chains.length < 2}
                  onPress={() => setPicking(true)}
                />
              </RowGroup>
              <PickSheet
                title='send from'
                open={picking}
                onOpenChange={setPicking}
                picks={picks}
                onPick={setChain}
              />
            </>
          }
        />
      ),
  };
  return <div className='flex h-full flex-col bg-canvas'>{screens[mode]()}</div>;
}

export default SendPage;
