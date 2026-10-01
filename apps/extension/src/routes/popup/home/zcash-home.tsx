import { useState, useEffect } from 'react';
import type { ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';

import { useStore } from '../../../state';
import { contactsSelector } from '../../../state/contacts';
import { selectEffectiveKeyInfo, keyRingSelector } from '../../../state/keyring';
import { selectActiveZcashWallet } from '../../../state/wallets';
import { CAPS, walletKind } from '../../../signing/wallet-kind';
import {
  activeAccountIndex,
  activeZcashStoreId,
  activePocketBirthday,
} from '../../../state/pockets';
import { Sensitive } from '../../../components/sensitive';
import { PopupPath } from '../paths';
import { useTransparentAddresses } from '../../../hooks/use-transparent-addresses';
import { useZcashSyncStatus } from '../../../hooks/zcash-sync';
import { useTransparentBalance } from '../../../hooks/zcash-transparent-balance';
import { getBalanceInWorker, type HistoryEntry } from '../../../state/keyring/network-worker';
import { usePendingSends, usePoolBalances } from '../../../hooks/zcash-pool-balances';
import { ShieldTransparent } from '../../../components/zcash/shield-transparent';
import { InFlightCard, PendingLine } from '../../../components/in-flight-card';
import { IRONWOOD_MIGRATION, nu63ActivationHeight } from '../../../config/feature-flags';
import { rescanStartHeight } from '../../../utils/zcash-blocks';
import { rescanZcash, retryZcashSync } from '../../../services/zcash-resync';
import { IronwoodMigrate } from '../send/ironwood-migrate';
import { usePasswordGate } from '../../../hooks/password-gate';
import { Sheet } from '@repo/ui/components/ui/sheet';
import { StatusSlot } from '@repo/ui/components/ui/status-slot';
import { Button } from '@repo/ui/components/ui/button';
import { fmtZecHero } from './format';
import { HistoryContent, AskHistorySheet } from './history';
import { HOME_LOOK } from './look';
import { SyncStrip } from '../../../components/wallet/sync-strip';
import { EmptyBox, HomeScreen } from './home-screen';
import { BalanceGroup, BalanceRow, Tile } from '../../../components/wallet/balance-rows';
import type { BalanceView } from '../../../components/wallet/balance-hero';
import { MultisigOverview } from './multisig-overview';

const zec = (zat: bigint) => fmtZecHero(Number(zat) / 1e8);

/** BigInt() throws on a malformed amount string from an older record */
const zatOf = (s: string | undefined): bigint => {
  try {
    return BigInt(s ?? 0);
  } catch {
    return 0n;
  }
};

/** what an unconfirmed send is doing, in its own words */
const PENDING_VERB: Record<NonNullable<HistoryEntry['kind']>, string> = {
  send: 'sending',
  shield: 'shielding',
  migrate: 'moving to ironwood',
};

/** zcash home: sync strip, hero balance, actions, in-flight, pools, activity */
export const ZcashContent = ({
  hasMnemonic,
  watchOnly,
  nudge,
}: {
  hasMnemonic?: boolean;
  watchOnly?: { label: string; mainnet: boolean; orchardFvk?: string; ufvk?: string; id?: string };
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
  // the turnstile migration is an ironwood build on the zigner QR: offered
  // only to a signer that reads it (not keystone, ledger, frost or a viewing key)
  const zcashWallet = useStore(selectActiveZcashWallet);
  const kind = selectedKeyInfo && walletKind(selectedKeyInfo, zcashWallet);
  // the active pocket's own worker store and zip32 account
  const storeId = useStore(activeZcashStoreId);
  const pocketAccount = useStore(activeAccountIndex);
  // a pocket's own birthday (the chain tip when it was created); undefined
  // for account 0 or a pocket that recorded none, meaning "use the wallet's"
  const pocketBirthday = useStore(activePocketBirthday);
  const keyRing = useStore(keyRingSelector);
  const { requestAuth, PasswordModal } = usePasswordGate();
  // hooks stay above the no-wallet early return below
  const { findByAddress } = useStore(contactsSelector);
  const [shieldOpen, setShieldOpen] = useState(false);

  // shielded balance from worker (zatoshi string)
  const [shieldedZat, setShieldedZat] = useState(0n);
  // Whether that figure means anything yet. `0n` is both "no funds" and "not
  // asked yet"; conflating them rendered a bare dash that read as "your
  // money is gone".
  const [balanceState, setBalanceState] = useState<'loading' | 'ready' | 'error'>('loading');

  // wallet birthday - used to show progress relative to start, not block 0
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

  // sync lifecycle is managed by useZcashAutoSync in PopupLayout; this reads
  // status and balance, re-fetched on sync progress and height changes
  useEffect(() => {
    if (!storeId) {
      return;
    }

    const fetchBalance = () => {
      getBalanceInWorker('zcash', storeId)
        .then(bal => {
          setShieldedZat(BigInt(bal));
          setBalanceState('ready');
        })
        .catch(() => {
          // keep a figure we already had - a worker hiccup is not evidence
          // the balance changed - but stop presenting it as current
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

  // per-pool split (orchard legacy / ironwood active)
  const pools = usePoolBalances(storeId, workerSyncHeight);

  // Sends broadcast but not confirmed. Their inputs are already deducted from
  // the figure (markNotesSpentLocally runs at broadcast); these lines say why.
  const pendingSends = usePendingSends(storeId, workerSyncHeight);

  // NU6.3 turnstile migration flow (feature-flagged; see feature-flags.ts)
  const [showIronwoodMigrate, setShowIronwoodMigrate] = useState(false);
  // Height a rescan has been REQUESTED for but not yet confirmed. A rescan
  // deletes the note database, so it does not happen on one click.
  const [rescanConfirmHeight, setRescanConfirmHeight] = useState<number | null>(null);

  const rescan = (h: number) =>
    void rescanZcash(h)
      .then(height => {
        if (height !== undefined) {
          setWalletBirthday(height);
          setShieldedZat(0n);
          setBalanceState('loading');
        }
      })
      .catch(err => console.error('[zcash] rescan failed:', err));
  const retry = () =>
    void retryZcashSync().catch(err => console.error('[zcash] sync retry failed:', err));

  // pending shielded change (our own unconfirmed sends, a pending migrate) is
  // held, not spendable, and not gone - so it counts in the figure
  const shieldedTotal = shieldedZat + pools.pendingTotal;
  const totalZat = shieldedTotal + transparentZat;

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

  const chainHeight = chainTip?.height ?? syncStatus?.currentHeight ?? 0;
  // A pocket's own birthday is the scan floor once it has one: its notes
  // cannot predate its creation. Account 0 falls back to the wallet's.
  const effectiveBirthday = pocketBirthday ?? walletBirthday;
  const scanRange = Math.max(1, chainHeight - effectiveBirthday);
  const scanProgress = Math.max(0, workerSyncHeight - effectiveBirthday);
  const caughtUp = chainHeight > 0 && workerSyncHeight >= chainHeight;
  // Synced means every block up to the tip was scanned - that is what makes
  // the balance correct. Server-side proof status trails it and is not a
  // reason to read "syncing" forever. FLOOR, never round: 99.5% is not done.
  const allSynced = chainHeight > 0 && scanProgress >= scanRange;
  // workerSyncHeight at or below the start means nothing scanned yet; the
  // server's own pipeline says nothing about this wallet's balance.
  const overallPct = caughtUp ? 100 : Math.min(100, (scanProgress / scanRange) * 100);

  const balanceView: BalanceView =
    balanceState === 'error' && totalZat === 0n
      ? 'error'
      : balanceState === 'loading' && totalZat === 0n
        ? 'loading'
        : allSynced
          ? 'ready'
          : totalZat === 0n
            ? 'unknown'
            : 'partial';

  const inFlight = pendingSends.filter(t => t.status === 'pending');
  const failedSends = pendingSends.filter(t => t.status === 'failed');
  const empty = totalZat === 0n && inFlight.length === 0 && balanceState === 'ready';
  const reading = totalZat === 0n && balanceState === 'loading';

  // NU6.3 turnstile: eligible once the flag is on, activation has passed,
  // and legacy orchard funds remain
  const ironwoodLive =
    IRONWOOD_MIGRATION && (chainTip?.height ?? 0) >= nu63ActivationHeight(isMainnet);
  const ironwoodEligible =
    ironwoodLive && kind !== undefined && CAPS[kind].migrate && pools.orchard > 0n;

  // one message at a time: ironwood move > backup nudge
  const messageSlot: ReactNode = ironwoodEligible ? (
    <StatusSlot
      tone='gold'
      icon='i-lucide-arrow-right-left'
      action={{ label: 'move to ironwood', onClick: () => setShowIronwoodMigrate(true) }}
    >
      <span className='text-fg-high'>
        orchard is closing · <Sensitive className='tabular'>{zec(pools.orchard)}</Sensitive> zec
      </span>
    </StatusSlot>
  ) : (
    nudge
  );

  // the pool rows deep-link to their notes; the route exists only with the flag
  const openPoolNotes = IRONWOOD_MIGRATION
    ? (pool: string) => () => navigate(`${PopupPath.POOL_NOTES}?pool=${pool}`)
    : () => undefined;

  const nameOf = (addr?: string) =>
    addr && (findByAddress(addr)?.contact.name ?? `${addr.slice(0, 8)}…${addr.slice(-4)}`);

  return (
    <HomeScreen
      look={HOME_LOOK.zcash}
      strip={
        <SyncStrip
          network='zcash'
          rebuilds
          synced={allSynced}
          failure={syncError ? syncFailure : null}
          percent={overallPct}
          connecting={chainHeight <= 0}
          currentHeight={workerSyncHeight}
          targetHeight={chainHeight}
          startBlock={effectiveBirthday}
          onRetry={retry}
          onRescan={h => setRescanConfirmHeight(rescanStartHeight(h))}
        />
      }
      view={balanceView}
      amount={zec(totalZat)}
      spendable={totalZat > 0n}
      watermark={!empty}
    >
      {PasswordModal}
      <InFlightCard>
        {(inFlight.length > 0 || failedSends.length > 0) && (
          <>
            {inFlight.map(t => (
              <PendingLine
                key={t.id}
                tone='gold'
                icon='i-zafu-enso'
                title={
                  <>
                    {PENDING_VERB[t.kind ?? 'send']}{' '}
                    <Sensitive className='tabular'>
                      {zec(zatOf(t.recipientAmount ?? t.amount))}
                    </Sensitive>
                    {t.kind !== 'migrate' && t.recipient && ` to ${nameOf(t.recipient)}`}
                  </>
                }
                status='waiting for a block'
              />
            ))}
            {failedSends.length > 0 && (
              // the inputs were marked spent at broadcast and are held until
              // the chain is re-read; saying "your funds are back" would be a lie
              <PendingLine
                tone='danger'
                icon='i-ph-warning'
                title={
                  failedSends.length === 1
                    ? 'a payment was not mined in time'
                    : `${failedSends.length} payments were not mined in time`
                }
                status='its zec is held until the chain is read again'
                // never the chain tip: orchard activation (or the pocket's own
                // birthday) can never hide a note
                action={{
                  label: 'read again',
                  onClick: () =>
                    setRescanConfirmHeight(rescanStartHeight(effectiveBirthday || null)),
                }}
              />
            )}
          </>
        )}
      </InFlightCard>

      {messageSlot}

      {reading || balanceView === 'error' ? null : empty ? (
        <EmptyBox look={HOME_LOOK.zcash} />
      ) : (
        <BalanceGroup heading={HOME_LOOK.zcash.heading}>
          <BalanceRow
            tile={<Tile tone='accent'>z</Tile>}
            label='shielded'
            tag={
              <span className='flex items-center gap-1 text-[11px] text-fg-muted'>
                <span className='i-lucide-shield size-[11px]' />
                private
              </span>
            }
            amount={zec(shieldedTotal)}
            onPress={openPoolNotes('ironwood')}
          />
          <BalanceRow
            tile={<Tile tone='warn'>t</Tile>}
            label='transparent'
            tag={<span className='text-[11px] text-warn'>public</span>}
            amount={zec(transparentZat)}
            onPress={openPoolNotes('transparent')}
            action={
              transparentZat > 0n && (
                <Button
                  variant='secondary'
                  size='sm'
                  className='shrink-0 border-surface-border text-network-accent'
                  onClick={() => setShieldOpen(true)}
                >
                  shield
                </Button>
              )
            }
          />
        </BalanceGroup>
      )}

      <MultisigOverview />

      <HistoryContent network='zcash' penumbraAccount={0} limit={3} />

      {/* the shield flow (hot one-tap or zigner QR) rises in a sheet - the
          transparent row never grows */}
      <Sheet open={shieldOpen} onOpenChange={setShieldOpen} title='shield'>
        <ShieldTransparent
          transparentZat={transparentZat}
          utxoLoading={utxoLoading}
          hasMnemonic={hasMnemonic}
          watchOnly={watchOnly}
          tAddresses={tAddresses}
          isMainnet={isMainnet}
          zidecarUrl={zidecarUrl}
        />
      </Sheet>

      {/* the first payment: keep a history on this computer, or only the balance */}
      <AskHistorySheet hasFunds={totalZat > 0n} />

      {/* Rescan confirmation: it drops every scanned note and re-reads the
          chain from `height` upward, so the cost is stated before it runs. */}
      <Sheet
        open={rescanConfirmHeight !== null}
        onOpenChange={open => !open && setRescanConfirmHeight(null)}
        title='read the chain again?'
      >
        {rescanConfirmHeight !== null && (
          <div className='flex flex-col gap-3 text-xs leading-snug'>
            <p className='text-fg-muted'>
              zafu forgets what it has found and reads again from block{' '}
              <span className='tabular text-fg-high'>{rescanConfirmHeight.toLocaleString()}</span>.
              your balance reads zero until it finishes, and{' '}
              <span className='text-fg-high'>
                anything received before that block is not found again
              </span>
              .
            </p>
            <Button
              variant='danger'
              onClick={() => {
                const h = rescanConfirmHeight;
                setRescanConfirmHeight(null);
                rescan(h);
              }}
            >
              read again from {rescanConfirmHeight.toLocaleString()}
            </Button>
            <Button variant='secondary' onClick={() => setRescanConfirmHeight(null)}>
              not now
            </Button>
          </div>
        )}
      </Sheet>

      {ironwoodLive && showIronwoodMigrate && selectedKeyInfo && (
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
          orchardZat={pools.orchard > 0n ? pools.orchard : shieldedZat}
          isHotWallet={kind === 'hot'}
          getVaultUnlock={
            kind === 'hot'
              ? async () => {
                  // behind the password prompt, like shield and send; null on
                  // cancel returns the flow to review
                  const authorized = await requestAuth();
                  return authorized ? keyRing.getVaultUnlock(selectedKeyInfo.id) : null;
                }
              : undefined
          }
        />
      )}
    </HomeScreen>
  );
};
