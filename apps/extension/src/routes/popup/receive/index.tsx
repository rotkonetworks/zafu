/**
 * receive screen - show QR code for current address
 *
 * for penumbra: a "shield USDC" tab holds the Injective USDC (USDC.inj) ramp -
 * the only shielding-in path now (Noble shield-in was retired as Circle winds
 * USDC down on Noble; Noble stays a withdraw-only destination in Send). The
 * plain receive tab shows the shielded address; for penumbra that is always a
 * rotating ephemeral address (the static index address is never exposed).
 */

import { useCallback, useEffect, useState } from 'react';
import { useBackNav } from '../../../utils/navigate';
import { useLocation } from 'react-router-dom';
import { PopupPath } from '../paths';
import { useStore } from '../../../state';
import { selectActiveNetwork, selectEffectiveKeyInfo } from '../../../state/keyring';
import { useActiveAddress } from '../../../hooks/use-address';
import { rotateShieldedDiversifier } from '../../../state/shielded-receive-index';
import { routeForChain, usePenumbraRoutes } from '../../../transparent/penumbra-routes';
import { activeAccountIndex } from '../../../state/pockets';
import { StatusSlot } from '@repo/ui/components/ui/status-slot';
import { ReceiveTab } from './receive-tab';
import { TransparentReceive } from './transparent-receive';
import {
  PrivacySwitch,
  orderTransparentChains,
  type Privacy,
} from '../../../components/privacy-switch';
import { getActiveIbcSubnetworks } from '../../../config/networks';
import { COSMOS_CHAINS, type CosmosChainId } from '@repo/wallet/networks/cosmos/chains';

export function ReceivePage() {
  const activeNetwork = useStore(selectActiveNetwork);
  const { address, loading, shieldedIndex } = useActiveAddress();
  const isPenumbra = activeNetwork === 'penumbra';
  // a hot-wallet pocket other than main can't derive an address yet - see
  // the same guard and reasoning in routes/popup/home/zcash-home.tsx
  const selectedKeyInfo = useStore(selectEffectiveKeyInfo);
  const pocketAccount = useStore(activeAccountIndex);
  const pocketNotReady =
    activeNetwork === 'zcash' && selectedKeyInfo?.type === 'mnemonic' && pocketAccount > 0;
  // zcash shielded addresses are single-use. Opening receive retires whatever
  // was on offer (it may have been shown or copied elsewhere), and so do each
  // copy and leaving. A retired address never lands on the clipboard twice.
  const isZcash = activeNetwork === 'zcash';
  const [offeredIndex, setOfferedIndex] = useState<string>();
  const retireShielded = useCallback(() => {
    setOfferedIndex(undefined);
    void rotateShieldedDiversifier().then(setOfferedIndex);
  }, []);
  useEffect(() => {
    if (!isZcash) {
      return;
    }
    retireShielded();
    // leaving retires the one left on screen too: its QR may have been scanned
    return () => void rotateShieldedDiversifier();
  }, [isZcash, retireShielded]);
  const fresh = !isZcash || (offeredIndex !== undefined && shieldedIndex === offeredIndex);
  // Only the first address waits behind the skeleton (the one derived on
  // arrival is whatever was on offer before, so it must not show). After
  // that a rotation is a value change: the old address stays, marked
  // retired, until the new one lands.
  const [shownFresh, setShownFresh] = useState(false);
  useEffect(() => {
    if (fresh && address) {
      setShownFresh(true);
    }
  }, [fresh, address]);

  // Transparent chains you can receive on from here: launched, with a route
  // into Penumbra, and not being wound down (Noble is withdraw-only now).
  const routes = usePenumbraRoutes();
  const transparentChains = isPenumbra
    ? orderTransparentChains(
        (getActiveIbcSubnetworks('penumbra') as CosmosChainId[]).filter(
          c => routeForChain(c, routes) && !COSMOS_CHAINS[c].deprecation,
        ),
      )
    : [];
  // Old deep links (`?mode=shield`, nav state mode 'shield') meant the
  // Injective deposit view; `receiveChain` picks a chain directly.
  const location = useLocation();
  const navState = location.state as { mode?: string; receiveChain?: CosmosChainId } | null;
  const legacyShield =
    new URLSearchParams(location.search).get('mode') === 'shield' || navState?.mode === 'shield';
  const requested = navState?.receiveChain ?? (legacyShield ? 'injective' : undefined);
  const initial = requested && transparentChains.includes(requested) ? requested : undefined;
  const [privacy, setPrivacy] = useState<Privacy>(initial ? 'transparent' : 'shielded');
  const [pickedChain, setPickedChain] = useState<CosmosChainId | undefined>(initial);
  const receiveOn: 'penumbra' | CosmosChainId =
    privacy === 'transparent' ? (pickedChain ?? transparentChains[0] ?? 'penumbra') : 'penumbra';
  const goBack = useBackNav(PopupPath.INDEX);

  return (
    <div className='flex h-full flex-col'>
      <div className='flex shrink-0 items-center gap-3 border-b border-surface-border-soft px-4 py-3'>
        <button onClick={goBack} className='text-fg-muted transition-colors hover:text-fg-high'>
          <span className='i-ph-arrow-left size-5' />
        </button>
        <h1 className='text-lg font-medium text-fg-high'>receive</h1>
      </div>

      <div className='flex flex-1 flex-col p-4'>
        {transparentChains.length > 0 && (
          <PrivacySwitch
            privacy={privacy}
            onPrivacy={setPrivacy}
            chains={transparentChains}
            chain={receiveOn === 'penumbra' ? undefined : receiveOn}
            onChain={setPickedChain}
          />
        )}
        {pocketNotReady ? (
          <StatusSlot icon='i-ph-hourglass' tone='info'>
            this pocket starts syncing once zafu updates.
          </StatusSlot>
        ) : receiveOn === 'penumbra' ? (
          <ReceiveTab
            address={fresh || shownFresh ? address : ''}
            loading={loading || (!fresh && !shownFresh)}
            stale={!fresh}
            activeNetwork={activeNetwork}
            retireShielded={retireShielded}
          />
        ) : (
          <TransparentReceive key={receiveOn} chainId={receiveOn} />
        )}
      </div>
    </div>
  );
}

export default ReceivePage;
