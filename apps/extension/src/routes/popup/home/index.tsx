import { InFlightCard } from '../../../components/in-flight-card';
import { Suspense, useState, useCallback, useEffect } from 'react';
import type { ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';

import { useStore } from '../../../state';
import {
  selectActiveNetwork,
  selectEffectiveKeyInfo,
  selectPenumbraAccount,
  selectSetPenumbraAccount,
  type NetworkType,
} from '../../../state/keyring';
import {
  selectActiveZcashWallet,
  selectZcashWallets,
  getActiveWalletJson,
} from '../../../state/wallets';
import { localExtStorage } from '@repo/storage-chrome/local';
import { needsLogin, needsOnboard } from '../popup-needs';
import { PopupPath } from '../paths';
import { AssetListSkeleton } from '../../../components/primitives/skeleton';
import { usePreloadBalances } from '../../../hooks/use-preload';
import { useActiveAddress, derivePenumbraEphemeralFromFvk } from '../../../hooks/use-address';
import { rotateShieldedDiversifier } from '../../../state/shielded-receive-index';
import { usePolkadotPublicKey } from '../../../hooks/use-polkadot-key';
import { hasFeature } from '../../../config/networks';
import { cn } from '@repo/ui/lib/utils';
import type { CosmosChainId } from '@repo/wallet/networks/cosmos/chains';

import { BackupNudge } from './notices';
import { Button } from '@repo/ui/components/ui/button';
import { MultisigOverview } from './multisig-overview';
import { HistoryContent } from './history';
import { PenumbraContent } from './penumbra-home';
import { ZcashContent } from './zcash-home';
import { PolkadotContent, CosmosContent, NetworkPlaceholder } from './other-networks';

export interface PopupLoaderData {
  fullSyncHeight?: number;
}

export const popupIndexLoader = async (): Promise<Response | PopupLoaderData> => {
  await needsOnboard();
  const redirect = await needsLogin();
  if (redirect) {
    return redirect;
  }
  return { fullSyncHeight: await localExtStorage.get('fullSyncHeight') };
};

export const PopupIndex = () => {
  // atomic selectors - each only re-renders when its value changes
  const activeNetwork = useStore(selectActiveNetwork);
  const selectedKeyInfo = useStore(selectEffectiveKeyInfo);
  const penumbraAccount = useStore(selectPenumbraAccount);
  const setPenumbraAccount = useStore(selectSetPenumbraAccount);
  const activeZcashWallet = useStore(selectActiveZcashWallet);
  const zcashWallets = useStore(selectZcashWallets);
  const { address } = useActiveAddress();
  const penumbraWallet = useStore(getActiveWalletJson);
  const { publicKey: polkadotPublicKey } = usePolkadotPublicKey();

  const [copied, setCopied] = useState(false);
  const navigate = useNavigate();

  // Penumbra: never surface the static index address here - it is reusable and
  // linkable. Derive a fresh ephemeral address (from the FVK, so no unlock is
  // needed and watch-only works) and rotate it on every copy, mirroring the
  // Receive screen. zcash keeps its own unified address (rotated via the button).
  const isPenumbra = activeNetwork === 'penumbra';
  const [penumbraEphemeral, setPenumbraEphemeral] = useState('');
  const [ephemeralNonce, setEphemeralNonce] = useState(0);
  useEffect(() => {
    if (!isPenumbra || !penumbraWallet?.fullViewingKey) {
      setPenumbraEphemeral('');
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const addr = await derivePenumbraEphemeralFromFvk(
          penumbraWallet.fullViewingKey,
          penumbraAccount,
        );
        if (!cancelled) {
          setPenumbraEphemeral(addr);
        }
      } catch (err) {
        console.error('[home] failed to derive ephemeral penumbra address:', err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isPenumbra, penumbraWallet?.fullViewingKey, penumbraAccount, ephemeralNonce]);

  // The address shown/copied on home: ephemeral for penumbra, the unified
  // address for zcash and everything else.
  const effectiveAddress = isPenumbra ? penumbraEphemeral : address;

  // check if we're in side panel or dedicated window (can navigate normally)
  // preload balances in background for instant display
  usePreloadBalances(penumbraAccount);

  // Backup nudge: shown for mnemonic vaults until the user demonstrably
  // possesses their recovery phrase (onboarding checkbox, import, settings
  // reveal, or explicit dismissal here). Replaces a dead effect that
  // self-dismissed `backupReminderSeen` without ever rendering anything —
  // which is why this uses a fresh key: the old one is poisoned `true`
  // for every pre-fix wallet.
  const [showBackupNudge, setShowBackupNudge] = useState(false);
  useEffect(() => {
    if (selectedKeyInfo?.type !== 'mnemonic') {
      setShowBackupNudge(false);
      return;
    }
    void localExtStorage.get('seedPhraseBackedUp').then(done => {
      setShowBackupNudge(done !== true);
    });
  }, [selectedKeyInfo?.type, selectedKeyInfo?.id]);
  const dismissBackupNudge = useCallback(() => {
    setShowBackupNudge(false);
    void localExtStorage.set('seedPhraseBackedUp', true);
  }, []);

  const copyAddress = useCallback(() => {
    if (!effectiveAddress) {
      return;
    }
    setCopied(true);
    void navigator.clipboard.writeText(effectiveAddress);
    setTimeout(() => setCopied(false), 1500);
    // Rotate to a fresh ephemeral for the next share (penumbra only). The copied
    // one stays valid forever - the FVK detects every ephemeral.
    if (isPenumbra) {
      setEphemeralNonce(n => n + 1);
    }
    // zcash shielded addresses are single-use too
    if (activeNetwork === 'zcash' && effectiveAddress.startsWith('u')) {
      void rotateShieldedDiversifier();
    }
  }, [effectiveAddress, isPenumbra, activeNetwork]);

  // mnemonic vaults derive zcash keys directly — no zcash wallet record
  const walletName =
    activeNetwork === 'zcash' && selectedKeyInfo?.type !== 'mnemonic'
      ? (activeZcashWallet?.label ?? selectedKeyInfo?.name ?? 'no wallet')
      : (selectedKeyInfo?.name ?? 'no wallet');

  // gate on the selected vault, not activeZcashIndex — the index lags on
  // vault switches to mnemonic (which has no zcash wallet record).
  const selectedMultisigWallet =
    selectedKeyInfo?.type === 'frost-multisig'
      ? zcashWallets.find(w => w.vaultId === selectedKeyInfo.id && w.multisig)
      : undefined;
  const isMultisig = !!selectedMultisigWallet;

  // Single-line, middle-truncated to fit the popup width instead of wrapping the
  // full unified address over several lines. The full string is one click away
  // (copy writes it in full) and shown with a QR on the Receive screen, so
  // nothing is lost by abbreviating here. walletName is the no-address fallback.
  const shortenMiddle = (a: string, head = 14, tail = 8) =>
    a.length <= head + tail + 1 ? a : `${a.slice(0, head)}…${a.slice(-tail)}`;
  const displayAddress = effectiveAddress ? shortenMiddle(effectiveAddress) : walletName;

  // Backup nudge as a slot candidate: on zcash it competes inside the single
  // message slot (see ZcashContent); on other networks it renders alone.
  const backupNudge = showBackupNudge ? (
    <BackupNudge
      onBackUp={() => navigate(PopupPath.SETTINGS_RECOVERY_PASSPHRASE)}
      onDismiss={dismissBackupNudge}
    />
  ) : null;

  // One tidy, evenly-spaced action row rendered under the balance figure.
  // Icon + label always visible (board: receive/swap secondary, send the
  // one gold primary on the screen).
  // A pasted viewing key can see but never spend: offer only what it can do,
  // rather than send/swap buttons that could never be signed.
  const isViewingKeyOnly = selectedKeyInfo?.insensitive?.['coldSignerType'] === 'viewing-key';
  const actions = isViewingKeyOnly ? (
    <div className='flex flex-col gap-2'>
      <Button variant='secondary' onClick={() => navigate(PopupPath.RECEIVE)} className='w-full'>
        <span className='i-ph-arrow-down size-4' />
        receive
      </Button>
      <p className='text-center text-label text-fg-dim lowercase'>
        <span className='i-ph-eye mr-1 inline-block size-3 align-[-1px]' />
        viewing key - sees this wallet, cannot spend
      </p>
    </div>
  ) : (
    <div className='grid grid-cols-3 gap-3'>
      <Button variant='secondary' onClick={() => navigate(PopupPath.RECEIVE)}>
        <span className='i-ph-arrow-down size-4' />
        receive
      </Button>
      <Button variant='secondary' onClick={() => navigate(PopupPath.SWAP)}>
        <span className='i-ph-arrows-left-right size-4' />
        swap
      </Button>
      <Button variant='primary' onClick={() => navigate(PopupPath.SEND)}>
        <span className='i-ph-arrow-up size-4' />
        send
      </Button>
    </div>
  );

  return (
    <div className='flex min-h-full flex-col'>
      <div className='flex flex-col gap-3 p-4'>
        {/* address row - deliberately unboxed: metadata, not a card. The
            balance card below is the single hero box on this screen. */}
        <div className='px-1 pt-1'>
          <div className='mb-0.5 flex items-center gap-1.5'>
            <span className='text-label text-fg-dim lowercase tracking-[0.05em]'>your address</span>
            {/* tiny shielded indicator - new users may not realize their
                unified/orchard address is privacy-preserving. The shield
                icon is universally understood; one icon, no extra text. */}
            {effectiveAddress && (isPenumbra || effectiveAddress.startsWith('u')) && (
              <span
                className='i-ph-shield-check h-3 w-3 text-zigner-gold/70'
                title='shielded address - senders cannot see your other transactions'
              />
            )}
          </div>
          <div className='flex items-center gap-1.5'>
            {isMultisig && (
              <span className='shrink-0 rounded-sm bg-zigner-gold/15 px-1.5 py-0.5 text-label text-zigner-gold tabular leading-none'>
                {selectedMultisigWallet.multisig!.threshold}/
                {selectedMultisigWallet.multisig!.maxSigners}
              </span>
            )}
            {/* one line: click anywhere on the address to copy the FULL string.
                the trailing icon flips to a check as copy feedback - no label. */}
            <button
              onClick={copyAddress}
              disabled={!effectiveAddress}
              title={effectiveAddress ? 'click to copy full address' : undefined}
              className='group flex min-w-0 flex-1 items-center gap-1.5 text-xs text-fg transition-colors duration-100 hover:text-fg-high disabled:cursor-not-allowed disabled:opacity-50'
            >
              <span className='min-w-0 flex-1 truncate text-left font-mono leading-snug'>
                {displayAddress}
              </span>
              {effectiveAddress && (
                <span
                  className={cn(
                    'h-3.5 w-3.5 shrink-0',
                    copied
                      ? 'i-ph-check text-zigner-gold'
                      : 'i-ph-copy text-fg-muted group-hover:text-fg-high',
                  )}
                />
              )}
            </button>
            {effectiveAddress && isPenumbra && (
              <button
                onClick={() => setEphemeralNonce(n => n + 1)}
                className='shrink-0 rounded p-1 text-fg-muted transition-colors hover:bg-fg/5 hover:text-fg-high'
                title='rotate to a fresh address'
              >
                <span className='i-ph-arrows-clockwise h-3.5 w-3.5' />
              </button>
            )}
          </div>
        </div>

        {/* transactions in flight / just finished, any network */}
        <InFlightCard />

        {/* multisig portfolio overview (when the network supports multisig) */}
        {hasFeature(activeNetwork, 'multisig') && <MultisigOverview />}

        {/* network-specific content - lazy loaded with skeleton */}
        <Suspense fallback={<AssetListSkeleton rows={4} />}>
          <NetworkContent
            network={activeNetwork}
            penumbraAccount={penumbraAccount}
            setPenumbraAccount={setPenumbraAccount}
            zcashWallet={selectedKeyInfo?.type === 'mnemonic' ? undefined : activeZcashWallet}
            polkadotPublicKey={polkadotPublicKey}
            hasMnemonic={selectedKeyInfo?.type === 'mnemonic'}
            actions={actions}
            nudge={backupNudge}
          />
        </Suspense>

        {/* recent history */}
        <Suspense fallback={<AssetListSkeleton rows={3} />}>
          <HistoryContent network={activeNetwork} penumbraAccount={penumbraAccount} />
        </Suspense>
      </div>
    </div>
  );
};

/** network-specific content - split out to minimize re-renders */
const NetworkContent = ({
  network,
  penumbraAccount,
  setPenumbraAccount,
  zcashWallet,
  polkadotPublicKey,
  hasMnemonic,
  actions,
  nudge,
}: {
  network: NetworkType;
  penumbraAccount: number;
  setPenumbraAccount: (n: number) => void;
  zcashWallet?: {
    label: string;
    mainnet: boolean;
    orchardFvk?: string;
    ufvk?: string;
    id?: string;
  };
  polkadotPublicKey?: string;
  hasMnemonic?: boolean;
  /** shared receive/swap/send row - rendered directly under the balance */
  actions?: ReactNode;
  /** backup nudge - joins the zcash message slot; renders alone elsewhere */
  nudge?: ReactNode;
}) => {
  switch (network) {
    case 'penumbra':
      return (
        <PenumbraContent
          account={penumbraAccount}
          onAccountChange={setPenumbraAccount}
          actions={actions}
          nudge={nudge}
        />
      );

    case 'zcash':
      return (
        <ZcashContent
          hasMnemonic={hasMnemonic}
          watchOnly={zcashWallet}
          actions={actions}
          nudge={nudge}
        />
      );

    case 'polkadot':
      return (
        <>
          {nudge}
          {actions}
          <PolkadotContent publicKey={polkadotPublicKey} />
        </>
      );

    case 'kusama':
      return (
        <>
          {nudge}
          {actions}
          <PolkadotContent publicKey={polkadotPublicKey} relay='kusama' />
        </>
      );

    case 'noble':
    case 'cosmoshub':
      return (
        <>
          {nudge}
          {actions}
          <CosmosContent chainId={network as CosmosChainId} />
        </>
      );

    default:
      return (
        <>
          {nudge}
          {actions}
          <NetworkPlaceholder network={network} />
        </>
      );
  }
};
