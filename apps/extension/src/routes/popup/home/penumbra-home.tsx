import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
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
import { balancesQueryOptions, balancesQueryKey } from '../../../hooks/penumbra-balances';
import { classifySyncFailure } from '../../../state/sync-failure';
import { AskHistorySheet, HistoryContent } from './history';
import { HOME_LOOK } from './look';
import {
  fmtAmount,
  fmtFigure,
  fmtIn,
  heroOf,
  localPrices,
  selectHome,
  valueOf,
  type Asset,
  type TotalIn,
} from './penumbra-value';
import { combine, type Book } from '../../../penumbra/price';
import { QUOTES } from '../../../penumbra/quotes';
import { SyncStrip } from '../../../components/wallet/sync-strip';
import { EmptyBox, HomeScreen } from './home-screen';
import {
  BalanceGroup,
  BalanceRow,
  LineActions,
  Tile,
  type LineAction,
} from '../../../components/wallet/balance-rows';
import { useOpenIntent } from '../../../hooks/open-link';
import { useTransparent } from './transparent-lines';
import { homeFixture } from './fixture';
import type { BalanceView } from '../../../components/wallet/balance-hero';

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

/** a token's ways to move, each one link through the router */
const MOVES = [
  ['send', 'i-lucide-arrow-up'],
  ['swap', 'i-lucide-arrow-left-right'],
  ['unshield', 'i-ph-shield-slash'],
] as const;

/** what a token sheet is about: a shielded asset, or one found only on a deposit address */
type Token = { asset: Asset } | { symbol: string };
const symbolOf = (t: Token) => ('asset' in t ? t.asset.symbol : t.symbol);

/** one token's whole control: price, shielded amount, its deposit addresses, every move */
const TokenSheet = ({
  token,
  book,
  transparent,
  onClose,
}: {
  token?: Token;
  book?: Book<TotalIn>;
  transparent: ReturnType<typeof useTransparent>;
  onClose: () => void;
}) => {
  const open = useOpenIntent();
  const asset = token && 'asset' in token ? token.asset : undefined;
  const symbol = token ? symbolOf(token).toLowerCase() : '';
  const base = asset?.base;
  const move = (action: 'send' | 'swap' | 'unshield') =>
    base && open({ kind: 'move', move: { action, asset: base } });
  const shield = transparent.shieldButton(symbol);
  const lines = token ? transparent.chainLines(symbol) : null;
  return (
    <Sheet
      open={!!token}
      onOpenChange={o => !o && onClose()}
      title={asset?.name.toLowerCase() ?? symbol}
    >
      {token && (
        <>
          <RowGroup>
            {asset && book && <Line label={`1 ${symbol}`}>{priceLine(asset, book)}</Line>}
            <Line label='shielded'>
              <Sensitive>{`${asset ? fmtAmount(asset.amount) : '0'} ${symbol}`}</Sensitive>
            </Line>
          </RowGroup>
          {Array.isArray(lines) && lines.length > 0 && (
            <section className='flex flex-col gap-1.5'>
              <h2 className='text-[11px] tracking-[0.04em] text-fg-muted'>on deposit addresses</h2>
              <div className='flex flex-col border border-border-soft bg-elev-1'>{lines}</div>
            </section>
          )}
          <RowGroup>
            {base &&
              MOVES.map(([action, icon]) => (
                <Row
                  key={action}
                  type='screen'
                  icon={icon}
                  label={`${action} ${symbol}`}
                  onPress={() => move(action)}
                />
              ))}
            {shield && (
              <Row type='screen' icon={shield.icon} label={shield.label} onPress={shield.onPress} />
            )}
            {asset?.rawId && (
              <div className='flex min-h-12 items-center gap-2 px-3.5'>
                <span className='min-w-0 flex-1 truncate font-mono text-[11px] text-fg-muted'>
                  {asset.rawId}
                </span>
                <CopyButton text={asset.rawId} className='h-8 px-1' />
              </div>
            )}
          </RowGroup>
        </>
      )}
    </Sheet>
  );
};

/** one token: tap the figures to see them in usd, tap the rest for its sheet */
export const AssetRow = ({
  asset: a,
  usd,
  onOpen,
  shield,
}: {
  asset: Asset;
  usd?: Book<TotalIn>['usd'];
  onOpen: () => void;
  /** a check found it on a deposit address: one small button to shield it */
  shield?: LineAction;
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
      tag={a.symbol.toLowerCase()}
      onPress={onOpen}
      action={
        <>
          <button
            onClick={() => a.unit && toggle(a.unit.id)}
            disabled={!v}
            aria-label={`show ${a.symbol.toLowerCase()} in ${showUsd ? 'its own amount' : 'usd'}`}
            className='flex h-full shrink-0 flex-col items-end justify-center gap-[3px] pl-2'
          >
            <Sensitive className='text-sm text-fg-high tabular'>{top}</Sensitive>
            {under && <Sensitive className='text-[11px] text-fg-muted'>{under}</Sensitive>}
          </button>
          {shield && <LineActions actions={[shield]} />}
        </>
      }
    />
  );
};

/** penumbra home: the shared home, read from the view service */
export const PenumbraContent = ({ account, nudge }: { account: number; nudge?: ReactNode }) => {
  const queryClient = useQueryClient();
  const transparent = useTransparent();
  const { tip, height, from, error: syncError } = useSyncProgress();
  // the shared RAW balances cache (preload, send, swap read it too); this
  // screen's view of it is the fungible rows
  const { data, isLoading, error, refetch } = useQuery({
    ...balancesQueryOptions(account),
    staleTime: 5_000,
    select: selectHome,
  });
  const [fixture] = useState(homeFixture);
  const assets = fixture?.assets ?? data?.assets;
  const [open, setOpen] = useState<Token>();

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
  const { totalIn } = usePenumbraTotalIn();
  // recorded prices first; the fixed dex pass (same for every wallet) once read to the tip
  const fixed = useFixedPrices(caughtUp);
  const book =
    fixture?.book ??
    (assets && (fixed.data || fixed.isError)
      ? combine(QUOTES, localPrices(assets), fixed.data?.book)
      : undefined);
  const hero = heroOf(assets ?? [], book?.[totalIn], totalIn);
  const held = (assets ?? []).filter(a => a.amount > 0).length;
  const funded = held > 0;
  const view: BalanceView = fixture
    ? 'ready'
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
          onRetry={() => void queryClient.invalidateQueries({ queryKey: ['latestBlockHeight'] })}
        />
      }
      view={view}
      amount={fmtFigure(hero.amount, hero.unit)}
      unit={hero.unit}
      note={held ? `${held} ${held === 1 ? 'asset' : 'assets'} · shielded` : undefined}
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
      ) : view === 'loading' ? null : (
        <>
          {/* a token waiting on a deposit address is something: no empty box over it */}
          {empty && !transparent.onlyThere([]).length && <EmptyBox look={look} />}
          {/* one row per token; its deposit addresses live in its sheet */}
          {(!empty || transparent.onlyThere([]).length > 0) && (
            <BalanceGroup heading={look.heading}>
              {!empty &&
                assets?.map(a => (
                  <AssetRow
                    key={a.key}
                    asset={a}
                    usd={book?.usd}
                    onOpen={() => setOpen({ asset: a })}
                    shield={transparent.shieldButton(a.symbol)}
                  />
                ))}
              {transparent.onlyThere(empty ? [] : (assets ?? []).map(a => a.symbol)).map(s => (
                <BalanceRow
                  key={s}
                  tile={<Tile tone='quiet'>{s.slice(0, 2)}</Tile>}
                  label={s}
                  tag='nothing shielded yet'
                  amount={transparent.found(s)}
                  onPress={() => setOpen({ symbol: s })}
                  action={<LineActions actions={[transparent.shieldButton(s)!]} />}
                />
              ))}
            </BalanceGroup>
          )}
          {transparent.sheet}
        </>
      )}

      <HistoryContent network='penumbra' penumbraAccount={account} limit={3} />

      <TokenSheet
        token={open}
        book={book}
        transparent={transparent}
        onClose={() => setOpen(undefined)}
      />
      <AskHistorySheet hasFunds={funded} />
    </HomeScreen>
  );
};
