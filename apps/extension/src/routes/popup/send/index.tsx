/**
 * multi-network send screen
 * penumbra supports IBC withdrawals to cosmos chains
 * cosmos chains use skip go api for routing
 */

import { useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { PopupPath } from '../paths';
import { ZcashSend } from './zcash-send';
import { useStore } from '../../../state';
import { selectActiveNetwork } from '../../../state/keyring';
import { activeAccountIndex } from '../../../state/pockets';
import { isActiveIbcChain, getNetwork, getActiveIbcSubnetworks } from '../../../config/networks';
import type { NetworkType } from '../../../state/keyring';
import type { CosmosChainId } from '@repo/wallet/networks/cosmos/chains';
import { Button } from '@repo/ui/components/ui/button';
import { ScreenHeader } from '../../../components/screen-header';
import { isDedicatedWindow } from '../../../utils/popup-detection';
import {
  PrivacySwitch,
  orderTransparentChains,
  type Privacy,
} from '../../../components/privacy-switch';
import { resolveNetworkCosmosChain } from './chain-identity';
import { CosmosSend } from './cosmos-send';
import { PenumbraSend } from './penumbra-send';

interface SendLocationState {
  prefillMemo?: string;
  prefillRecipient?: string;
  prefillAmount?: string;
  /**
   * Row-level "Send X" quick-action on the home asset list: base denom of the
   * asset to preselect. Matched against `metadata.base` on the fetched balance
   * list. Falls back to the top-priority balance if the denom is not found.
   */
  prefillAsset?: string;
  /**
   * Cosmos off-ramp: open the cosmos send for this chain WITHOUT switching the
   * active network. Noble is a burner doorway, not a network - the user stays
   * on Penumbra; this just routes the send form to the transparent chain.
   */
  cosmosChain?: CosmosChainId;
  /** which burner index (BIP44 address_index) to spend from. Default 0. */
  cosmosAccountIndex?: number;
  /**
   * Why the cosmos send form was opened: 'shield' (back into Penumbra) or
   * 'send' (out to an external address, e.g. an exchange). The form is the same
   * today; this lets it prefill/route differently later without changing callers.
   */
  cosmosIntent?: 'send' | 'shield';
}

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
  const prefill = locationState?.prefillRecipient
    ? {
        recipient: locationState.prefillRecipient,
        amount: locationState.prefillAmount,
        memo: locationState.prefillMemo,
      }
    : searchParams.get('to')
      ? {
          recipient: searchParams.get('to') ?? undefined,
          // amount_zat (uint64 string, zatoshi) is the unambiguous unit for external callers;
          // ZcashSend expects a decimal ZEC string so we convert (1 ZEC = 1e8 zat).
          amount: (() => {
            const zat = searchParams.get('amount_zat');
            if (!zat) {
              return undefined;
            }
            const n = Number(zat);
            if (!Number.isFinite(n) || n <= 0) {
              return undefined;
            }
            return (n / 1e8).toFixed(8).replace(/0+$/, '').replace(/\.$/, '');
          })(),
          memo: externalMemo,
        }
      : undefined;

  const goBack = () => (inDedicatedWindow ? window.close() : navigate(PopupPath.INDEX));
  // cosmos chain from route state (burner off-ramp) takes precedence over the
  // active network - the user is on Penumbra, just routing a send to Noble.
  // On Penumbra, Send can also spend from a transparent chain (Injective, ...):
  // same form as the home rows' send/shield buttons open.
  const sourceChoices =
    activeNetwork === 'penumbra' && !locationState?.cosmosChain
      ? orderTransparentChains(getActiveIbcSubnetworks('penumbra') as CosmosChainId[])
      : [];
  const [privacy, setPrivacy] = useState<Privacy>('shielded');
  const [pickedChain, setPickedChain] = useState<CosmosChainId>();
  const pickedSource = privacy === 'transparent' ? (pickedChain ?? sourceChoices[0]) : undefined;
  const cosmosChain = locationState?.cosmosChain ?? pickedSource;
  // the active network may itself be a cosmos IBC destination (noble is the
  // off-ramp, the rest are the shield ramps) - resolve it through the registry
  // rather than a hand-maintained allow-list, so every live subnetwork the
  // receive side offers is classified the same way here.
  const activeCosmosChain = resolveNetworkCosmosChain(activeNetwork);
  const sendChain = cosmosChain ?? activeCosmosChain;
  const isCosmos = sendChain != null;
  // a zcash: payment link (clicked on a website) is a zcash send whatever
  // network is active
  const zcashLink = /^zcash:/i.test(searchParams.get('to') ?? '');
  const isZcash = !cosmosChain && (activeNetwork === 'zcash' || zcashLink);
  const isPenumbra = !cosmosChain && !zcashLink && activeNetwork === 'penumbra';

  const getTitle = () => {
    if (isPenumbra) {
      return 'send penumbra';
    }
    if (isCosmos) {
      // the burner "shield" and "send" buttons route here with an intent; name
      // the screen for what the user set out to do so they are not identical
      return locationState?.cosmosIntent === 'shield' ? 'shield into penumbra' : 'send';
    }
    if (isZcash) {
      return 'send zcash';
    }
    return `send ${activeNetwork}`;
  };

  // zcash uses full-screen flow
  if (isZcash) {
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

  return (
    <div className='flex flex-col'>
      <ScreenHeader
        title={getTitle()}
        backPath={inDedicatedWindow ? false : undefined}
        onBack={goBack}
      />

      {/* Content */}
      <div className='p-4'>
        {sourceChoices.length > 0 && (
          <PrivacySwitch
            privacy={privacy}
            onPrivacy={setPrivacy}
            chains={sourceChoices}
            chain={pickedSource}
            onChain={setPickedChain}
          />
        )}
        {isPenumbra ? (
          <PenumbraSend
            onSuccess={inDedicatedWindow ? () => window.close() : undefined}
            prefillAsset={locationState?.prefillAsset}
          />
        ) : isCosmos ? (
          isActiveIbcChain(sendChain as NetworkType) ? (
            <CosmosSend
              key={sendChain}
              sourceChainId={sendChain}
              initialAccountIndex={locationState?.cosmosAccountIndex}
              intent={locationState?.cosmosIntent ?? 'send'}
            />
          ) : (
            // No live IBC channel to this chain right now (channels close on
            // network upgrades and reopen later), so deposit/send is unavailable.
            <div className='flex flex-col gap-2 border border-border-soft bg-elev-1 p-4 text-sm'>
              <span className='text-fg'>channel unavailable</span>
              <span className='text-fg-muted'>
                {getNetwork(sendChain as NetworkType).name} has no open IBC channel with Penumbra
                right now.
              </span>
            </div>
          )
        ) : (
          <div className='flex flex-col gap-4'>
            <div>
              <label className='mb-1 block text-xs text-fg-muted'>recipient</label>
              <input
                type='text'
                placeholder='enter address'
                className='w-full border border-border-soft bg-input px-3 py-2.5 text-sm text-fg placeholder:text-fg-muted transition-colors duration-100 focus:border-penumbra-purple focus:outline-none'
              />
            </div>

            <div>
              <label className='mb-1 block text-xs text-fg-muted'>amount</label>
              <input
                type='text'
                placeholder='0.00'
                className='w-full border border-border-soft bg-input px-3 py-2.5 text-sm text-fg placeholder:text-fg-muted transition-colors duration-100 focus:border-penumbra-purple focus:outline-none'
              />
            </div>

            <Button variant='primary' className='mt-4 w-full'>
              continue
            </Button>

            <p className='text-center text-xs text-fg-muted'>
              {activeNetwork === 'polkadot' && 'light client transaction'}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

export default SendPage;
