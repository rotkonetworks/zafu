import { lazy, Suspense, useState, useCallback, useEffect, useMemo, useRef } from 'react';
import type { ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';

import { useStore } from '../../../state';
import { privacySelector } from '../../../state/privacy';
import {
  selectActiveNetwork,
  selectEffectiveKeyInfo,
  selectPenumbraAccount,
  selectSetPenumbraAccount,
  selectSelectKeyRing,
  keyRingSelector,
  type NetworkType,
} from '../../../state/keyring';
import { PenumbraAccountPicker } from '../../../components/penumbra-account-picker';
import { Sensitive } from '../../../components/sensitive';
import {
  selectActiveZcashWallet,
  selectZcashWallets,
  selectActiveZcashIndex,
} from '../../../state/wallets';
import { localExtStorage } from '@repo/storage-chrome/local';
import { needsLogin, needsOnboard } from '../popup-needs';
import { PopupPath } from '../paths';
import { AssetListSkeleton } from '../../../components/primitives/skeleton';
import { usePreloadBalances } from '../../../hooks/use-preload';
import { useActiveAddress } from '../../../hooks/use-address';
import { useTransparentAddresses } from '../../../hooks/use-transparent-addresses';
import { usePolkadotPublicKey } from '../../../hooks/use-polkadot-key';
import { useCosmosAssets } from '../../../hooks/cosmos-balance';
import { useZcashSyncStatus } from '../../../hooks/zcash-sync';
import { useTransparentBalance } from '../../../hooks/zcash-transparent-balance';
import {
  spawnNetworkWorker,
  terminateNetworkWorker,
  markWalletSyncing,
  startSyncInWorker,
  startWatchOnlySyncInWorker,
  getBalanceInWorker,
  zcashSyncHeightKey,
} from '../../../state/keyring/network-worker';
import { usePendingSends, usePoolBalances } from '../../../hooks/zcash-pool-balances';
import { ShieldTransparent } from '../../../components/zcash/shield-transparent';
import { IRONWOOD_MIGRATION, nu63ActivationHeight } from '../../../config/feature-flags';
import { rescanStartHeight } from '../../../utils/zcash-blocks';
import { IronwoodMigrationBanner, IronwoodMigrate } from '../send/ironwood-migrate';
import { COSMOS_CHAINS, type CosmosChainId } from '@repo/wallet/networks/cosmos/chains';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { viewClient, sctClient } from '../../../clients';
import { getDisplayDenomFromView } from '@penumbra-zone/getters/value-view';
import { fromValueView } from '@rotko/penumbra-types/amount';
import { getHistoryInWorker } from '../../../state/keyring/network-worker';
import { deleteZcashDatabases } from '../../../clear-cache-startup';
import { cn } from '@repo/ui/lib/utils';
import { messagesSelector } from '../../../state/messages';
import { SyncProgressBar } from '../../../components/sync-progress-bar';
import { SyncStatus, type SyncStage } from '../../../components/zcash/sync-status';
import { useSyncProgress } from '../../../hooks/full-sync-height';
import { usePasswordGate } from '../../../hooks/password-gate';
import type { TransactionInfo } from '@penumbra-zone/protobuf/penumbra/view/v1/view_pb';

/** lazy load network-specific content - only load when needed */
const AssetsTable = lazy(() => import('./assets-table').then(m => ({ default: m.AssetsTable })));
const PolkadotAssets = lazy(() =>
  import('./polkadot-assets').then(m => ({ default: m.PolkadotAssets })),
);
// Cosmos sub-wallets render under the Penumbra view to surface
// unshielded balances the user can shield. Lazy so non-Penumbra views
// don't pay the chunk.
const CosmosSubwallets = lazy(() =>
  import('./cosmos-subwallets').then(m => ({ default: m.CosmosSubwallets })),
);

/** shows all multisig wallets with balances at a glance */
const MultisigOverview = () => {
  const zcashWallets = useStore(selectZcashWallets);
  const activeIdx = useStore(selectActiveZcashIndex);
  const selectKeyRing = useStore(selectSelectKeyRing);
  const { workerSyncHeight } = useZcashSyncStatus();
  const [expanded, setExpanded] = useState(false);
  const [balances, setBalances] = useState<Record<string, bigint>>({});

  const multisigWallets = useMemo(
    () =>
      zcashWallets
        .filter(w => w.multisig && !w.multisig.hidden)
        .map(w => ({ ...w, originalIndex: zcashWallets.indexOf(w) })),
    [zcashWallets],
  );

  // fetch balances for all multisig wallets. sync writes notes keyed by
  // vaultId (selectedKeyInfo.id), not zcashWallet.id, so the balance lookup
  // must use vaultId; local state stays keyed by w.id for row identity.
  // re-fetch on every sync-progress tick — only the *active* wallet emits
  // these, but that's enough to refresh the active multisig vault's row.
  useEffect(() => {
    const fetchAll = () => {
      for (const w of multisigWallets) {
        if (!w.vaultId) {
          continue;
        }
        const vaultId = w.vaultId;
        const rowId = w.id;
        getBalanceInWorker('zcash', vaultId)
          .then(bal => setBalances(prev => ({ ...prev, [rowId]: BigInt(bal) })))
          .catch(() => {});
      }
    };
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.network !== 'zcash') {
        return;
      }
      fetchAll();
    };
    window.addEventListener('network-sync-progress', handler);
    fetchAll();
    return () => window.removeEventListener('network-sync-progress', handler);
  }, [multisigWallets, workerSyncHeight]);

  if (multisigWallets.length === 0) {
    return null;
  }

  const totalZat = Object.values(balances).reduce((sum, b) => sum + b, 0n);
  const formatZec = (zat: bigint) => {
    const whole = zat / 100_000_000n;
    const frac = zat % 100_000_000n;
    const fracStr = frac.toString().padStart(8, '0').replace(/0+$/, '') || '0';
    return `${whole}.${fracStr}`;
  };

  return (
    <div className='rounded-md border border-border-soft bg-elev-1'>
      <button
        onClick={() => setExpanded(!expanded)}
        className='flex items-center justify-between w-full px-4 py-3 text-left'
      >
        <div className='flex items-center gap-2'>
          <span className='i-lucide-key-round h-4 w-4 text-zigner-gold' />
          <span className='text-data text-fg-high lowercase'>multisig wallets</span>
          <span className='rounded-full bg-zigner-gold/15 px-1.5 py-0.5 text-label text-zigner-gold tabular'>
            {multisigWallets.length}
          </span>
        </div>
        <div className='flex items-center gap-2'>
          <Sensitive className='text-data tabular text-fg-muted'>
            {formatZec(totalZat)} ZEC
          </Sensitive>
          <span
            className={cn(
              'h-4 w-4 text-fg-dim transition-transform',
              expanded ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down',
            )}
          />
        </div>
      </button>

      {expanded && (
        <div className='border-t border-border-soft px-4 py-2 space-y-1'>
          {multisigWallets.map(w => {
            const bal = balances[w.id] ?? 0n;
            const isActive = w.originalIndex === activeIdx;
            return (
              <button
                key={w.id}
                onClick={() => {
                  void selectKeyRing(w.vaultId);
                }}
                className={cn(
                  'flex items-center justify-between w-full rounded-sm px-3 py-2 text-left transition-colors',
                  isActive ? 'bg-zigner-gold/10' : 'hover:bg-elev-2',
                )}
              >
                <div className='flex items-center gap-2 min-w-0'>
                  <span className='rounded-sm bg-zigner-gold/15 px-1.5 py-0.5 text-label text-zigner-gold tabular leading-none shrink-0'>
                    {w.multisig!.threshold}/{w.multisig!.maxSigners}
                  </span>
                  <span className='text-data text-fg-high truncate'>{w.label}</span>
                  {isActive && (
                    <span className='i-lucide-check h-3 w-3 text-zigner-gold shrink-0' />
                  )}
                </div>
                <Sensitive className='text-data tabular text-fg-muted shrink-0'>
                  {formatZec(bal)}
                </Sensitive>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
};

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
  const { publicKey: polkadotPublicKey } = usePolkadotPublicKey();

  const [copied, setCopied] = useState(false);
  const navigate = useNavigate();

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
    if (!address) {
      return;
    }
    setCopied(true);
    void navigator.clipboard.writeText(address);
    setTimeout(() => setCopied(false), 1500);
  }, [address]);

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

  // truncate address for display
  // full address - it wraps (break-all) to use whatever width is available,
  // showing in full in a dedicated window / side panel and over a couple of
  // lines in the narrow popup. walletName is the no-address fallback.
  const displayAddress = address || walletName;

  // Backup nudge as a slot candidate: on zcash it competes inside the single
  // message slot (see ZcashContent); on other networks it renders alone.
  const backupNudge = showBackupNudge ? (
    <BackupNudge
      onBackUp={() => navigate(PopupPath.SETTINGS_RECOVERY_PASSPHRASE)}
      onDismiss={dismissBackupNudge}
    />
  ) : null;

  // One tidy, evenly-spaced action row rendered under the balance figure.
  // Icon-forward: labels reveal on hover (plus a title tooltip), so the row
  // stays graphical and calm - Zashi's big obvious actions, zafu-sized.
  const actions = (
    <div className='grid grid-cols-3 gap-3'>
      <ActionButton
        icon='i-lucide-arrow-down'
        label='receive'
        onClick={() => navigate(PopupPath.RECEIVE)}
      />
      <ActionButton
        icon='i-lucide-arrow-left-right'
        label='swap'
        onClick={() => navigate(PopupPath.SWAP)}
      />
      <ActionButton
        icon='i-lucide-arrow-up'
        label='send'
        onClick={() => navigate(PopupPath.SEND)}
        variant={activeNetwork === 'penumbra' ? 'penumbra' : 'zcash'}
      />
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
            {address && address.startsWith('u') && (
              <span
                className='i-lucide-shield-check h-3 w-3 text-zigner-gold/70'
                title='shielded address - senders cannot see your other transactions'
              />
            )}
          </div>
          <div className='flex items-center gap-1'>
            <button
              onClick={copyAddress}
              disabled={!address}
              title={address ? 'click to copy' : undefined}
              className='flex min-w-0 items-start gap-1.5 text-xs text-fg transition-colors duration-100 hover:text-fg-high disabled:opacity-50 disabled:cursor-not-allowed'
            >
              {isMultisig && (
                <span className='mt-0.5 shrink-0 rounded-sm bg-zigner-gold/15 px-1.5 py-0.5 text-label text-zigner-gold tabular leading-none'>
                  {selectedMultisigWallet.multisig!.threshold}/
                  {selectedMultisigWallet.multisig!.maxSigners}
                </span>
              )}
              <span className='min-w-0 break-all text-left font-mono leading-snug'>
                {displayAddress}
              </span>
              {/* the icon flipping to a check is the copy feedback - no label needed */}
              {address && (
                <span
                  className={cn(
                    'mt-0.5 h-3 w-3 shrink-0',
                    copied ? 'i-lucide-check text-zigner-gold' : 'i-lucide-copy',
                  )}
                />
              )}
            </button>
            {address && activeNetwork === 'zcash' && (
              <button
                onClick={() => {
                  chrome.storage.local.get('zcashShieldedIndex', r => {
                    const next = ((r['zcashShieldedIndex'] as number) ?? 0) + 1;
                    void chrome.storage.local.set({ zcashShieldedIndex: next });
                  });
                }}
                className='p-0.5 text-fg-muted transition-colors hover:text-fg-high'
                title='rotate address'
              >
                <span className='i-lucide-refresh-cw h-3 w-3' />
              </button>
            )}
          </div>
        </div>

        {/* multisig portfolio overview (zcash only, when multisigs exist) */}
        {activeNetwork === 'zcash' && <MultisigOverview />}

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

/** amber, dismissible backup reminder - gone forever once confirmed */
const BackupNudge = ({ onBackUp, onDismiss }: { onBackUp: () => void; onDismiss: () => void }) => (
  <div className='flex items-center gap-2.5 rounded-md border border-warning/30 bg-warning/[0.07] px-3 py-2.5'>
    <span className='i-lucide-triangle-alert h-4 w-4 shrink-0 text-warning' />
    <span className='flex-1 text-label text-fg lowercase'>recovery phrase not backed up</span>
    <button
      onClick={onBackUp}
      className='shrink-0 text-label text-warning lowercase underline-offset-2 hover:underline'
    >
      back up
    </button>
    <button
      onClick={onDismiss}
      title='I already backed it up'
      className='shrink-0 p-0.5 text-fg-dim transition-colors hover:text-fg-high'
    >
      <span className='i-lucide-x h-3.5 w-3.5' />
    </button>
  </div>
);

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

/** penumbra-specific content - balance card + sync bar + account picker + assets */
const PenumbraContent = ({
  account,
  onAccountChange,
  actions,
  nudge,
}: {
  account: number;
  onAccountChange: (n: number) => void;
  actions?: ReactNode;
  nudge?: ReactNode;
}) => {
  const navigate = useNavigate();
  const { latestBlockHeight, fullSyncHeight, error } = useSyncProgress();

  const isSyncing = (latestBlockHeight ?? 0) - (fullSyncHeight ?? 0) > 10;
  const syncPct =
    latestBlockHeight && fullSyncHeight
      ? Math.min(100, Math.round((Number(fullSyncHeight) / Number(latestBlockHeight)) * 100))
      : 0;

  const syncLabel = !latestBlockHeight
    ? 'connecting...'
    : isSyncing
      ? `syncing ${syncPct}%`
      : `penumbra block ${(fullSyncHeight ?? latestBlockHeight).toLocaleString()}`;

  // query UM balance for the balance card
  const { data: umBalance } = useQuery({
    queryKey: ['um-balance', account],
    staleTime: 5_000,
    queryFn: async () => {
      try {
        const balances = await Array.fromAsync(viewClient.balances({ accountFilter: { account } }));
        let total = 0;
        for (const b of balances) {
          if (!b.balanceView) {
            continue;
          }
          const denom = getDisplayDenomFromView(b.balanceView);
          if (denom === 'penumbra' || denom === 'UM') {
            total += Number(fromValueView(b.balanceView));
          }
        }
        return total;
      } catch {
        return null;
      }
    },
  });

  // refetch UM balance when sync height advances (no flicker)
  const queryClient = useQueryClient();
  const prevHeight = useRef(fullSyncHeight);
  useEffect(() => {
    if (fullSyncHeight && fullSyncHeight !== prevHeight.current) {
      prevHeight.current = fullSyncHeight;
      void queryClient.invalidateQueries({ queryKey: ['um-balance', account] });
    }
  }, [fullSyncHeight, account, queryClient]);

  const balanceDisplay =
    umBalance != null && umBalance > 0
      ? `${umBalance.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 6 })} UM`
      : isSyncing
        ? 'syncing...'
        : '0 UM';

  return (
    <div className='flex-1 flex flex-col gap-3'>
      {/* balance card — figure renders in the network accent (rebinds per chain) */}
      <div className='rounded-md border border-border-soft bg-elev-1 p-4'>
        <span className='kicker'>total balance</span>
        <div className='mt-1 text-display leading-none text-network-accent tabular'>
          <Sensitive>{balanceDisplay}</Sensitive>
        </div>
        <div className='mt-1 text-label text-fg-dim tabular'>{syncLabel}</div>
      </div>

      {/* action row directly under the balance - Zashi placement */}
      {actions}

      {/* single message slot for penumbra: only the backup nudge competes */}
      {nudge}

      {/* sync bar — visible while syncing or connecting */}
      {(isSyncing || !latestBlockHeight) && (
        <SyncProgressBar
          percent={syncPct}
          label={syncLabel}
          error={error ? String(error) : undefined}
          // Same recovery affordance as Zcash: a sync error gets a
          // one-tap link to the network picker so a new user whose
          // Penumbra grpc endpoint is unreachable doesn't have to
          // hunt through settings to switch.
          errorAction={
            error
              ? {
                  label: 'switch endpoint',
                  onClick: () => navigate(`${PopupPath.SETTINGS_NETWORKS}?network=penumbra`),
                }
              : undefined
          }
          barColor='bg-penumbra-purple'
          barDoneColor='bg-penumbra-teal'
        />
      )}

      {/* account picker — between sync bar and assets */}
      <PenumbraAccountPicker account={account} onChange={onAccountChange} />

      <div className='kicker mb-2'>assets</div>
      <Suspense fallback={<AssetListSkeleton rows={4} />}>
        <AssetsTable account={account} />
      </Suspense>

      {/* Unshielded Cosmos balances tied to the same key as the Penumbra
          wallet. Renders nothing when the user has no Cosmos holdings.
          Account index 0 — the cosmos-balance hooks don't yet split by
          Penumbra account; v1 uses the wallet's primary derivation. */}
      <Suspense fallback={null}>
        <CosmosSubwallets />
      </Suspense>
    </div>
  );
};

/**
 * The hero balance figure, in the four states it can honestly be in.
 *
 * The previous version rendered `— ZEC` whenever the wallet had not yet
 * reported a sync height, which covered "still loading", "failed to read" and
 * "genuinely zero" with one blank dash. A dash where a number belongs does not
 * read as "unknown", it reads as "gone" — which is exactly what a user who had
 * just sent a real payment concluded. Each state now says which it is.
 *
 * `partial` still shows the number: a figure that is a floor is far more use
 * than no figure, so long as it is not passed off as a total.
 */
const BalanceFigure = ({
  view,
  zec,
}: {
  view: 'loading' | 'error' | 'unknown' | 'partial' | 'ready';
  zec: number;
}) => {
  if (view === 'loading') {
    return (
      <div className='flex items-baseline gap-2 text-display leading-none'>
        {/* sized to the figure it replaces, so nothing shifts when it arrives */}
        <span className='inline-block h-[0.7em] w-40 animate-pulse rounded bg-elev-2' />
        <span className='text-label text-fg-dim lowercase'>reading balance</span>
      </div>
    );
  }

  // Scanning, nothing found yet. The wallet has not read the blocks that hold
  // its own notes — including the change from its own recent sends — so it
  // does not know the balance. Not zero. Not a dash. Not known yet.
  if (view === 'unknown') {
    return (
      <div className='flex flex-wrap items-baseline gap-x-2 gap-y-1'>
        <span className='text-display leading-none text-fg-dim lowercase'>not yet known</span>
        <span className='text-label text-fg-dim lowercase'>
          still scanning — the sync line below shows how far
        </span>
      </div>
    );
  }

  if (view === 'error') {
    return (
      <div className='flex items-baseline gap-2 text-display leading-none'>
        <span className='text-fg-dim tabular'>—</span>
        {/* the dash is only ever allowed next to the word that explains it */}
        <span className='text-label text-hanko lowercase'>balance unavailable</span>
      </div>
    );
  }

  return (
    <div className='flex flex-wrap items-baseline gap-2'>
      <span className='text-display leading-none text-network-accent tabular'>
        <Sensitive>{fmtZec(zec)} ZEC</Sensitive>
      </span>
      {view === 'partial' && (
        <span
          className='rounded-sm bg-elev-2 px-1.5 py-0.5 text-label text-fg-dim leading-none lowercase'
          title='still scanning — more funds may yet be found'
        >
          so far
        </span>
      )}
    </div>
  );
};

/** zcash-specific content — zashi-inspired combined balance */
const ZcashContent = ({
  hasMnemonic,
  watchOnly,
  actions,
  nudge,
}: {
  hasMnemonic?: boolean;
  watchOnly?: { label: string; mainnet: boolean; orchardFvk?: string; ufvk?: string; id?: string };
  actions?: ReactNode;
  nudge?: ReactNode;
}) => {
  const hasWallet = !!(hasMnemonic || watchOnly);
  const isMainnet = watchOnly?.mainnet ?? true;
  const zidecarUrl = useStore(s => s.networks.networks.zcash.endpoint) || 'https://zcash.rotko.net';
  const zcashBackend = useStore(s => s.networks.networks.zcash.backend) ?? 'zidecar';
  const { syncStatus, chainTip, workerSyncHeight, error: syncError } = useZcashSyncStatus();
  const navigate = useNavigate();

  const selectedKeyInfo = useStore(selectEffectiveKeyInfo);
  const keyRing = useStore(keyRingSelector);
  const { requestAuth, PasswordModal } = usePasswordGate();
  // must sit with the other hooks: there is an early return for the
  // no-wallet case further down, and a hook after it changes hook order.
  const { settings: privacySettings, setSetting: setPrivacySetting } = useStore(privacySelector);

  // orchard balance from worker (zatoshi string)
  const [orchardZat, setOrchardZat] = useState(0n);
  // Whether that figure means anything yet. `0n` is both "no funds" and "not
  // asked yet", and conflating them is how the balance came to render as a
  // bare em dash — a placeholder that tells the user nothing and reads as
  // "your money is gone". Every state below is now named.
  const [balanceState, setBalanceState] = useState<'loading' | 'ready' | 'error'>('loading');

  // wallet birthday — used to show progress relative to start, not block 0
  const [walletBirthday, setWalletBirthday] = useState(0);
  useEffect(() => {
    if (!hasWallet || !selectedKeyInfo) {
      return;
    }
    const key = `zcashBirthday_${selectedKeyInfo.id}`;
    chrome.storage.local.get(key, r => {
      if (typeof r[key] === 'number') {
        setWalletBirthday(r[key]);
      }
    });
  }, [hasWallet, selectedKeyInfo?.id]);

  // sync lifecycle managed by useZcashAutoSync in PopupLayout
  // this component only reads sync status and balance

  // fetch orchard balance from worker — re-fetch on sync progress and height changes
  useEffect(() => {
    if (!selectedKeyInfo) {
      return;
    }
    const walletId = selectedKeyInfo.id;

    const fetchBalance = () => {
      getBalanceInWorker('zcash', walletId)
        .then(bal => {
          setOrchardZat(BigInt(bal));
          setBalanceState('ready');
        })
        .catch(() => {
          // Keep any figure we already had — a transient worker hiccup is not
          // evidence the balance changed — but stop presenting it as current.
          setBalanceState(prev => (prev === 'ready' ? 'ready' : 'error'));
        });
    };

    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.network !== 'zcash') {
        return;
      }
      if (detail.walletId && detail.walletId !== walletId) {
        return;
      }
      fetchBalance();
    };

    window.addEventListener('network-sync-progress', handler);
    fetchBalance();
    return () => window.removeEventListener('network-sync-progress', handler);
  }, [selectedKeyInfo?.id, workerSyncHeight]);

  // derive transparent addresses for UTXO lookup (shared hook with caching)
  const { tAddresses } = useTransparentAddresses(isMainnet);

  const { totalZat: transparentZat, isLoading: utxoLoading } = useTransparentBalance(tAddresses);

  // per-pool split (orchard legacy / ironwood active) - revealed on
  // hover/expand of the hero balance, never a second permanent box
  const pools = usePoolBalances(selectedKeyInfo?.id, workerSyncHeight);
  const [poolsPinned, setPoolsPinned] = useState(false);

  // Sends we have broadcast that the chain has not confirmed. Their inputs are
  // already deducted from the figure above (markNotesSpentLocally runs at
  // broadcast), so without this line the balance simply drops with nothing to
  // account for it.
  const pendingSends = usePendingSends(selectedKeyInfo?.id, workerSyncHeight);

  // NU6.3 turnstile migration flow (feature-flagged; see feature-flags.ts)
  const [showIronwoodMigrate, setShowIronwoodMigrate] = useState(false);
  // Height a rescan has been REQUESTED for but not yet confirmed. A rescan
  // deletes the note database, so it does not happen on one click.
  const [rescanConfirmHeight, setRescanConfirmHeight] = useState<number | null>(null);
  // toggle to show sync detail panel when wallet is fully synced

  // rescan via custom event — terminate worker, clear IDB, let auto-sync restart
  useEffect(() => {
    const handler = async (e: Event) => {
      const requested = (e as CustomEvent<number>).detail;
      if (!selectedKeyInfo) {
        return;
      }
      if (typeof requested !== 'number' || isNaN(requested)) {
        return;
      }
      // A rescan DELETES the note database and writes this height as the new
      // birthday. Any note received before it becomes permanently invisible to
      // this wallet — no later scan ever revisits those blocks. So a height
      // below orchard activation is meaningless and a height at or near the
      // TIP is destructive: it means "start from now", i.e. forget everything
      // you own. Clamp to the earliest height that can hold a note.
      const height = rescanStartHeight(requested);

      try {
        const walletId = selectedKeyInfo.id;
        const birthdayKey = `zcashBirthday_${walletId}`;

        // terminate worker so in-memory commitment tree is dropped
        try {
          terminateNetworkWorker('zcash');
        } catch {}
        // delete IndexedDB to clear stale commitment tree. awaited: a
        // fire-and-forget delete against a still-open database hangs on
        // onblocked and silently leaves the data in place.
        // ('zafu-memo-cache' was deleted here too; no such database exists —
        // the memo cache is an object store inside 'zafu-zcash'.)
        await deleteZcashDatabases();
        // update birthday and clear persisted sync height
        await chrome.storage.local.set({ [birthdayKey]: height });
        // legacy global key kept in the removal list so an old install's
        // stale value cannot outlive a rescan
        await chrome.storage.local.remove(['zcashSyncHeight', zcashSyncHeightKey(walletId)]);
        setWalletBirthday(height);
        setOrchardZat(0n);
        setBalanceState('loading');

        // respawn worker and start sync — mark syncing immediately to prevent
        // auto-sync hook from racing with a duplicate sync
        await new Promise(r => setTimeout(r, 500));
        await spawnNetworkWorker('zcash');
        markWalletSyncing('zcash', walletId);

        if (hasMnemonic && selectedKeyInfo.type === 'mnemonic') {
          const mnemonic = await keyRing.getMnemonic(walletId);
          // pass the configured backend - defaulting to zidecar here would
          // point a zidecar client at a lightwalletd endpoint (HTTP 415s)
          await startSyncInWorker('zcash', walletId, mnemonic, zidecarUrl, height, zcashBackend);
        } else if (watchOnly) {
          const ufvkStr =
            watchOnly.ufvk ??
            (watchOnly.orchardFvk?.startsWith('uview') ? watchOnly.orchardFvk : undefined);
          if (ufvkStr) {
            await startWatchOnlySyncInWorker(
              'zcash',
              walletId,
              ufvkStr,
              zidecarUrl,
              height,
              zcashBackend,
            );
          }
        }
      } catch (err) {
        console.error('[zcash] rescan failed:', err);
      }
    };
    // Retry after a transient backend error (node restart, 503): respawn the
    // worker and resume from the height already reached. Deliberately does NOT
    // clear zcashSyncHeight or zero the balances the way a rescan does — a
    // blip should cost seconds, not a full re-scan from the birthday.
    const retryHandler = () => {
      void (async () => {
        try {
          const walletId = selectedKeyInfo?.id;
          if (!walletId) {
            return;
          }
          await spawnNetworkWorker('zcash');
          markWalletSyncing('zcash', walletId);
          const resumeKey = zcashSyncHeightKey(walletId);
          const resumeAt = (await chrome.storage.local.get(resumeKey))[resumeKey] as
            | number
            | undefined;
          if (hasMnemonic && selectedKeyInfo.type === 'mnemonic') {
            const mnemonic = await keyRing.getMnemonic(walletId);
            await startSyncInWorker(
              'zcash',
              walletId,
              mnemonic,
              zidecarUrl,
              resumeAt,
              zcashBackend,
            );
          } else if (watchOnly) {
            const ufvkStr =
              watchOnly.ufvk ??
              (watchOnly.orchardFvk?.startsWith('uview') ? watchOnly.orchardFvk : undefined);
            if (ufvkStr) {
              await startWatchOnlySyncInWorker(
                'zcash',
                walletId,
                ufvkStr,
                zidecarUrl,
                resumeAt,
                zcashBackend,
              );
            }
          }
        } catch (err) {
          console.error('[zcash] sync retry failed:', err);
        }
      })();
    };

    window.addEventListener('zcash-rescan', handler);
    window.addEventListener('zcash-retry-sync', retryHandler);
    return () => {
      window.removeEventListener('zcash-rescan', handler);
      window.removeEventListener('zcash-retry-sync', retryHandler);
    };
  }, [
    hasMnemonic,
    watchOnly,
    selectedKeyInfo?.id,
    selectedKeyInfo?.type,
    keyRing,
    zidecarUrl,
    zcashBackend,
  ]);

  if (!hasWallet) {
    return (
      <div className='flex flex-col items-center justify-center py-12 text-center'>
        <div className='text-sm text-fg-muted'>no zcash wallet</div>
        <div className='text-xs text-fg-muted mt-1'>
          create a wallet or import a viewing key from zigner
        </div>
      </div>
    );
  }

  // sync progress
  const chainHeight = chainTip?.height ?? syncStatus?.currentHeight ?? 0;
  const gigaproofStatus = syncStatus?.gigaproofStatus ?? 0;
  const lastGigaproofHeight = syncStatus?.lastGigaproofHeight ?? 0;
  const blocksUntilReady = syncStatus?.blocksUntilReady ?? 1;

  const nomtPct = gigaproofStatus >= 1 ? 100 : 0;
  const ligeritoPct =
    gigaproofStatus >= 2
      ? blocksUntilReady <= 0
        ? 100
        : Math.min(
            100,
            Math.round(
              (1 - (chainHeight - lastGigaproofHeight) / Math.max(blocksUntilReady, 1)) * 100,
            ),
          )
      : gigaproofStatus === 1
        ? 50
        : 0;
  const scanRange = Math.max(1, chainHeight - walletBirthday);
  const scanProgress = Math.max(0, workerSyncHeight - walletBirthday);
  // FLOOR, not round. Rounding declared "synced" at 99.5%, which with a
  // birthday a million blocks back is ~5,000 unscanned blocks presented as a
  // final balance — and it gated the "get your first zec" prompt, so a wallet
  // with unscanned receipts told the user they had none.
  const scanPct = chainHeight > 0 ? Math.min(100, Math.floor((scanProgress / scanRange) * 100)) : 0;
  // "synced" must mean every block was read, not 100 after rounding.
  const scanComplete = chainHeight > 0 && scanProgress >= scanRange;

  // Synced means "this wallet has scanned every block up to the tip" — that
  // is what makes the balance correct, and it is entirely the wallet's own
  // work. Ligerito verification is the server proving it did not lie about
  // those blocks; valuable, but it trails the server's own backfill and can
  // lag by hours. Gating "synced" on it left the wallet reading
  // "syncing 100%" indefinitely with nothing left to do and nothing the user
  // could act on — which reads as a stall, not as a pending audit.
  //
  // So the scan decides synced, and verification is reported as its own
  // stage. Note this is a display decision only: it does not weaken any
  // check, and an actually-failed proof still surfaces as a sync error.
  const allSynced = scanComplete;

  // Right after a birthday change the worker's last reported height can sit
  // at or below the new start height - that's 0 scan progress, not a reason
  // to fall back to the server pipeline pct (which reads 100% once the
  // pipeline is ready and made the bar claim "syncing 100.0%" with nothing
  // scanned yet).
  //
  // workerSyncHeight === 0 means the worker has not reported a height AT ALL:
  // no sync started, or it died before its first emit. That is the state with
  // the least information, and it used to fall through to the server pipeline
  // percentage below and announce "syncing 100%" next to "scanning notes 0%" —
  // the wallet claiming to be done while admitting it had scanned nothing.
  // Whatever the server has proven about blocks this wallet never read says
  // nothing about this wallet's balance, so it must not drive this bar.
  const scanNotStarted = workerSyncHeight <= walletBirthday;

  // pipeline stages for the sync detail panel — a steady row instead of
  // the old flickering label rotation. lightwalletd skips verification.
  const syncStages: SyncStage[] =
    zcashBackend === 'lightwalletd'
      ? [
          {
            key: 'scan',
            label: 'scanning notes',
            state: scanPct >= 100 ? 'done' : scanPct > 0 ? 'active' : 'pending',
            detail: `${Math.floor(scanPct)}%`,
          },
        ]
      : [
          {
            key: 'nomt',
            label: 'nomt',
            state: nomtPct >= 100 ? 'done' : 'active',
          },
          {
            key: 'ligerito',
            label: 'ligerito',
            state: ligeritoPct >= 100 ? 'done' : gigaproofStatus >= 1 ? 'active' : 'pending',
            // The wallet VERIFIES a ligerito proof; it never produces one —
            // proving happens server-side. So the detail says what the wallet
            // is waiting on, never what the server is doing.
            //
            // Saying nothing was worse than saying the wrong thing: the stage
            // sat blank and unfinished with no way to tell a stall from a
            // backlog. GENERATING means the server's proof trails its own
            // index and will catch up on its own; nothing is wrong and nothing
            // is required of the user.
            //
            // blocksUntilReady is a countdown, but some server states report a
            // raw height here — rendering "3436543 blocks" as a remaining
            // count is nonsense, so it is shown only when it reads like a
            // delta.
            detail:
              ligeritoPct >= 100
                ? undefined
                : blocksUntilReady > 0 && blocksUntilReady < 100_000
                  ? `${blocksUntilReady} blocks`
                  : gigaproofStatus >= 1
                    ? 'server catching up'
                    : 'waiting for server',
          },
          {
            key: 'scan',
            label: 'scanning notes',
            state: scanPct >= 100 ? 'done' : scanPct > 0 ? 'active' : 'pending',
            detail: `${Math.floor(scanPct)}%`,
          },
        ];

  // overall sync percentage (0-100) with 1 decimal — zashi style
  const overallPct =
    scanPct > 0
      ? Math.min(100, (scanProgress / scanRange) * 100)
      : scanNotStarted
        ? 0
        : ligeritoPct > 0
          ? Math.min(100, ligeritoPct)
          : nomtPct;

  // combined balance - transparent funds fold into the single hero figure
  const totalZat = orchardZat + transparentZat;
  const totalZec = Number(totalZat) / 1e8;

  // What the hero figure is allowed to claim.
  //
  //   loading — we have not read a balance yet. Show a placeholder that is
  //             visibly a placeholder, never a dash where a number goes.
  //   error   — the read failed and we have nothing to fall back on. Say so.
  //   unknown — the read succeeded and came back zero, but the wallet has not
  //             finished scanning. Zero here means "nothing found YET", and
  //             the two are not the same claim. A wallet mid-scan has not yet
  //             rediscovered its own change notes, so printing "0 ZEC" (or a
  //             bare dash) states a loss that has not happened.
  //   partial — a positive figure with scanning still to do: a floor, not a
  //             total, and labelled as such.
  //   ready   — scanned to the tip. The number is the number, including zero.
  //
  // A wallet that has never synced but holds transparent funds still has
  // something true to show, so a positive figure counts as loaded.
  const balanceView: 'loading' | 'error' | 'unknown' | 'partial' | 'ready' =
    balanceState === 'error' && totalZat === 0n
      ? 'error'
      : balanceState === 'loading' && totalZat === 0n
        ? 'loading'
        : allSynced
          ? 'ready'
          : totalZat === 0n
            ? 'unknown'
            : 'partial';

  // In-flight and failed sends, for the line under the figure. `amount` is
  // already what left the wallet (recipient + fee) — adding the fee again here
  // would double-count it.
  const inFlightZat = pendingSends
    .filter(t => t.status === 'pending')
    .reduce((sum, t) => sum + BigInt(t.amount), 0n);
  const failedSends = pendingSends.filter(t => t.status === 'failed');

  // NU6.3 turnstile: eligible once the flag is on, activation has passed,
  // and legacy orchard funds remain (per-pool split from the worker)
  const ironwoodEligible =
    IRONWOOD_MIGRATION &&
    (chainTip?.height ?? 0) >= nu63ActivationHeight(isMainnet) &&
    pools.orchard > 0n;

  // Single message slot - Zashi's HomeMessage pattern: exactly one nudge at
  // a time. Priority: sync error (the sync bar below owns that surface, so
  // the slot yields entirely) > ironwood migrate > backup nudge > get-zec
  // hint / first-sync reassurance (mutually exclusive by allSynced).
  const messageSlot: ReactNode = syncError ? null : ironwoodEligible ? (
    <IronwoodMigrationBanner
      orchardZat={pools.orchard}
      onMigrate={() => setShowIronwoodMigrate(true)}
    />
  ) : nudge ? (
    nudge
  ) : allSynced && totalZat === 0n ? (
    <GetZecHint onReceive={() => navigate(PopupPath.RECEIVE)} />
  ) : null;

  // Pool rows for the hero-card reveal. All three pools stay visible
  // (ironwood active / orchard legacy / transparent public below) so no
  // pool is ever hidden. Falls back to a single "shielded" row if the
  // worker's per-pool endpoint reports nothing while the combined balance
  // is positive (older worker builds).
  const poolRows =
    pools.total === 0n && orchardZat > 0n
      ? [
          {
            key: 'shielded',
            icon: 'i-lucide-shield-check',
            label: 'shielded',
            badge: undefined as string | undefined,
            zat: orchardZat,
          },
        ]
      : [
          {
            key: 'ironwood',
            icon: 'i-lucide-shield-check',
            label: 'ironwood',
            badge: undefined as string | undefined,
            zat: pools.ironwood,
          },
          {
            key: 'orchard',
            icon: 'i-lucide-clock',
            label: 'orchard',
            badge: 'legacy' as string | undefined,
            zat: pools.orchard,
          },
        ];

  // glance -> detail: the hero balance opens the full per-pool notes view;
  // each reveal row deep-links to its pool ('shielded' fallback -> ironwood)
  const openPoolNotes = (pool?: string) => {
    if (!IRONWOOD_MIGRATION) {
      return; // route is registered only when the flag is on
    }
    navigate(pool ? `${PopupPath.POOL_NOTES}?pool=${pool}` : PopupPath.POOL_NOTES);
  };

  return (
    <div className='flex-1 flex flex-col gap-3'>
      {PasswordModal}
      {/* hero balance - the single figure on this screen at two depths:
          hover (or pin via the chevron) reveals the per-pool split inline,
          click opens the full per-pool notes view. The split never
          occupies a second permanent box. */}
      <div className='rounded-md border border-network-accent/20 bg-elev-1 p-4'>
        <div className='flex items-center justify-between'>
          <span className='kicker'>balance</span>
          <div className='flex items-center gap-1'>
            {/* the global hide-balances control lives where you notice you
              need it — same state as settings → privacy, effective on
              every amount in the app */}
            <button
              onClick={() => void setPrivacySetting('hideBalances', !privacySettings.hideBalances)}
              title={privacySettings.hideBalances ? 'show balances' : 'hide balances'}
              className='p-0.5 text-fg-dim transition-colors hover:text-fg-high'
            >
              <span
                className={cn(
                  'block h-3.5 w-3.5',
                  privacySettings.hideBalances ? 'i-lucide-eye-off' : 'i-lucide-eye',
                )}
              />
            </button>
            <button
              onClick={() => setPoolsPinned(v => !v)}
              title={poolsPinned ? 'hide pool detail' : 'show pool detail'}
              aria-expanded={poolsPinned}
              className='p-0.5 text-fg-dim transition-colors hover:text-fg-high'
            >
              <span
                className={cn(
                  'block h-3.5 w-3.5 transition-transform',
                  poolsPinned ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down',
                )}
              />
            </button>
          </div>
        </div>
        {IRONWOOD_MIGRATION ? (
          <button
            type='button'
            onClick={() => openPoolNotes()}
            title='view notes'
            className='mt-1 block text-left transition-opacity hover:opacity-80'
          >
            <BalanceFigure view={balanceView} zec={totalZec} />
          </button>
        ) : (
          <div className='mt-1'>
            <BalanceFigure view={balanceView} zec={totalZec} />
          </div>
        )}

        {/* What the figure above does not say on its own. Quiet by default;
            hanko red only for a send that can no longer confirm, which is a
            genuine problem and the one case the user must act on. */}
        {inFlightZat > 0n && (
          <div className='mt-1.5 flex items-center gap-1.5 text-label text-fg-dim lowercase'>
            <span className='i-lucide-arrow-up h-3 w-3 shrink-0' />
            <span className='tabular'>
              <Sensitive>{fmtZec(Number(inFlightZat) / 1e8)} ZEC</Sensitive> leaving
            </span>
            <span>·</span>
            {/* deliberately not "sent" or "on its way": we do not know that it
                will confirm, and saying so would be rendering hope as fact */}
            <span>not yet confirmed</span>
          </div>
        )}
        {/* The notes this payment would have spent were marked spent locally at
            broadcast and are NOT released automatically — nothing in the wallet
            un-marks them, so the balance stays low until the chain is re-read.
            Saying "your funds are back" would be a lie; saying what actually
            recovers them is not. */}
        {failedSends.length > 0 && (
          <div className='mt-1.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-label text-hanko lowercase'>
            <span className='i-lucide-alert-triangle h-3 w-3 shrink-0' />
            <span>
              {failedSends.length === 1 ? 'a payment' : `${failedSends.length} payments`} expired
              without confirming
            </span>
            <span className='text-fg-dim'>·</span>
            <button
              type='button'
              // Never the chain tip. The old fallback (`walletBirthday ||
              // chainHeight`) meant that a wallet with no stored birthday —
              // the default for every import that did not supply one — asked
              // to rescan FROM NOW, and the handler then wrote that as the new
              // birthday: every note the wallet already held became invisible
              // forever. Orchard activation is the earliest height that can
              // hold a note, so it can never hide one.
              onClick={() => setRescanConfirmHeight(rescanStartHeight(walletBirthday || null))}
              className='text-zigner-gold underline-offset-2 hover:underline'
              // not "release the funds": the inputs are held until the chain
              // is re-read, and re-reading it is not free
              title='re-read the chain from the start of this wallet so the held inputs are re-counted'
            >
              re-read the chain to recount those inputs
            </button>
          </div>
        )}

        {/* Rescan confirmation. This is the destructive one: it drops every
            scanned note and re-derives the wallet from `height` upward. Stating
            the cost is the whole point — the previous version had no confirm
            step at all. */}
        {rescanConfirmHeight !== null && (
          <div className='mt-2 rounded-lg border border-hanko/40 bg-elev-2 p-3 text-label leading-snug'>
            <div className='flex items-center gap-1.5 text-hanko'>
              <span className='i-lucide-alert-triangle h-3.5 w-3.5 shrink-0' />
              <span className='font-medium'>this deletes the wallet&apos;s scanned history</span>
            </div>
            <p className='mt-1.5 text-fg-muted'>
              every note zafu has found is dropped and the chain is read again from block{' '}
              <span className='tabular-nums'>{rescanConfirmHeight.toLocaleString()}</span>. it can
              take a long time, your balance reads zero until it finishes, and{' '}
              <span className='text-fg-high'>
                anything received before that block will not be found again
              </span>
              .
            </p>
            {!walletBirthday && (
              <p className='mt-1.5 text-fg-muted'>
                this wallet has no recorded birthday, so the scan starts at orchard activation — the
                earliest block that can hold a note. set a birthday in settings to make this faster.
              </p>
            )}
            <div className='mt-2.5 flex gap-2'>
              <button
                type='button'
                onClick={() => {
                  const h = rescanConfirmHeight;
                  setRescanConfirmHeight(null);
                  window.dispatchEvent(new CustomEvent('zcash-rescan', { detail: h }));
                }}
                className='rounded-md bg-hanko/15 px-2 py-1 text-hanko hover:bg-hanko/25'
              >
                rescan from {rescanConfirmHeight.toLocaleString()}
              </button>
              <button
                type='button'
                onClick={() => setRescanConfirmHeight(null)}
                className='rounded-md px-2 py-1 text-fg-muted hover:text-fg-high'
              >
                cancel
              </button>
            </div>
          </div>
        )}
        {/* the one sync surface: enso line + expandable detail (bar, stages,
            heights, rescan). Replaces the old status line + info card +
            progress card trio that repeated the same percent twice. */}
        <SyncStatus
          percent={overallPct}
          synced={allSynced}
          connecting={chainHeight <= 0}
          currentHeight={workerSyncHeight}
          targetHeight={chainHeight}
          startBlock={walletBirthday}
          stages={syncStages}
          firstSync={totalZat === 0n}
          error={syncError?.message}
          errorAction={
            syncError
              ? {
                  label: 'switch node',
                  onClick: () => navigate(`${PopupPath.SETTINGS_NETWORKS}?network=zcash`),
                }
              : undefined
          }
          onRetry={() => window.dispatchEvent(new Event('zcash-retry-sync'))}
          // same confirmation as the banner above — a hand-typed height is no
          // less destructive than a suggested one
          onRescan={h => setRescanConfirmHeight(rescanStartHeight(h))}
        />

        {/* per-pool reveal: click-driven only. Hover-expand made the corner
            chevron look dead (the panel was already open by the time you
            reached it) and it never worked on touch, where every one of these
            rows is a deep link. Three rows - ironwood (active), orchard
            (legacy), transparent (public) - each opening that pool's notes. */}
        <div
          className={cn(
            'grid transition-[grid-template-rows] duration-200',
            poolsPinned ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]',
          )}
        >
          <div className='overflow-hidden'>
            <div className='mt-3 flex flex-col gap-2 border-t border-border-soft pt-3'>
              {poolRows.map(row => (
                <div key={row.key} className='flex items-center justify-between gap-2'>
                  <button
                    type='button'
                    onClick={() => openPoolNotes(row.key === 'shielded' ? 'ironwood' : row.key)}
                    title={`view ${row.label} notes`}
                    className='group/row flex min-w-0 flex-1 items-center gap-2 text-left'
                  >
                    <span className={cn(row.icon, 'h-3.5 w-3.5 shrink-0 text-fg-muted')} />
                    <span className='text-xs text-fg-muted lowercase transition-colors group-hover/row:text-fg-high'>
                      {row.label}
                    </span>
                    {row.badge && (
                      <span className='rounded-sm bg-elev-2 px-1.5 py-0.5 text-label text-fg-dim leading-none lowercase'>
                        {row.badge}
                      </span>
                    )}
                    <span className='i-lucide-chevron-right h-3 w-3 shrink-0 text-fg-dim opacity-0 transition-opacity group-hover/row:opacity-100' />
                    <Sensitive className='ml-auto text-xs tabular text-fg-high'>
                      {`${fmtZec(Number(row.zat) / 1e8)} ZEC`}
                    </Sensitive>
                  </button>
                  {row.key === 'orchard' && ironwoodEligible && (
                    <button
                      onClick={() => setShowIronwoodMigrate(true)}
                      className='shrink-0 text-label font-medium text-network-accent transition-colors hover:text-fg-high'
                    >
                      migrate
                    </button>
                  )}
                </div>
              ))}
              <button
                type='button'
                onClick={() => openPoolNotes('transparent')}
                title='view transparent funds'
                className='group/row flex min-w-0 items-center gap-2 text-left'
              >
                <span className='i-lucide-eye h-3.5 w-3.5 shrink-0 text-fg-muted' />
                <span className='text-xs text-fg-muted lowercase transition-colors group-hover/row:text-fg-high'>
                  transparent
                </span>
                <span className='rounded-sm bg-elev-2 px-1.5 py-0.5 text-label text-fg-dim leading-none lowercase'>
                  public
                </span>
                <span className='i-lucide-chevron-right h-3 w-3 shrink-0 text-fg-dim opacity-0 transition-opacity group-hover/row:opacity-100' />
                <Sensitive className='ml-auto text-xs tabular text-fg-high'>
                  {`${fmtZec(Number(transparentZat) / 1e8)} ZEC`}
                </Sensitive>
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* action row directly under the balance - Zashi placement */}
      {actions}

      {/* single priority message slot */}
      {messageSlot}

      {/* small shield entry - replaces the old red alarming box; the full
          hot + zigner flow lives in ShieldTransparent */}
      {transparentZat > 0n && (
        <ShieldTransparent
          transparentZat={transparentZat}
          utxoLoading={utxoLoading}
          hasMnemonic={hasMnemonic}
          watchOnly={watchOnly}
          tAddresses={tAddresses}
          isMainnet={isMainnet}
          zidecarUrl={zidecarUrl}
        />
      )}

      {IRONWOOD_MIGRATION &&
        (chainTip?.height ?? 0) >= nu63ActivationHeight(isMainnet) &&
        showIronwoodMigrate &&
        selectedKeyInfo && (
          <IronwoodMigrate
            onClose={() => setShowIronwoodMigrate(false)}
            walletId={selectedKeyInfo.id}
            serverUrl={zidecarUrl}
            backend={zcashBackend}
            mainnet={isMainnet}
            accountIndex={0}
            ufvk={
              watchOnly?.ufvk ??
              (watchOnly?.orchardFvk?.startsWith('uview') ? watchOnly.orchardFvk : undefined)
            }
            orchardZat={pools.orchard > 0n ? pools.orchard : orchardZat}
            isHotWallet={selectedKeyInfo.type === 'mnemonic'}
            getMnemonic={
              selectedKeyInfo.type === 'mnemonic'
                ? async () => {
                    // gate the seed behind the password prompt, exactly like
                    // handleShield / zcash-send. Returns null on cancel so the
                    // migrate flow returns to review instead of building.
                    const authorized = await requestAuth();
                    if (!authorized) {
                      return null;
                    }
                    return keyRing.getMnemonic(selectedKeyInfo.id);
                  }
                : undefined
            }
          />
        )}

      {/* rescan lives in the sync detail panel attached to the balance */}
    </div>
  );
};

/** polkadot/kusama content */
const PolkadotContent = ({
  publicKey,
  relay = 'polkadot',
}: {
  publicKey?: string;
  relay?: 'polkadot' | 'kusama';
}) => {
  if (!publicKey) {
    return (
      <div className='flex flex-col items-center justify-center py-12 text-center'>
        <div className='text-sm text-fg-muted'>no {relay} wallet</div>
        <div className='text-xs text-fg-muted mt-1'>import a polkadot account to get started</div>
      </div>
    );
  }

  return (
    <div className='flex-1'>
      <Suspense fallback={<AssetListSkeleton rows={3} />}>
        <PolkadotAssets publicKey={publicKey} relay={relay} />
      </Suspense>
    </div>
  );
};

/** cosmos chain content - shows balances from public RPC */
const CosmosContent = ({ chainId }: { chainId: CosmosChainId }) => {
  const config = COSMOS_CHAINS[chainId];

  const { data: assetsData, isLoading, error } = useCosmosAssets(chainId, 0);

  if (error) {
    return (
      <div className='flex flex-col items-center justify-center py-12 text-center'>
        <div className='text-sm text-fg-muted'>failed to load balances</div>
        <div className='text-xs text-fg-muted mt-1'>
          {error instanceof Error ? error.message : 'unknown error'}
        </div>
      </div>
    );
  }

  if (!assetsData && !isLoading) {
    return (
      <div className='flex flex-col items-center justify-center py-12 text-center'>
        <div className='text-sm text-fg-muted'>
          enable transparent balance fetching in privacy settings to view {config.name} balances
        </div>
      </div>
    );
  }

  return (
    <div className='flex-1'>
      <div className='kicker mb-2'>assets</div>
      {isLoading ? (
        <AssetListSkeleton rows={2} />
      ) : assetsData?.assets.length === 0 ? (
        <div className='rounded-lg border border-border-soft bg-elev-1 p-4'>
          <div className='flex items-center justify-between'>
            <div className='flex items-center gap-2'>
              <div className='h-8 w-8 bg-elev-2 flex items-center justify-center'>
                <span className='text-sm font-bold'>{config.symbol[0]}</span>
              </div>
              <div>
                <div className='text-sm font-medium'>{config.symbol}</div>
                <div className='text-xs text-fg-muted'>{config.name}</div>
              </div>
            </div>
            <div className='text-right'>
              <Sensitive className='text-sm font-medium tabular-nums'>0 {config.symbol}</Sensitive>
            </div>
          </div>
        </div>
      ) : (
        <div className='flex flex-col gap-1'>
          {assetsData?.assets.map(asset => (
            <div key={asset.denom} className='rounded-lg border border-border-soft bg-elev-1 p-4'>
              <div className='flex items-center justify-between'>
                <div className='flex items-center gap-2'>
                  <div className='h-8 w-8 bg-elev-2 flex items-center justify-center'>
                    <span className='text-sm font-bold'>{asset.symbol[0]}</span>
                  </div>
                  <div>
                    <div className='text-sm font-medium'>{asset.symbol}</div>
                    <div className='text-xs text-fg-muted truncate max-w-[120px]'>
                      {asset.denom}
                    </div>
                  </div>
                </div>
                <div className='text-right'>
                  <Sensitive className='text-sm font-medium tabular-nums'>
                    {asset.formatted}
                  </Sensitive>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

// ── history ──

interface ParsedTransaction {
  id: string;
  height: number;
  timestamp: number | null;
  type: 'send' | 'receive' | 'shield' | 'swap' | 'delegate' | 'undelegate' | 'unknown';
  description: string;
  amount?: string;
  asset?: string;
  memo?: string;
  /**
   * Confirmation state, for transactions where we can tell the difference.
   * Absent means the entry came from a source that only ever reports settled
   * transactions (penumbra), and is treated as confirmed.
   */
  status?: 'pending' | 'confirmed' | 'failed';
  /** `amount` is a ceiling — change may exist but has not been scanned yet */
  amountUpperBound?: boolean;
  /** what the recipient got, excluding fee (amount = this + fee) */
  recipientAmount?: string;
  /** the fee paid, in ZEC, for the breakdown line */
  feeAmount?: string;
  /** who we sent it to, from our own record — the chain cannot recover this */
  recipient?: string;
  /** wall-clock ms at broadcast, used to date a row that has no height yet */
  sentAt?: number;
  /** penumbra account indices associated with this transaction (from visible actions) */
  accountIndices?: Set<number>;
}

/**
 * Icon-forward action button for the home action row (receive / swap /
 * send). Graphical at rest - just the icon, evenly spaced in a 3-column
 * grid under the balance - with the text label revealed on hover
 * (hover-expand plus a title tooltip). Zashi's few-big-obvious-actions,
 * without permanent text clutter.
 *
 * Variants:
 *   - default: subdued elev-2 background
 *   - zcash:   zigner-gold (primary outgoing action)
 *   - penumbra:penumbra-purple (primary outgoing action on penumbra)
 */
const ActionButton = ({
  icon,
  label,
  onClick,
  variant = 'default',
}: {
  icon: string;
  label: string;
  onClick: () => void;
  variant?: 'default' | 'zcash' | 'penumbra';
}) => (
  <button
    type='button'
    onClick={onClick}
    title={label}
    aria-label={label}
    className={cn(
      'group/action flex h-11 w-full items-center justify-center rounded-md px-3 transition-colors',
      variant === 'default' && 'bg-elev-2 text-fg hover:bg-elev-1/80 hover:text-fg-high',
      variant === 'zcash' && 'bg-zigner-gold text-zigner-dark hover:bg-primary/90',
      variant === 'penumbra' && 'bg-penumbra-purple text-white hover:bg-penumbra-purple-dark',
    )}
  >
    <span className={`${icon} h-5 w-5 shrink-0`} />
    <span className='max-w-0 overflow-hidden text-label lowercase leading-none tracking-[0.05em] whitespace-nowrap opacity-0 transition-all duration-200 group-hover/action:ml-2 group-hover/action:max-w-16 group-hover/action:opacity-100'>
      {label}
    </span>
  </button>
);

/**
 * First-sync reassurance - one of the message-slot candidates. Shown only
 * while actively syncing with no balance yet (the canonical new-user
 * state) so the user doesn't think the wallet is broken.
 */

/**
 * Empty-balance hint shown to a new user whose wallet is synced but
 * holds zero ZEC. Two concrete next steps so the wallet doesn't feel
 * like a dead end: receive (here's your address) and exchanges (where
 * to buy). A swap path was removed — the swap button sits directly
 * above this panel, and Penumbra DEX has no ZEC liquidity yet so the
 * old copy over-promised.
 *
 * Dismissable in the sense that any inbound ZEC makes the panel
 * disappear naturally — there is no manual hide because the panel is
 * informational and we want to nudge action.
 */
const GetZecHint = ({ onReceive }: { onReceive: () => void }) => (
  <div className='rounded-md border border-network-accent/15 bg-elev-1 p-4'>
    <div className='mb-3 flex items-center gap-2'>
      <span className='i-lucide-sparkles h-3.5 w-3.5 text-network-accent' />
      <span className='text-xs font-medium text-fg-high'>get your first zec</span>
    </div>

    <div className='flex flex-col gap-2'>
      <HintRow
        icon='i-lucide-arrow-down-to-line'
        title='receive from someone'
        hint='share your shielded address — works for any zec sender'
        onClick={onReceive}
      />
      <a
        href='https://z.cash/get-started/'
        target='_blank'
        rel='noopener noreferrer'
        className='group flex items-start gap-3 rounded-sm bg-elev-2/40 p-2.5 text-left transition-colors hover:bg-elev-2/60'
      >
        <span className='mt-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center bg-network-accent/10 text-network-accent'>
          <span className='i-lucide-shopping-bag h-3.5 w-3.5' />
        </span>
        <span className='flex flex-1 flex-col'>
          <span className='text-xs lowercase text-fg-high'>buy at an exchange</span>
          <span className='mt-0.5 text-label text-fg-muted lowercase'>
            z.cash list of supported exchanges
          </span>
        </span>
        <span className='i-lucide-external-link mt-1 h-3 w-3 shrink-0 text-fg-muted transition-colors group-hover:text-fg-high' />
      </a>
    </div>
  </div>
);

const HintRow = ({
  icon,
  title,
  hint,
  onClick,
}: {
  icon: string;
  title: string;
  hint: string;
  onClick: () => void;
}) => (
  <button
    type='button'
    onClick={onClick}
    className='group flex items-start gap-3 bg-elev-2/40 p-2.5 text-left transition-colors hover:bg-elev-2/60'
  >
    <span className='mt-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center bg-network-accent/10 text-network-accent'>
      <span className={`${icon} h-3.5 w-3.5`} />
    </span>
    <span className='flex flex-1 flex-col'>
      <span className='text-xs lowercase text-fg-high'>{title}</span>
      <span className='mt-0.5 text-label text-fg-muted lowercase'>{hint}</span>
    </span>
    <span className='i-lucide-arrow-right mt-1 h-3 w-3 shrink-0 text-fg-muted transition-transform duration-200 group-hover:translate-x-0.5' />
  </button>
);

/** extract account index from a visible note's decoded address view */
function noteAccountIndex(note: unknown): number | undefined {
  const n = note as
    | { address?: { addressView?: { case?: string; value?: { index?: { account?: number } } } } }
    | undefined;
  if (!n?.address?.addressView) {
    return undefined;
  }
  const av = n.address.addressView;
  if (av.case === 'decoded' && av.value?.index != null) {
    return av.value.index.account;
  }
  return undefined;
}

function parsePenumbraTx(txInfo: TransactionInfo): ParsedTransaction {
  const id = txInfo.id?.inner
    ? Array.from(txInfo.id.inner)
        .map(b => b.toString(16).padStart(2, '0'))
        .join('')
    : '';
  const height = Number(txInfo.height ?? 0);
  let type: ParsedTransaction['type'] = 'unknown';
  let description = 'transaction';
  let hasVisibleSpend = false;
  let hasOutput = false;
  const accountIndices = new Set<number>();

  for (const action of txInfo.view?.bodyView?.actionViews ?? []) {
    const c = action.actionView.case;
    if (c === 'spend' && action.actionView.value.spendView?.case === 'visible') {
      hasVisibleSpend = true;
      const idx = noteAccountIndex(action.actionView.value.spendView.value?.note);
      if (idx != null) {
        accountIndices.add(idx);
      }
    } else if (c === 'output') {
      hasOutput = true;
      const ov = action.actionView.value.outputView;
      if (ov?.case === 'visible') {
        const idx = noteAccountIndex(ov.value?.note);
        if (idx != null) {
          accountIndices.add(idx);
        }
      }
    } else if (c === 'swap') {
      type = 'swap';
      description = 'swap';
      // extract account from swap output notes (populated after claim)
      const sv = action.actionView.value.swapView;
      if (sv?.case === 'visible') {
        const v = sv.value as { output1?: unknown; output2?: unknown };
        for (const out of [v.output1, v.output2]) {
          const idx = noteAccountIndex(out);
          if (idx != null) {
            accountIndices.add(idx);
          }
        }
      }
    } else if (c === 'swapClaim') {
      type = 'swap';
      description = 'swap claim';
      // swap claims are separate txs with no spend/output actions - extract
      // account from the claim's output notes
      const scv = action.actionView.value.swapClaimView;
      if (scv?.case === 'visible') {
        const v = scv.value as { output1?: unknown; output2?: unknown };
        for (const out of [v.output1, v.output2]) {
          const idx = noteAccountIndex(out);
          if (idx != null) {
            accountIndices.add(idx);
          }
        }
      }
    } else if (c === 'delegate') {
      type = 'delegate';
      description = 'delegate';
    } else if (c === 'undelegate') {
      type = 'undelegate';
      description = 'undelegate';
    }
  }
  if (type === 'unknown') {
    if (hasVisibleSpend) {
      type = 'send';
      description = 'send';
    } else if (hasOutput) {
      type = 'receive';
      description = 'receive';
    }
  }

  // extract memo text if visible
  let memo: string | undefined;
  const memoView = txInfo.view?.bodyView?.memoView?.memoView;
  if (memoView?.case === 'visible' && memoView.value.plaintext?.text) {
    const text = memoView.value.plaintext.text.trim();
    if (text) {
      memo = text;
    }
  }

  return { id, height, timestamp: null, type, description, memo, accountIndices };
}

/** format ZEC with meaningful digits only — no trailing zeros, min 2 decimals */
function fmtZec(val: number): string {
  if (val === 0) {
    return '0';
  }
  const s = val.toFixed(8).replace(/0+$/, '').replace(/\.$/, '');
  // ensure at least 2 decimal places for readability
  const dot = s.indexOf('.');
  if (dot === -1) {
    return s + '.00';
  }
  const decimals = s.length - dot - 1;
  return decimals < 2 ? s + '0'.repeat(2 - decimals) : s;
}

function zatToZec(zat: bigint | string): string {
  const v = typeof zat === 'string' ? BigInt(zat) : zat;
  const w = v / 100_000_000n;
  const f = (v % 100_000_000n).toString().padStart(8, '0').replace(/0+$/, '') || '0';
  return `${w}.${f}`;
}

function fmtTime(ts: number | null): string {
  if (ts === null) {
    return '...';
  }
  const d = new Date(ts);
  const now = new Date();
  const diff = Math.floor(
    (new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() -
      new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()) /
      86400000,
  );
  const t = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (diff === 0) {
    return `today ${t}`;
  }
  if (diff === 1) {
    return `yesterday ${t}`;
  }
  if (diff < 7) {
    return `${d.toLocaleDateString([], { weekday: 'short' })} ${t}`;
  }
  return `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${t}`;
}

/**
 * The unsettled-transaction mark: the same ensō the sync line uses, drawn as
 * an open arc that never closes. Deliberately the *same* idiom rather than a
 * new one — "not finished yet" already has a visual language in this wallet,
 * and a spinner would shout where this whispers.
 */
const PendingMark = ({ className }: { className?: string }) => (
  <svg width='16' height='16' viewBox='0 0 16 16' className={cn('-rotate-90 shrink-0', className)}>
    <circle
      cx='8'
      cy='8'
      r='6.4'
      pathLength='100'
      fill='none'
      strokeWidth='1.8'
      strokeLinecap='round'
      strokeDasharray='100'
      strokeDashoffset='45'
      className='stroke-fg-dim'
    />
  </svg>
);

function TxRow({ tx }: { tx: ParsedTransaction }) {
  const [expanded, setExpanded] = useState(false);
  const isIn = tx.type === 'receive';
  const isSh = tx.type === 'shield';
  const isPending = tx.status === 'pending';
  const isFailed = tx.status === 'failed';
  // the recipient is only ever known for our own sends, and only from our own
  // record — it is worth a line of its own, so it opens the row like a memo
  const detail = tx.memo ?? (tx.recipient ? `to ${tx.recipient}` : undefined);
  // the amount/fee split is worth opening a row for on its own: it is what
  // explains why the balance moved by more than the payment
  const hasBreakdown = !!tx.recipientAmount && !!tx.feeAmount;
  const expandable = !!tx.memo || !!tx.recipient || hasBreakdown;

  return (
    <div
      className={cn(
        'rounded-lg border bg-elev-1 p-3 transition-colors',
        isFailed ? 'border-hanko/40' : 'border-border-soft',
        // pending rows recede rather than flash: they are not an alert, they
        // are simply not finished
        isPending && 'border-dashed',
        expandable ? 'cursor-pointer hover:border-border-soft' : '',
      )}
      onClick={expandable ? () => setExpanded(e => !e) : undefined}
    >
      <div className='flex items-center gap-3'>
        {/* direction reads from the lucide icon, not from color-as-category:
            shield / arrow-down / arrow-up on a neutral chip. An unsettled
            transaction shows the open ensō instead — the state matters more
            than the direction until it lands. */}
        <div className='flex h-8 w-8 items-center justify-center rounded-full bg-elev-2'>
          {isPending ? (
            <PendingMark />
          ) : isFailed ? (
            <span className='i-lucide-x h-4 w-4 text-hanko' />
          ) : isSh ? (
            <span className='i-lucide-shield h-4 w-4 text-fg-muted' />
          ) : isIn ? (
            <span className='i-lucide-arrow-down h-4 w-4 text-fg-high' />
          ) : (
            <span className='i-lucide-arrow-up h-4 w-4 text-fg-muted' />
          )}
        </div>
        <div className='flex-1 min-w-0'>
          <div className='flex items-center justify-between gap-2'>
            <span
              className={cn(
                'text-xs font-medium',
                isPending && 'text-fg-muted',
                isFailed && 'text-hanko',
              )}
            >
              {tx.description}
            </span>
            <div className='flex items-center gap-1'>
              {tx.amount && (
                <Sensitive
                  className={cn(
                    'text-xs font-mono',
                    isFailed && 'text-fg-dim line-through',
                    !isFailed && isIn && 'text-fg-high',
                    !isFailed && !isIn && 'text-fg-muted',
                  )}
                >
                  {/* the payment/fee split lives in the expanded row, not a
                      tooltip — a title attribute would show the amount even
                      with balances hidden */}
                  {/* "at most" rather than a confident figure: the change that
                      came back has not been scanned yet, so the true amount is
                      somewhere below this. Better vague than five times wrong. */}
                  {tx.amountUpperBound ? '≤ ' : isIn ? '+' : ''}
                  {tx.amount} {tx.asset ?? ''}
                </Sensitive>
              )}
              {expandable && (
                <span
                  className={cn(
                    'i-lucide-chevron-down h-3 w-3 text-fg-muted transition-transform',
                    expanded && 'rotate-180',
                  )}
                />
              )}
            </div>
          </div>
          <div className='flex items-center justify-between gap-2 mt-0.5'>
            <span className='text-label text-fg-muted font-mono truncate'>
              {tx.id.slice(0, 16)}...
            </span>
            {/* A row with no height has no block to name. Rather than print a
                confident-looking `#0`, say plainly what is and is not known:
                when we broadcast it, and that the chain has not answered. */}
            <span
              className={cn(
                'text-label whitespace-nowrap lowercase',
                isFailed ? 'text-hanko' : 'text-fg-muted',
              )}
            >
              {tx.height > 0
                ? `#${tx.height}`
                : isPending
                  ? `${fmtTime(tx.timestamp)} · unconfirmed`
                  : isFailed
                    ? 'expired'
                    : fmtTime(tx.timestamp)}
            </span>
          </div>
        </div>
      </div>
      {expanded && (detail || hasBreakdown) && (
        <div className='mt-2 ml-11 border-l-2 border-border-soft pl-3'>
          {detail && (
            <p className='text-xs text-fg-muted whitespace-pre-wrap break-words'>{detail}</p>
          )}
          {tx.memo && tx.recipient && (
            <p className='mt-1 text-label text-fg-dim break-words'>to {tx.recipient}</p>
          )}
          {/* where the money went, itemised — the difference between this and
              the note values spent is change, which never left the wallet */}
          {hasBreakdown && (
            <p className='mt-1 text-label text-fg-dim tabular'>
              <Sensitive>
                {tx.recipientAmount} {tx.asset ?? ''} sent · {tx.feeAmount} fee
              </Sensitive>
            </p>
          )}
        </div>
      )}
    </div>
  );
}

const HistoryContent = ({
  network,
  penumbraAccount,
}: {
  network: NetworkType;
  penumbraAccount: number;
}) => {
  const selectedKeyInfo = useStore(selectEffectiveKeyInfo);
  const zidecarUrl = useStore(s => s.networks.networks.zcash.endpoint) || 'https://zcash.rotko.net';
  const historyEnabled = useStore(s => s.privacy.settings.enableTransactionHistory);
  const messages = useStore(messagesSelector);
  const walletId = selectedKeyInfo?.id;
  const isMainnet = !zidecarUrl.includes('testnet');
  const { tAddresses } = useTransparentAddresses(isMainnet);
  const { workerSyncHeight } = useZcashSyncStatus();
  const { latestBlockHeight } = useSyncProgress();
  const queryClient = useQueryClient();

  // build txId→memo lookup from messages store (for zcash)
  const memoByTxId = useMemo(() => {
    const map = new Map<string, string>();
    for (const m of messages.getByNetwork(network as 'zcash' | 'penumbra')) {
      if (m.content) {
        map.set(m.txId, m.content);
      }
    }
    return map;
  }, [messages, network]);

  const setSetting = useStore(s => s.privacy.setSetting);

  // hooks must always be called in the same order - queries use `enabled` flag instead
  const penumbraQ = useQuery({
    queryKey: ['homeHistory', 'penumbra', penumbraAccount],
    enabled: network === 'penumbra' && historyEnabled,
    staleTime: 10_000,
    queryFn: async () => {
      const txs: ParsedTransaction[] = [];
      for await (const r of viewClient.transactionInfo({})) {
        if (r.txInfo) {
          txs.push(parsePenumbraTx(r.txInfo));
        }
      }
      const heights = [...new Set(txs.map(t => t.height))];
      const tsMap = new Map<number, number>();
      await Promise.all(
        heights.map(async h => {
          try {
            const { timestamp } = await sctClient.timestampByHeight({ height: BigInt(h) });
            if (timestamp) {
              tsMap.set(h, timestamp.toDate().getTime());
            }
          } catch {
            /* */
          }
        }),
      );
      for (const t of txs) {
        t.timestamp = tsMap.get(t.height) ?? null;
      }
      txs.sort((a, b) => b.height - a.height);
      return txs;
    },
  });

  const zcashQ = useQuery({
    queryKey: ['homeHistory', 'zcash', walletId, tAddresses.length],
    enabled: network === 'zcash' && !!walletId && historyEnabled,
    staleTime: 10_000,
    queryFn: async () => {
      if (!walletId) {
        return [];
      }
      const entries = await getHistoryInWorker('zcash', walletId, zidecarUrl, tAddresses);
      return entries.map(e => ({
        id: e.id,
        height: e.height,
        // a pending row has no block and therefore no block time; its broadcast
        // time is the only honest thing to date it by
        timestamp: e.sentAt ?? null,
        type: e.type as ParsedTransaction['type'],
        // The verb has to match the state. "sent" for something that may never
        // confirm is the overstatement that started all this.
        description:
          e.status === 'pending'
            ? e.kind === 'migrate'
              ? 'migrating'
              : e.kind === 'shield'
                ? 'shielding'
                : 'sending'
            : e.status === 'failed'
              ? 'did not confirm'
              : e.kind === 'migrate'
                ? 'migrated'
                : e.type === 'send'
                  ? 'sent'
                  : e.type === 'shield'
                    ? 'shielded'
                    : 'received',
        amount: zatToZec(BigInt(e.amount)),
        asset: e.asset,
        // our own record's memo is what the user actually typed; the scanned
        // one is only ever recoverable for incoming notes
        memo: e.memo ?? memoByTxId.get(e.id),
        status: e.status,
        amountUpperBound: e.amountUpperBound,
        recipientAmount: e.recipientAmount ? zatToZec(BigInt(e.recipientAmount)) : undefined,
        feeAmount: e.fee ? zatToZec(BigInt(e.fee)) : undefined,
        recipient: e.recipient,
        sentAt: e.sentAt,
      }));
    },
  });

  // refetch history when block heights advance (live update, no flicker)
  const prevPenumbraHeight = useRef(latestBlockHeight);
  const prevZcashHeight = useRef(workerSyncHeight);
  useEffect(() => {
    if (
      network === 'penumbra' &&
      latestBlockHeight &&
      latestBlockHeight !== prevPenumbraHeight.current
    ) {
      prevPenumbraHeight.current = latestBlockHeight;
      void queryClient.invalidateQueries({ queryKey: ['homeHistory', 'penumbra'] });
    }
    if (network === 'zcash' && workerSyncHeight && workerSyncHeight !== prevZcashHeight.current) {
      prevZcashHeight.current = workerSyncHeight;
      void queryClient.invalidateQueries({ queryKey: ['homeHistory', 'zcash'] });
    }
  }, [network, latestBlockHeight, workerSyncHeight, queryClient]);

  if (!historyEnabled) {
    return (
      <div className='flex items-center justify-center gap-2 px-4 py-4 text-label lowercase'>
        <span className='text-fg-muted/50'>history off</span>
        <span className='text-fg-muted/30'>·</span>
        <button
          onClick={() => void setSetting('enableTransactionHistory', true)}
          className='text-zigner-gold/70 transition-colors hover:text-zigner-gold'
        >
          enable
        </button>
      </div>
    );
  }

  const q = network === 'penumbra' ? penumbraQ : zcashQ;
  // for penumbra, filter by the selected account index - a tx belongs to an
  // account if any of its visible spend or output notes reference that index
  const allTxs = (q.data ?? []) as ParsedTransaction[];
  const txs =
    network === 'penumbra'
      ? allTxs.filter(
          tx =>
            !tx.accountIndices ||
            tx.accountIndices.size === 0 ||
            tx.accountIndices.has(penumbraAccount),
        )
      : allTxs;

  if (q.isLoading && txs.length === 0) {
    return (
      <div className='flex flex-col items-center justify-center gap-3 py-12'>
        <span className='i-lucide-refresh-cw h-5 w-5 animate-spin text-fg-muted' />
        <span className='text-xs text-fg-muted'>loading...</span>
      </div>
    );
  }

  if (q.error) {
    return (
      <div className='flex flex-col items-center justify-center gap-3 py-12'>
        <span className='text-xs text-red-400'>failed to load</span>
        <button
          onClick={() => void q.refetch()}
          className='text-xs text-zigner-gold hover:underline'
        >
          retry
        </button>
      </div>
    );
  }

  if (txs.length === 0) {
    return (
      <div className='flex flex-col items-center justify-center gap-3 py-12'>
        <span className='i-lucide-clock h-5 w-5 text-fg-muted' />
        <span className='text-xs text-fg-muted'>no transactions yet</span>
      </div>
    );
  }

  const recent = txs.slice(0, 20);

  return (
    <div className='flex flex-col gap-1'>
      <div className='mb-1'>
        <span className='kicker'>recent activity</span>
      </div>
      {recent.map(tx => (
        <TxRow key={tx.id} tx={tx} />
      ))}
      {txs.length > 20 && (
        <div className='py-2 text-center text-xs text-fg-muted'>
          {txs.length - 20} more transactions
        </div>
      )}
    </div>
  );
};

/** placeholder for networks not yet implemented */
const NetworkPlaceholder = ({ network }: { network: NetworkType }) => (
  <div className='flex flex-col items-center justify-center py-12 text-center'>
    <div className='text-sm text-fg-muted'>{network} support coming soon</div>
  </div>
);
