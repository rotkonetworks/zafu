import { useState, useEffect } from 'react';
import type { ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { useShallow } from 'zustand/react/shallow';

import { useStore } from '../../../state';
import { privacySelector } from '../../../state/privacy';
import { selectEffectiveKeyInfo, keyRingSelector } from '../../../state/keyring';
import { activeAccountIndex, activeZcashStoreId, activePockets } from '../../../state/pockets';
import { pocketStoreId } from '../../../state/pocket-id';
import { Sensitive } from '../../../components/sensitive';
import { PopupPath } from '../paths';
import { useTransparentAddresses } from '../../../hooks/use-transparent-addresses';
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
import { deleteZcashDatabases } from '../../../clear-cache-startup';
import { cn } from '@repo/ui/lib/utils';
import { SyncStatus, type SyncStage } from '../../../components/zcash/sync-status';
import { usePasswordGate } from '../../../hooks/password-gate';
import { Sheet } from '@repo/ui/components/ui/sheet';
import { Row, RowGroup } from '@repo/ui/components/ui/row';
import { Button } from '@repo/ui/components/ui/button';
import { fmtZec } from './format';
import { BalanceFigure } from './balance-figure';
import { GetZecHint } from './notices';

/** zcash-specific content — zashi-inspired combined balance */
export const ZcashContent = ({
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
  const {
    syncStatus,
    chainTip,
    workerSyncHeight,
    error: syncError,
    failure: syncFailure,
  } = useZcashSyncStatus();
  const navigate = useNavigate();

  const selectedKeyInfo = useStore(selectEffectiveKeyInfo);
  // the active pocket's own worker store and zip32 account
  const storeId = useStore(activeZcashStoreId);
  const pocketAccount = useStore(activeAccountIndex);
  const pockets = useStore(useShallow(activePockets));
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
    if (!storeId) {
      return;
    }

    const fetchBalance = () => {
      getBalanceInWorker('zcash', storeId)
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
      if (detail.walletId && detail.walletId !== storeId) {
        return;
      }
      fetchBalance();
    };

    window.addEventListener('network-sync-progress', handler);
    fetchBalance();
    return () => window.removeEventListener('network-sync-progress', handler);
  }, [storeId, workerSyncHeight]);

  // derive transparent addresses for UTXO lookup (shared hook with caching)
  const { tAddresses } = useTransparentAddresses(isMainnet);

  const { totalZat: transparentZat, isLoading: utxoLoading } = useTransparentBalance(tAddresses);

  // per-pool split (orchard legacy / ironwood active) - a permanent
  // RowGroup below the hero balance (board: "balances" section)
  const pools = usePoolBalances(storeId, workerSyncHeight);

  // Sends we have broadcast that the chain has not confirmed. Their inputs are
  // already deducted from the figure above (markNotesSpentLocally runs at
  // broadcast), so without this line the balance simply drops with nothing to
  // account for it.
  const pendingSends = usePendingSends(storeId, workerSyncHeight);

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
        const activeStoreId = pocketStoreId(walletId, pocketAccount);
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
        // stale value cannot outlive a rescan. Clears EVERY pocket's store,
        // not just the active one - a rescan drops the shared commitment
        // tree, so a stale hint for an inactive pocket would resume it from
        // a height the tree no longer has.
        const storeIds = pockets.length > 0 ? pockets.map(p => pocketStoreId(walletId, p.account)) : [walletId];
        await chrome.storage.local.remove([
          'zcashSyncHeight',
          ...storeIds.map(zcashSyncHeightKey),
        ]);
        setWalletBirthday(height);
        setOrchardZat(0n);
        setBalanceState('loading');

        // respawn worker and start sync — mark syncing immediately to prevent
        // auto-sync hook from racing with a duplicate sync
        await new Promise(r => setTimeout(r, 500));
        await spawnNetworkWorker('zcash');
        markWalletSyncing('zcash', activeStoreId);

        if (hasMnemonic && selectedKeyInfo.type === 'mnemonic') {
          const mnemonic = await keyRing.getMnemonic(walletId);
          // pass the configured backend - defaulting to zidecar here would
          // point a zidecar client at a lightwalletd endpoint (HTTP 415s)
          await startSyncInWorker(
            'zcash',
            activeStoreId,
            mnemonic,
            zidecarUrl,
            height,
            zcashBackend,
          );
        } else if (watchOnly) {
          const ufvkStr =
            watchOnly.ufvk ??
            (watchOnly.orchardFvk?.startsWith('uview') ? watchOnly.orchardFvk : undefined);
          if (ufvkStr) {
            await startWatchOnlySyncInWorker(
              'zcash',
              activeStoreId,
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
          const activeStoreId = pocketStoreId(walletId, pocketAccount);
          await spawnNetworkWorker('zcash');
          markWalletSyncing('zcash', activeStoreId);
          const resumeKey = zcashSyncHeightKey(activeStoreId);
          const resumeAt = (await chrome.storage.local.get(resumeKey))[resumeKey] as
            | number
            | undefined;
          if (hasMnemonic && selectedKeyInfo.type === 'mnemonic') {
            const mnemonic = await keyRing.getMnemonic(walletId);
            await startSyncInWorker(
              'zcash',
              activeStoreId,
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
                activeStoreId,
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
    pocketAccount,
    pockets,
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
  // Ranges for the stage tooltips. A stage that says what it does but not
  // what it covers leaves the obvious question unanswered - "verified from
  // where to where?" - and these numbers are already on hand.
  const hgt = (n: number) => n.toLocaleString();
  const serverIndexHeight = syncStatus?.currentHeight ?? 0;
  const scanRangeHint = scanNotStarted
    ? `nothing scanned yet. will cover blocks ${hgt(walletBirthday)} to ${hgt(chainHeight)}.`
    : `covered blocks ${hgt(walletBirthday)} to ${hgt(workerSyncHeight)}` +
      (chainHeight > 0 ? ` of ${hgt(chainHeight)}.` : '.');
  const nomtRangeHint =
    serverIndexHeight > 0 ? ` its index reaches block ${hgt(serverIndexHeight)}.` : '';
  const ligeritoRangeHint =
    lastGigaproofHeight > 0
      ? ` proven through block ${hgt(lastGigaproofHeight)}` +
        (chainHeight > 0 ? `, tip is ${hgt(chainHeight)}.` : '.')
      : ' no proven range yet.';

  // pipeline stages for the sync detail panel — a steady row instead of
  // the old flickering label rotation. lightwalletd skips verification.
  const syncStages: SyncStage[] =
    zcashBackend === 'lightwalletd'
      ? [
          {
            key: 'scan',
            label: 'scanning notes',
            icon: 'i-ph-magnifying-glass',
            iconDone: 'i-ph-magnifying-glass-fill',
            hint: `downloads blocks and trial-decrypts them here to find notes that are yours. private, but you fetch every block. ${scanRangeHint}`,
            state: scanPct >= 100 ? 'done' : scanPct > 0 ? 'active' : 'pending',
            detail: `${Math.floor(scanPct)}%`,
          },
        ]
      : [
          {
            key: 'nomt',
            label: 'nomt',
            icon: 'i-ph-tree-structure',
            iconDone: 'i-ph-tree-structure-fill',
            // NOT "checks" - nothing here verifies a proof. gigaproofStatus
            // is parsed straight out of the server's own response, so this
            // stage reports what the server says about itself.
            hint: `the server reports its state-tree index is built.${nomtRangeHint} the wallet does not yet check that claim.`,
            state: nomtPct >= 100 ? 'done' : 'active',
          },
          {
            key: 'ligerito',
            label: 'ligerito',
            icon: 'i-ph-seal-check',
            iconDone: 'i-ph-seal-check-fill',
            hint: `the server reports a completeness proof is ready.${ligeritoRangeHint} the wallet does not yet verify it - the proof is not checked here.`,
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
            icon: 'i-ph-magnifying-glass',
            iconDone: 'i-ph-magnifying-glass-fill',
            // Deliberately not the same sentence as the lightwalletd scan
            // stage. There you fetch every block yourself; here the two
            // stages above have already established that what the server
            // returned is complete, and this trial-decrypts that.
            hint: `trial-decrypts the blocks the server returned. only your wallet can tell which notes are yours. ${scanRangeHint}`,
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

  // combined balance - transparent funds fold into the single hero figure.
  // Pending shielded change (change from our own unconfirmed sends, e.g. the
  // ironwood change note of a send that has not mined yet — and a pending
  // turnstile migration's in-flight value moving orchard → the wallet's own
  // ironwood pool) is part of what the wallet holds — it is NOT spendable, but
  // it is not gone, and omitting it from the figure made a pending send (or
  // migrate) read as "0 in all pools". Include it; the breakdown below calls it
  // out as pending.
  const totalZat = orchardZat + transparentZat + pools.pendingTotal;
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
    .reduce((sum, t) => {
      // BigInt() throws on a malformed/decimal amount string (older or badly
      // serialized pending-send record); skip it rather than crash the home
      // screen (Zcash is the default network, so this is a first screen).
      try {
        return sum + BigInt(t.amount);
      } catch {
        return sum;
      }
    }, 0n);
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
  ) : allSynced && totalZat === 0n && inFlightZat === 0n ? (
    <GetZecHint onReceive={() => navigate(PopupPath.RECEIVE)} />
  ) : null;

  // Pool rows for the hero-card reveal. All three pools stay visible
  // (ironwood active / orchard legacy / transparent public below) so no
  // pool is ever hidden. Falls back to a single "shielded" row if the
  // worker's per-pool endpoint reports nothing while the combined balance
  // is positive (older worker builds).
  let poolRows =
    pools.total === 0n && orchardZat > 0n
      ? [
          {
            key: 'shielded',
            icon: 'i-ph-shield-check',
            label: 'shielded',
            badge: undefined as string | undefined,
            zat: orchardZat,
          },
        ]
      : [
          {
            key: 'ironwood',
            icon: 'i-ph-shield-check',
            label: 'ironwood',
            badge: undefined as string | undefined,
            zat: pools.ironwood,
          },
          {
            key: 'orchard',
            icon: 'i-ph-clock',
            label: 'orchard',
            badge: 'legacy' as string | undefined,
            zat: pools.orchard,
          },
        ];

  // Pending shielded change from our own unconfirmed sends is part of the
  // hero figure (total includes it) but is NOT spendable. Give it its own row
  // so the breakdown reconciles with the figure above instead of showing a
  // smaller number with no explanation — the case that read as "0 in all
  // pools" while an ironwood send was pending.
  if (pools.pendingTotal > 0n) {
    poolRows.push({
      key: 'pending',
      icon: 'i-ph-hourglass',
      label: 'pending',
      badge: 'change · confirming' as string | undefined,
      zat: pools.pendingTotal,
    });
  }

  // glance -> detail: the hero balance opens the full per-pool notes view;
  // each reveal row deep-links to its pool ('shielded' fallback -> ironwood)
  const openPoolNotes = (pool?: string) => {
    if (!IRONWOOD_MIGRATION) {
      return; // route is registered only when the flag is on
    }
    if (pool === 'pending') {
      return; // pending change is not a pool's note list yet; row is informational
    }
    navigate(pool ? `${PopupPath.POOL_NOTES}?pool=${pool}` : PopupPath.POOL_NOTES);
  };

  return (
    <div className='flex-1 flex flex-col gap-3'>
      {PasswordModal}
      {/* hero balance - the single figure on this screen. The per-pool
          split is a permanent RowGroup below (board: "balances" section),
          not a reveal-on-tap - nothing on this screen expands in place. */}
      <div className='rounded-md border border-network-accent/20 bg-elev-1 p-4'>
        <div className='flex items-center justify-between'>
          <span className='kicker'>balance</span>
          {/* the global hide-balances control lives where you notice you
              need it — same state as settings → privacy, effective on
              every amount in the app. The one hide/show eye on this screen. */}
          <button
            onClick={() => void setPrivacySetting('hideBalances', !privacySettings.hideBalances)}
            title={privacySettings.hideBalances ? 'show balances' : 'hide balances'}
            className='p-0.5 text-fg-dim transition-colors hover:text-fg-high'
          >
            <span
              className={cn(
                'block h-3.5 w-3.5',
                privacySettings.hideBalances ? 'i-ph-eye-slash' : 'i-ph-eye',
              )}
            />
          </button>
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
            <span className='i-ph-arrow-up h-3 w-3 shrink-0' />
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
            <span className='i-ph-warning h-3 w-3 shrink-0' />
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
            step at all. A Sheet, not an inline card: nothing on this screen
            expands in place. */}
        <Sheet
          open={rescanConfirmHeight !== null}
          onOpenChange={open => {
            if (!open) {
              setRescanConfirmHeight(null);
            }
          }}
          title="this deletes the wallet's scanned history"
        >
          {rescanConfirmHeight !== null && (
            <div className='flex flex-col gap-3 text-label leading-snug'>
              <p className='text-fg-muted'>
                every note zafu has found is dropped and the chain is read again from block{' '}
                <span className='tabular-nums'>{rescanConfirmHeight.toLocaleString()}</span>. it can
                take a long time, your balance reads zero until it finishes, and{' '}
                <span className='text-fg-high'>
                  anything received before that block will not be found again
                </span>
                .
              </p>
              {!walletBirthday && (
                <p className='text-fg-muted'>
                  this wallet has no recorded birthday, so the scan starts at orchard activation -
                  the earliest block that can hold a note. set a birthday in settings to make this
                  faster.
                </p>
              )}
              <div className='flex gap-2'>
                <Button
                  variant='danger'
                  onClick={() => {
                    const h = rescanConfirmHeight;
                    setRescanConfirmHeight(null);
                    window.dispatchEvent(new CustomEvent('zcash-rescan', { detail: h }));
                  }}
                >
                  rescan from {rescanConfirmHeight.toLocaleString()}
                </Button>
                <Button variant='secondary' onClick={() => setRescanConfirmHeight(null)}>
                  cancel
                </Button>
              </div>
            </div>
          )}
        </Sheet>
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
          // Only the classified message is ever shown; the raw error goes
          // behind the "technical details" disclosure. See state/sync-failure.ts.
          error={syncFailure?.message}
          errorDetail={syncFailure?.raw}
          // The action comes from the taxonomy, so a LOCAL failure (storage,
          // or anything we could not classify) no longer tells the user to
          // switch nodes — blaming the endpoint for the wallet's own problem
          // is how people end up chasing a working node forever.
          errorAction={
            syncFailure?.action
              ? {
                  label: syncFailure.action.label,
                  onClick: () => {
                    if (syncFailure.action?.kind === 'settings') {
                      navigate(`${PopupPath.SETTINGS_NETWORKS}?network=zcash`);
                    } else if (syncFailure.action?.kind === 'reload') {
                      window.location.reload();
                    } else {
                      window.dispatchEvent(new Event('zcash-retry-sync'));
                    }
                  },
                }
              : undefined
          }
          onRetry={() => window.dispatchEvent(new Event('zcash-retry-sync'))}
          // same confirmation as the banner above — a hand-typed height is no
          // less destructive than a suggested one
          onRescan={h => setRescanConfirmHeight(rescanStartHeight(h))}
        />
      </div>

      {/* action row directly under the balance - Zashi placement */}
      {actions}

      {/* single priority message slot */}
      {messageSlot}

      {/* balances: a permanent bordered list, never a reveal-on-tap. Three
          rows - ironwood (active) / orchard (legacy), transparent (public) -
          each a deep link to that pool's notes; migrate/shield surface as a
          trailing button on their row. `Row`'s value is a plain string, so
          hide-balances masks it the same way `Sensitive` does elsewhere on
          this screen - a constant-width dot mask, not the real figure. */}
      <RowGroup>
        {poolRows.map(row => (
          <div key={row.key} className='flex items-center'>
            <Row
              type='value'
              icon={row.icon}
              label={row.label}
              description={row.badge}
              value={
                privacySettings.hideBalances ? '•••••' : `${fmtZec(Number(row.zat) / 1e8)} ZEC`
              }
              className='flex-1 min-w-0'
              onPress={() => openPoolNotes(row.key === 'shielded' ? 'ironwood' : row.key)}
            />
            {row.key === 'orchard' && ironwoodEligible && (
              <Button
                variant='secondary'
                size='sm'
                className='mr-3.5 shrink-0'
                onClick={() => setShowIronwoodMigrate(true)}
              >
                migrate
              </Button>
            )}
          </div>
        ))}
        <div className='flex items-center'>
          <Row
            type='value'
            icon='i-ph-lock-simple-open'
            label='transparent'
            description='public'
            value={
              privacySettings.hideBalances ? '•••••' : `${fmtZec(Number(transparentZat) / 1e8)} ZEC`
            }
            className='flex-1 min-w-0'
            onPress={() => openPoolNotes('transparent')}
          />
        </div>
      </RowGroup>

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
            walletId={storeId ?? selectedKeyInfo.id}
            serverUrl={zidecarUrl}
            backend={zcashBackend}
            mainnet={isMainnet}
            accountIndex={pocketAccount}
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
