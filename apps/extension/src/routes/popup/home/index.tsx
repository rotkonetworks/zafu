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
} from '../../../state/keyring/network-worker';
import { usePoolBalances } from '../../../hooks/zcash-pool-balances';
import { ShieldTransparent } from '../../../components/zcash/shield-transparent';
import { IRONWOOD_MIGRATION, NU6_3_ACTIVATION_HEIGHT } from '../../../config/feature-flags';
import { IronwoodMigrationBanner, IronwoodMigrate } from '../send/ironwood-migrate';
import { COSMOS_CHAINS, type CosmosChainId } from '@repo/wallet/networks/cosmos/chains';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { viewClient, sctClient } from '../../../clients';
import { getDisplayDenomFromView } from '@penumbra-zone/getters/value-view';
import { fromValueView } from '@rotko/penumbra-types/amount';
import { getHistoryInWorker } from '../../../state/keyring/network-worker';
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

  // orchard balance from worker (zatoshi string)
  const [orchardZat, setOrchardZat] = useState(0n);

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
        .then(bal => setOrchardZat(BigInt(bal)))
        .catch(() => {});
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

  // NU6.3 turnstile migration flow (feature-flagged; see feature-flags.ts)
  const [showIronwoodMigrate, setShowIronwoodMigrate] = useState(false);
  // toggle to show sync detail panel when wallet is fully synced

  // rescan via custom event — terminate worker, clear IDB, let auto-sync restart
  useEffect(() => {
    const handler = async (e: Event) => {
      const height = (e as CustomEvent<number>).detail;
      if (!selectedKeyInfo) {
        return;
      }
      if (isNaN(height) || height < 0) {
        return;
      }

      try {
        const walletId = selectedKeyInfo.id;
        const birthdayKey = `zcashBirthday_${walletId}`;

        // terminate worker so in-memory commitment tree is dropped
        try {
          terminateNetworkWorker('zcash');
        } catch {}
        // delete IndexedDB to clear stale commitment tree
        try {
          indexedDB.deleteDatabase('zafu-zcash');
        } catch {}
        try {
          indexedDB.deleteDatabase('zafu-memo-cache');
        } catch {}
        // update birthday and clear persisted sync height
        await chrome.storage.local.set({ [birthdayKey]: height });
        await chrome.storage.local.remove('zcashSyncHeight');
        setWalletBirthday(height);
        setOrchardZat(0n);

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
    window.addEventListener('zcash-rescan', handler);
    return () => window.removeEventListener('zcash-rescan', handler);
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
  const scanPct = chainHeight > 0 ? Math.min(100, Math.round((scanProgress / scanRange) * 100)) : 0;

  // lightwalletd has no verification pipeline — synced once the scan catches up
  const allSynced =
    zcashBackend === 'lightwalletd' ? scanPct >= 100 : scanPct >= 100 && ligeritoPct >= 100;

  // Right after a birthday change the worker's last reported height can sit
  // at or below the new start height - that's 0 scan progress, not a reason
  // to fall back to the server pipeline pct (which reads 100% once the
  // pipeline is ready and made the bar claim "syncing 100.0%" with nothing
  // scanned yet).
  const scanNotStarted = workerSyncHeight > 0 && workerSyncHeight <= walletBirthday;

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
            state:
              ligeritoPct >= 100 ? 'done' : gigaproofStatus >= 1 ? 'active' : 'pending',
            detail:
              gigaproofStatus >= 2 && blocksUntilReady > 0
                ? `${blocksUntilReady} blocks`
                : 'proving',
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

  // NU6.3 turnstile: eligible once the flag is on, activation has passed,
  // and legacy orchard funds remain (per-pool split from the worker)
  const ironwoodEligible =
    IRONWOOD_MIGRATION && (chainTip?.height ?? 0) >= NU6_3_ACTIVATION_HEIGHT && pools.orchard > 0n;

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

  const { settings: privacySettings, setSetting: setPrivacySetting } = useStore(privacySelector);

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
      <div className='group rounded-md border border-network-accent/20 bg-elev-1 p-4'>
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
            title='pool detail'
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
            className='mt-1 block text-left text-display leading-none text-network-accent tabular transition-opacity hover:opacity-80'
          >
            <Sensitive>
              {workerSyncHeight > 0 || totalZat > 0n ? `${fmtZec(totalZec)} ZEC` : '— ZEC'}
            </Sensitive>
          </button>
        ) : (
          <div className='mt-1 text-display leading-none text-network-accent tabular'>
            <Sensitive>
              {workerSyncHeight > 0 || totalZat > 0n ? `${fmtZec(totalZec)} ZEC` : '— ZEC'}
            </Sensitive>
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
          onRescan={h => {
            window.dispatchEvent(new CustomEvent('zcash-rescan', { detail: h }));
          }}
        />

        {/* per-pool reveal: hover-expand, chevron pins it open for touch.
            Three rows - ironwood (active), orchard (legacy), transparent
            (public) - each deep-linking into the notes view for that pool. */}
        <div
          className={cn(
            'grid transition-[grid-template-rows] duration-200',
            poolsPinned ? 'grid-rows-[1fr]' : 'grid-rows-[0fr] group-hover:grid-rows-[1fr]',
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
        (chainTip?.height ?? 0) >= NU6_3_ACTIVATION_HEIGHT &&
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

function TxRow({ tx }: { tx: ParsedTransaction }) {
  const [expanded, setExpanded] = useState(false);
  const isIn = tx.type === 'receive';
  const isSh = tx.type === 'shield';
  const hasMemo = !!tx.memo;

  return (
    <div
      className={cn(
        'rounded-lg border border-border-soft bg-elev-1 p-3 transition-colors',
        hasMemo ? 'cursor-pointer hover:border-border-soft' : '',
      )}
      onClick={hasMemo ? () => setExpanded(e => !e) : undefined}
    >
      <div className='flex items-center gap-3'>
        {/* direction reads from the lucide icon, not from color-as-category:
            shield / arrow-down / arrow-up on a neutral chip */}
        <div className='flex h-8 w-8 items-center justify-center rounded-full bg-elev-2'>
          {isSh ? (
            <span className='i-lucide-shield h-4 w-4 text-fg-muted' />
          ) : isIn ? (
            <span className='i-lucide-arrow-down h-4 w-4 text-fg-high' />
          ) : (
            <span className='i-lucide-arrow-up h-4 w-4 text-fg-muted' />
          )}
        </div>
        <div className='flex-1 min-w-0'>
          <div className='flex items-center justify-between gap-2'>
            <span className='text-xs font-medium'>{tx.description}</span>
            <div className='flex items-center gap-1'>
              {tx.amount && (
                <Sensitive
                  className={cn('text-xs font-mono', isIn ? 'text-fg-high' : 'text-fg-muted')}
                >
                  {isIn ? '+' : ''}
                  {tx.amount} {tx.asset ?? ''}
                </Sensitive>
              )}
              {hasMemo && (
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
            <span className='text-label text-fg-muted whitespace-nowrap'>
              {tx.height > 0 ? `#${tx.height}` : fmtTime(tx.timestamp)}
            </span>
          </div>
        </div>
      </div>
      {expanded && tx.memo && (
        <div className='mt-2 ml-11 border-l-2 border-border-soft pl-3'>
          <p className='text-xs text-fg-muted whitespace-pre-wrap break-words'>{tx.memo}</p>
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
        timestamp: null,
        type: e.type as ParsedTransaction['type'],
        description: e.type === 'send' ? 'sent' : e.type === 'shield' ? 'shielded' : 'received',
        amount: zatToZec(BigInt(e.amount)),
        asset: e.asset,
        memo: memoByTxId.get(e.id),
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
