/**
 * receive screen - show QR code for current address
 *
 * for penumbra: a "shield USDC" tab holds the Injective USDC (USDC.inj) ramp -
 * the only shielding-in path now (Noble shield-in was retired as Circle winds
 * USDC down on Noble; Noble stays a withdraw-only destination in Send). The
 * plain receive tab shows the shielded address; for penumbra that is always a
 * rotating ephemeral address (the static index address is never exposed).
 */

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { ScreenHeader } from '../../../components/screen-header';
import { useLocation } from 'react-router-dom';
import { PopupPath } from '../paths';
import { useStore } from '../../../state';
import { selectActiveNetwork } from '../../../state/keyring';
import { selectActiveZcashWallet } from '../../../state/wallets';
import { useActiveAddress } from '../../../hooks/use-address';
import { rotateShieldedDiversifier } from '../../../state/shielded-receive-index';
import { routeForChain, usePenumbraRoutes } from '../../../transparent/penumbra-routes';
import { PenumbraReceive, PlainReceive, ZcashReceive, type AddrType } from './receive-tab';
import { TransparentReceive } from './transparent-receive';
import { orderTransparentChains, type Privacy } from '../../../components/privacy-switch';
import { getActiveIbcSubnetworks } from '../../../config/networks';
import { getCosmosChain, type CosmosChainId } from '@repo/wallet/networks/cosmos/chains';
import { Segmented } from '@repo/ui/components/ui/segmented';

export function ReceivePage() {
  const activeNetwork = useStore(selectActiveNetwork);
  const isMultisig = useStore(s => !!selectActiveZcashWallet(s)?.multisig);
  const { address, loading, shieldedIndex } = useActiveAddress();
  const isPenumbra = activeNetwork === 'penumbra';
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
        getActiveIbcSubnetworks('penumbra').filter(
          c => routeForChain(c, routes) && !getCosmosChain(c).deprecation,
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

  // zcash shielded vs transparent lives in the header, not a full-width row
  // under the QR; a multisig purse is shielded-only
  const [addrType, setAddrType] = useState<AddrType>('shielded');
  const toggle = <T extends string>(value: T, onChange: (v: T) => void, label: string) => (
    <Segmented
      label={label}
      value={value}
      onChange={onChange}
      options={[
        { value: 'shielded' as T, label: 'shielded' },
        { value: 'transparent' as T, label: 'transparent' },
      ]}
    />
  );
  // what each network puts in the header and offers as its shielded address
  const looks: Partial<Record<string, { meta: ReactNode; shielded: () => ReactNode }>> = {
    zcash: {
      meta: !isMultisig && toggle(addrType, setAddrType, 'address type'),
      shielded: () => (
        <ZcashReceive
          address={fresh || shownFresh ? address : ''}
          loading={loading || (!fresh && !shownFresh)}
          stale={!fresh}
          retireShielded={retireShielded}
          addrType={addrType}
        />
      ),
    },
    penumbra: {
      meta: transparentChains.length > 0 && toggle(privacy, setPrivacy, 'privacy'),
      shielded: () => <PenumbraReceive />,
    },
  };
  const look = looks[activeNetwork];
  const body =
    receiveOn === 'penumbra' ? (
      (look?.shielded() ?? <PlainReceive address={address} loading={loading} />)
    ) : (
      <>
        {transparentChains.length > 1 && (
          <Segmented
            label='network'
            value={receiveOn}
            onChange={setPickedChain}
            options={transparentChains.map(c => ({ value: c, label: getCosmosChain(c).name }))}
            className='mb-4 w-full'
          />
        )}
        <TransparentReceive key={receiveOn} chainId={receiveOn} />
      </>
    );

  return (
    <div className='flex h-full flex-col'>
      <ScreenHeader title='receive' backPath={PopupPath.INDEX} meta={look?.meta || undefined} />
      <div className='flex flex-1 flex-col p-4'>{body}</div>
    </div>
  );
}

export default ReceivePage;
