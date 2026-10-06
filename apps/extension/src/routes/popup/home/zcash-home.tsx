import { useEffect, useState } from 'react';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';

import { useStore } from '../../../state';
import { selectZcashBackend } from '../../../state/networks';
import { contactsSelector } from '../../../state/contacts';
import {
  selectEffectiveKeyInfo,
  keyRingSelector,
  selectPenumbraOnly,
} from '../../../state/keyring';
import { selectActiveZcashWallet, selectZcashIsMainnet } from '../../../state/wallets';
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
import { newTip } from '../../../transparent/zcash-check';
import { ago } from '../../../transparent/chain-check';
import type { HistoryEntry } from '../../../state/keyring/network-worker';
import {
  EMPTY_POOL_BALANCES,
  useWorkerValue,
  zcashBirthdayQuery,
  zcashWorkerQuery,
} from '../../../hooks/zcash-pool-balances';
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
import {
  BalanceGroup,
  BalanceRow,
  LineActions,
  Tile,
} from '../../../components/wallet/balance-rows';
import type { BalanceView } from '../../../components/wallet/balance-hero';
import { SharedWallets } from './shared-wallets';
import { Row, RowGroup } from '@repo/ui/components/ui/row';
import { BuyInFlight } from '../../../components/buy-in-flight';
import { SwapInFlight } from '../../../components/swap-in-flight';
import { BUY_PRELOAD, openBuyPage } from '../../../buy/open';
import { LP_PRELOAD, openLpPage } from '../../../lp/open';
import { LpCard, LpWave } from '../../../components/lp-card';
import { PAY_APPS } from '../../../buy/apps';

const zec = (zat: bigint) => fmtZecHero(Number(zat) / 1e8);

const NO_PENDING: HistoryEntry[] = [];

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
  const isMainnet = useStore(selectZcashIsMainnet);
  const zidecarUrl = useStore(s => s.networks.networks.zcash.endpoint) || 'https://zcash.rotko.net';
  const zcashBackend = useStore(selectZcashBackend);
  const {
    chainTip,
    workerSyncHeight,
    error: syncError,
    failure: syncFailure,
    notesPreparing,
  } = useZcashSyncStatus();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const selectedKeyInfo = useStore(selectEffectiveKeyInfo);
  const penumbraOnly = useStore(selectPenumbraOnly);
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
  const [zecOpen, setZecOpen] = useState(false);

  // shielded balance from the worker, cached per pocket store and re-read on
  // sync progress and height changes. No figure yet is "loading" (`0n` is
  // both "no funds" and "not asked yet"; conflating them read as "your money
  // is gone"); a failed re-read keeps the figure it had. A pocket switch keeps
  // the last pocket's figure on screen, dimmed, until this pocket's lands
  // (the pocket sheet's intent preload usually has it cached already).
  const balance = useWorkerValue(
    { ...zcashWorkerQuery.balance(storeId), placeholderData: keepPreviousData },
    workerSyncHeight,
  );
  const shieldedZat = balance.data ?? 0n;
  const balanceState = balance.data !== undefined ? 'ready' : balance.isError ? 'error' : 'loading';

  // wallet birthday - used to show progress relative to start, not block 0
  const birthdayQuery = zcashBirthdayQuery(hasWallet ? selectedKeyInfo?.id : undefined);
  const walletBirthday = useQuery(birthdayQuery).data ?? 0;

  // the transparent figure is the last check: asked on intent, never on a timer
  const { tAddresses } = useTransparentAddresses(isMainnet);
  const transparent = useTransparentBalance(tAddresses);
  const transparentZat = transparent.last?.zat ?? 0n;
  const tip = chainTip?.height ?? 0;
  const eachBlock = useStore(s => s.privacy.settings.zcashTransparentEachBlock);
  // opted in: each new tip the sync sees asks again, only while zafu is open
  const lastRead = transparent.last !== undefined;
  useEffect(() => {
    if (lastRead && newTip(eachBlock, tip, transparent.last)) {
      transparent.check(tip);
    }
  }, [lastRead, eachBlock, tip, tAddresses.length]);

  // per-pool split (orchard legacy / ironwood active)
  const poolsQ = useWorkerValue(
    { ...zcashWorkerQuery.pools(storeId), placeholderData: keepPreviousData },
    workerSyncHeight,
  );
  const pools = poolsQ.data ?? EMPTY_POOL_BALANCES;

  // Sends broadcast but not confirmed. Their inputs are already deducted from
  // the figure (markNotesSpentLocally runs at broadcast); these lines say why.
  // Never another pocket's: these are not carried over a switch.
  const pendingSends =
    useWorkerValue(zcashWorkerQuery.pending(storeId), workerSyncHeight).data ?? NO_PENDING;

  // the figures still show the pocket switched away from: dimmed, never current
  const held = balance.isPlaceholderData || poolsQ.isPlaceholderData;

  // NU6.3 turnstile migration flow (feature-flagged; see feature-flags.ts)
  const [showIronwoodMigrate, setShowIronwoodMigrate] = useState(false);
  // Height a rescan has been REQUESTED for but not yet confirmed. A rescan
  // deletes the note database, so it does not happen on one click.
  const [rescanConfirmHeight, setRescanConfirmHeight] = useState<number | null>(null);

  const rescan = (h: number) =>
    void rescanZcash(h)
      .then(height => {
        if (height !== undefined) {
          queryClient.setQueryData(birthdayQuery.queryKey, height);
          void queryClient.resetQueries({ queryKey: zcashWorkerQuery.balance(storeId).queryKey });
        }
      })
      .catch(err => console.error('[zcash] rescan failed:', err));

  // pending shielded change (our own unconfirmed sends, a pending migrate) is
  // held, not spendable, and not gone - so it counts in the figure
  const shieldedTotal = shieldedZat + pools.pendingTotal;
  const totalZat = shieldedTotal + transparentZat;

  if (!hasWallet) {
    return (
      <div className='flex flex-col items-center justify-center py-12 text-center'>
        {penumbraOnly ? (
          <div className='text-sm text-fg-muted'>this wallet is for penumbra only</div>
        ) : (
          <>
            <div className='text-sm text-fg-muted'>no zcash wallet</div>
            <div className='text-xs text-fg-muted mt-1'>
              create a wallet or import a viewing key from zigner
            </div>
          </>
        )}
      </div>
    );
  }

  const chainHeight = chainTip?.height ?? 0;
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

  const balanceView: BalanceView = held
    ? 'held'
    : balanceState === 'error' && totalZat === 0n
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
  // a swap or lp address was handed out and never checked: keep its row and its
  // "check now" on screen rather than calling the pocket empty
  const tUnchecked = transparent.last === null && tAddresses.length > 1;
  const empty = totalZat === 0n && inFlight.length === 0 && balanceState === 'ready' && !tUnchecked;
  const reading = totalZat === 0n && balanceState === 'loading';

  // NU6.3 turnstile: eligible once the flag is on, activation has passed,
  // and legacy orchard funds remain
  const ironwoodLive =
    IRONWOOD_MIGRATION && (chainTip?.height ?? 0) >= nu63ActivationHeight(isMainnet);
  const ironwoodEligible =
    ironwoodLive && kind !== undefined && CAPS[kind].migrate && pools.orchard > 0n;

  // a signer that cannot spend legacy orchard says so instead of offering the move
  const orchardRefusal =
    ironwoodLive && pools.orchard > 0n && kind ? CAPS[kind].refuses?.orchard : undefined;

  // one message at a time: ironwood move > orchard waits > backup nudge
  const messageSlot: ReactNode = orchardRefusal ? (
    <StatusSlot icon='i-ph-lock-simple'>
      <span className='text-fg-high'>
        {orchardRefusal.title} · <Sensitive className='tabular'>{zec(pools.orchard)}</Sensitive> zec
      </span>
    </StatusSlot>
  ) : ironwoodEligible ? (
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
          preparing={notesPreparing}
          percent={overallPct}
          connecting={chainHeight <= 0}
          currentHeight={workerSyncHeight}
          targetHeight={chainHeight}
          startBlock={effectiveBirthday}
          onRetry={retryZcashSync}
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
      <BuyInFlight />
      <SwapInFlight />

      {messageSlot}

      {reading || balanceView === 'error' ? null : empty ? (
        <EmptyBox look={HOME_LOOK.zcash} />
      ) : (
        <BalanceGroup heading={HOME_LOOK.zcash.heading} held={held}>
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
            onPress={() => setZecOpen(true)}
          />
          <BalanceRow
            tile={<Tile tone='warn'>t</Tile>}
            label='transparent'
            tag={
              <span className='truncate text-[11px] text-fg-muted'>
                <span className='text-warn'>public</span>
                {transparent.checking ? ' · checking' : transparent.failed && ' · no answer'}
              </span>
            }
            amount={transparent.last ? zec(transparentZat) : undefined}
            note={
              transparent.last && (
                <span className='text-[11px] text-fg-muted'>
                  checked {ago(transparent.last.at)}
                </span>
              )
            }
            onPress={openPoolNotes('transparent')}
            action={
              <>
                <LineActions
                  actions={[
                    {
                      icon: 'i-lucide-refresh-cw',
                      label: 'check now',
                      onPress: () => transparent.check(tip),
                      busy: transparent.checking,
                    },
                  ]}
                />
                {transparentZat > 0n && (
                  <Button
                    variant='secondary'
                    size='sm'
                    className='shrink-0 border-surface-border text-network-accent'
                    onClick={() => {
                      setShieldOpen(true);
                      transparent.check(tip);
                    }}
                  >
                    shield
                  </Button>
                )}
              </>
            }
          />
        </BalanceGroup>
      )}

      {hasMnemonic && <LpCard storeId={storeId} />}

      <SharedWallets />

      <HistoryContent network='zcash' penumbraAccount={0} limit={3} />

      {/* the shield flow (hot one-tap or zigner QR) rises in a sheet - the
          transparent row never grows */}
      {/* the zec row: buying with cash first, then what moves zec */}
      <Sheet open={zecOpen} onOpenChange={setZecOpen} title='zec · shielded'>
        <RowGroup>
          <Row
            type='screen'
            media={<Tile tone='accent'>+</Tile>}
            label='buy with cash'
            preload={BUY_PRELOAD}
            description={PAY_APPS.filter(a => !a.off)
              .map(a => a.name)
              .join(', ')}
            onPress={openBuyPage}
          />
          <Row
            type='screen'
            label='swap'
            description='to or from another coin'
            onPress={() => navigate(PopupPath.SWAP)}
          />
          {hasMnemonic && (
            <Row
              type='screen'
              className='bg-zigner-gold/10'
              media={
                <span className='grid size-[30px] shrink-0 place-items-center border border-zigner-gold'>
                  <LpWave />
                </span>
              }
              label='provide liquidity'
              preload={LP_PRELOAD}
              description="thorchain's zec pool · earns swap fees"
              onPress={openLpPage}
            />
          )}
          {totalZat > 0n && (
            <Row type='screen' label='send' onPress={() => navigate(PopupPath.SEND)} />
          )}
          <Row type='screen' label='receive' onPress={() => navigate(PopupPath.RECEIVE)} />
          {IRONWOOD_MIGRATION && (
            <Row type='screen' label='notes' onPress={() => void openPoolNotes('ironwood')?.()} />
          )}
        </RowGroup>
      </Sheet>

      <Sheet open={shieldOpen} onOpenChange={setShieldOpen} title='shield'>
        <ShieldTransparent
          transparentZat={transparentZat}
          utxoLoading={transparent.checking}
          hasMnemonic={hasMnemonic}
          watchOnly={watchOnly}
          tAddresses={tAddresses}
          funded={transparent.last?.funded}
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
