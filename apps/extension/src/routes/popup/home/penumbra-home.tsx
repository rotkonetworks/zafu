import { Fragment, lazy, Suspense, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CopyButton } from '@repo/ui/components/ui/copy-button';
import { Row, RowGroup } from '@repo/ui/components/ui/row';
import { Sheet } from '@repo/ui/components/ui/sheet';
import { StatusSlot } from '@repo/ui/components/ui/status-slot';
import { InFlightCard } from '../../../components/in-flight-card';
import { Sensitive } from '../../../components/sensitive';
import { usePenumbraRowsInUsd, usePenumbraTotalIn } from '../../../hooks/penumbra-total-in';
import { useFixedPrices } from '../../../hooks/penumbra-prices';
import { useSyncProgress } from '../../../hooks/full-sync-height';
import { CAUGHT_UP_BLOCKS } from '../../../hooks/latest-block-height';
import { runPercent } from '../../../penumbra/start';
import { PenumbraStartSheet } from '../../../components/wallet/penumbra-start-sheet';
import { balancesQueryOptions, balancesQueryKey } from '../../../hooks/penumbra-balances';
import { classifySyncFailure } from '../../../state/sync-failure';
import { PopupPath } from '../paths';
import { AskHistorySheet, HistoryContent } from './history';
import { HOME_LOOK } from './look';
import {
  fmtAmount,
  fmtFigure,
  fmtIn,
  heroOf,
  localPrices,
  selectHome,
  unpricedOf,
  valueOf,
  type Asset,
  type TotalIn,
} from './penumbra-value';
import { combine, type Book } from '../../../penumbra/price';
import { QUOTES } from '../../../penumbra/quotes';
import { SyncStrip } from '../../../components/wallet/sync-strip';
import { EmptyBox, HomeScreen } from './home-screen';
import { BalanceGroup, BalanceRow, Tile } from '../../../components/wallet/balance-rows';
import type { BalanceView } from '../../../components/wallet/balance-hero';

// the transparent chains under penumbra; lazy so other homes don't pay the chunk
const CosmosSubwallets = lazy(() =>
  import('./cosmos-subwallets').then(m => ({ default: m.CosmosSubwallets })),
);

const look = HOME_LOOK.penumbra;

const Line = ({ label, children }: { label: string; children: ReactNode }) => (
  <div className='flex min-h-12 items-center justify-between gap-3 px-3.5 text-[13px]'>
    <span className='text-fg-muted'>{label}</span>
    <span className='truncate text-fg-high tabular'>{children}</span>
  </div>
);

/** one asset's price on the dex in both quotes, or that it has none */
const priceLine = (a: Asset, book?: Book<TotalIn>) =>
  (['usd', 'um'] as const)
    .flatMap(q => {
      const v = valueOf(a, book?.[q]);
      return v && !(q === 'um' && a.um) ? [fmtIn(v.price, q, true)] : [];
    })
    .join(' · ') || 'no price on the dex';

/** send or swap one asset, see its price, or copy the id of one zafu cannot name */
const AssetSheet = ({
  asset,
  book,
  onClose,
}: {
  asset?: Asset;
  book?: Book<TotalIn>;
  onClose: () => void;
}) => {
  const navigate = useNavigate();
  const base = asset?.base;
  return (
    <Sheet
      open={!!asset}
      onOpenChange={o => !o && onClose()}
      title={asset?.name.toLowerCase() ?? ''}
    >
      {asset && (
        <RowGroup>
          {book && <Line label={`1 ${asset.symbol.toLowerCase()}`}>{priceLine(asset, book)}</Line>}
          {base && (
            <>
              <Row
                type='screen'
                icon='i-lucide-arrow-up'
                label={`send ${asset.symbol.toLowerCase()}`}
                onPress={() => navigate(PopupPath.SEND, { state: { prefillAsset: base } })}
              />
              <Row
                type='screen'
                icon='i-lucide-arrow-left-right'
                label={`swap ${asset.symbol.toLowerCase()}`}
                onPress={() => navigate(PopupPath.SWAP, { state: { prefillFromAsset: base } })}
              />
            </>
          )}
          {asset.rawId && (
            <div className='flex min-h-12 items-center gap-2 px-3.5'>
              <span className='min-w-0 flex-1 truncate font-mono text-[11px] text-fg-muted'>
                {asset.rawId}
              </span>
              <CopyButton text={asset.rawId} className='h-8 px-1' />
            </div>
          )}
        </RowGroup>
      )}
    </Sheet>
  );
};

/** the hero's usd | um: tap to show the total in the other (the same setting as "total in") */
const TotalInToggle = ({
  totalIn,
  onChange,
}: {
  totalIn: TotalIn;
  onChange: (t: TotalIn) => void;
}) => {
  const other = totalIn === 'usd' ? 'um' : 'usd';
  return (
    <button
      onClick={() => onChange(other)}
      aria-label={`show the total in ${other}`}
      className='-my-3 flex items-center gap-1 py-3 pl-2 text-[11px] tracking-[0.04em]'
    >
      {(['usd', 'um'] as const).map((u, i) => (
        <Fragment key={u}>
          {i > 0 && <span className='text-fg-dim'>|</span>}
          <span className={u === totalIn ? 'text-fg-high' : 'text-fg-dim hover:text-fg-muted'}>
            {u}
          </span>
        </Fragment>
      ))}
    </button>
  );
};

/** what the total leaves out, said next to it: unpriced assets and positions, in a sheet */
const NotCounted = ({ unpriced, positions }: { unpriced: Asset[]; positions: number }) => {
  const [open, setOpen] = useState(false);
  const n = unpriced.length + positions;
  return n === 0 ? null : (
    <>
      <button
        onClick={() => setOpen(true)}
        className='-my-3 py-3 text-[11px] text-fg-dim hover:text-fg-muted'
      >
        {n} not counted
      </button>
      <Sheet open={open} onOpenChange={setOpen} title='not in the total'>
        <RowGroup>
          {unpriced.map(a => (
            <Line key={a.key} label={a.name.toLowerCase()}>
              no price on the dex
            </Line>
          ))}
          {positions > 0 && <Line label='staked, unbonding and liquidity'>{positions}</Line>}
        </RowGroup>
      </Sheet>
    </>
  );
};

/** one balance: tap the figures to see them in usd, tap the rest for send and swap */
const AssetRow = ({
  asset: a,
  usd,
  onOpen,
}: {
  asset: Asset;
  usd?: Book<TotalIn>['usd'];
  onOpen: () => void;
}) => {
  const { inUsd, toggle } = usePenumbraRowsInUsd();
  const v = valueOf(a, usd);
  const showUsd = !!v && !!a.unit && inUsd.includes(a.unit.id);
  const [top, under] = showUsd
    ? [fmtIn(v.value, 'usd'), `${fmtAmount(a.amount)} ${a.symbol.toLowerCase()}`]
    : [fmtAmount(a.amount), v ? fmtIn(v.value, 'usd') : usd && 'no price'];
  return (
    <BalanceRow
      tile={<Tile tone={a.um ? 'accent' : 'quiet'}>{a.symbol.slice(0, 2)}</Tile>}
      label={a.name}
      tag={
        v ? `${a.symbol.toLowerCase()} · ${fmtIn(v.price, 'usd', true)}` : a.symbol.toLowerCase()
      }
      onPress={onOpen}
      action={
        <button
          onClick={() => a.unit && toggle(a.unit.id)}
          disabled={!v}
          aria-label={`show ${a.symbol.toLowerCase()} in ${showUsd ? 'its own amount' : 'usd'}`}
          className='flex h-full shrink-0 flex-col items-end justify-center gap-[3px] pl-2'
        >
          <Sensitive className='text-sm text-fg-high tabular'>{top}</Sensitive>
          {under && <Sensitive className='text-[11px] text-fg-muted'>{under}</Sensitive>}
        </button>
      }
    />
  );
};

/** penumbra home: the shared home, read from the view service */
export const PenumbraContent = ({ account, nudge }: { account: number; nudge?: ReactNode }) => {
  const queryClient = useQueryClient();
  const { tip, height, from, ask, walletId, error: syncError } = useSyncProgress();
  const [later, setLater] = useState(false);
  // the shared RAW balances cache (preload, send, swap read it too); this
  // screen's view of it is the fungible rows
  const { data, isLoading, error, refetch } = useQuery({
    ...balancesQueryOptions(account),
    staleTime: 5_000,
    select: selectHome,
  });
  const assets = data?.assets;
  const [open, setOpen] = useState<Asset>();

  // refresh when the synced height advances (no flicker)
  const prevHeight = useRef(height);
  useEffect(() => {
    if (height && height !== prevHeight.current) {
      prevHeight.current = height;
      void queryClient.invalidateQueries({ queryKey: balancesQueryKey(account) });
    }
  }, [height, account, queryClient]);

  const synced = height ?? 0;
  const caughtUp = tip > 0 && height !== undefined && tip - height <= CAUGHT_UP_BLOCKS;
  const { totalIn, setTotalIn } = usePenumbraTotalIn();
  // recorded prices first; the fixed dex pass (same for every wallet) once read to the tip
  const fixed = useFixedPrices(caughtUp);
  const book =
    assets && (fixed.data || fixed.isError)
      ? combine(QUOTES, localPrices(assets), fixed.data?.book)
      : undefined;
  const hero = heroOf(assets ?? [], book?.[totalIn], totalIn);
  const funded = (assets ?? []).some(a => a.amount > 0);
  const view: BalanceView = ask
    ? 'unknown'
    : error && !assets
      ? 'error'
      : isLoading
        ? 'loading'
        : caughtUp
          ? 'ready'
          : funded
            ? 'partial'
            : 'unknown';
  const empty = view === 'ready' && !funded;

  return (
    <HomeScreen
      look={look}
      strip={
        <SyncStrip
          network='penumbra'
          synced={caughtUp}
          failure={syncError ? classifySyncFailure(syncError) : null}
          percent={runPercent(synced, from, tip)}
          connecting={!tip || height === undefined}
          currentHeight={synced}
          targetHeight={tip}
          startBlock={from}
          notice={
            ask
              ? {
                  tone: 'gold',
                  text: 'sync waits to hear where to start',
                  action: { label: 'choose', onClick: () => setLater(false) },
                }
              : undefined
          }
          onRetry={() => void queryClient.invalidateQueries({ queryKey: ['latestBlockHeight'] })}
        />
      }
      view={view}
      amount={fmtFigure(hero.amount, hero.unit)}
      unit={hero.unit}
      hint={hero.unit === 'usd' ? 'in usdc.inj on penumbra' : undefined}
      control={
        funded && (
          <span className='ml-auto flex items-center gap-3'>
            <NotCounted
              unpriced={unpricedOf(assets ?? [], book?.[totalIn])}
              positions={data?.positions ?? 0}
            />
            <TotalInToggle totalIn={totalIn} onChange={t => void setTotalIn(t)} />
          </span>
        )
      }
      spendable={funded}
      watermark={!empty}
    >
      <InFlightCard />
      {nudge}

      {view === 'error' ? (
        <StatusSlot
          tone='warn'
          icon='i-ph-warning'
          action={{ label: 'try again', onClick: () => void refetch() }}
        >
          your balances did not load · nothing is lost
        </StatusSlot>
      ) : view === 'loading' ? null : empty ? (
        <EmptyBox look={look} />
      ) : (
        assets &&
        assets.length > 0 && (
          <BalanceGroup heading={look.heading}>
            {assets.map(a => (
              <AssetRow key={a.key} asset={a} usd={book?.usd} onOpen={() => setOpen(a)} />
            ))}
          </BalanceGroup>
        )
      )}

      {/* the transparent chains tied to the same key, checked only on request.
          Not split by Penumbra account: burners use the wallet's own derivation. */}
      <Suspense fallback={null}>
        <CosmosSubwallets />
      </Suspense>

      <HistoryContent network='penumbra' penumbraAccount={account} limit={3} />

      <RowGroup>
        <Row
          type='screen'
          icon='i-ph-chart-line-up'
          label='trade on penumbra.fi'
          onPress={() => window.open('https://penumbra.fi', '_blank', 'noopener,noreferrer')}
        />
      </RowGroup>

      <AssetSheet asset={open} book={book} onClose={() => setOpen(undefined)} />
      <AskHistorySheet hasFunds={funded} />
      <PenumbraStartSheet walletId={walletId} open={ask && !later} onClose={() => setLater(true)} />
    </HomeScreen>
  );
};
