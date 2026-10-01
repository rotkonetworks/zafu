import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CopyButton } from '@repo/ui/components/ui/copy-button';
import { Row, RowGroup } from '@repo/ui/components/ui/row';
import { Sheet } from '@repo/ui/components/ui/sheet';
import { StatusSlot } from '@repo/ui/components/ui/status-slot';
import { InFlightCard } from '../../../components/in-flight-card';
import { useSyncProgress } from '../../../hooks/full-sync-height';
import { balancesQueryOptions, balancesQueryKey } from '../../../hooks/penumbra-balances';
import { classifySyncFailure } from '../../../state/sync-failure';
import { PopupPath } from '../paths';
import { AskHistorySheet, HistoryContent } from './history';
import { HOME_LOOK } from './look';
import { fmtAmount, fmtUsd, heroOf, selectAssets, type Asset } from './penumbra-value';
import { SyncStrip } from '../../../components/wallet/sync-strip';
import { EmptyBox, HomeScreen } from './home-screen';
import { BalanceGroup, BalanceRow, Tile } from '../../../components/wallet/balance-rows';
import type { BalanceView } from '../../../components/wallet/balance-hero';

// the transparent chains under penumbra; lazy so other homes don't pay the chunk
const CosmosSubwallets = lazy(() =>
  import('./cosmos-subwallets').then(m => ({ default: m.CosmosSubwallets })),
);

const look = HOME_LOOK.penumbra;

/** send or swap one asset, or copy the id of one zafu cannot name */
const AssetSheet = ({ asset, onClose }: { asset?: Asset; onClose: () => void }) => {
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

/** penumbra home: the shared home, read from the view service */
export const PenumbraContent = ({ account, nudge }: { account: number; nudge?: ReactNode }) => {
  const queryClient = useQueryClient();
  const { latestBlockHeight, fullSyncHeight, error: syncError } = useSyncProgress();
  // the shared RAW balances cache (preload, send, swap read it too); this
  // screen's view of it is the fungible rows
  const {
    data: assets,
    isLoading,
    error,
    refetch,
  } = useQuery({
    ...balancesQueryOptions(account),
    staleTime: 5_000,
    select: selectAssets,
  });
  const [open, setOpen] = useState<Asset>();

  // refresh when the synced height advances (no flicker)
  const prevHeight = useRef(fullSyncHeight);
  useEffect(() => {
    if (fullSyncHeight && fullSyncHeight !== prevHeight.current) {
      prevHeight.current = fullSyncHeight;
      void queryClient.invalidateQueries({ queryKey: balancesQueryKey(account) });
    }
  }, [fullSyncHeight, account, queryClient]);

  const tip = latestBlockHeight ?? 0;
  const synced = fullSyncHeight ?? 0;
  const caughtUp = tip > 0 && tip - synced <= 10;
  const hero = heroOf(assets ?? []);
  const funded = (assets ?? []).some(a => a.amount > 0);
  const view: BalanceView =
    error && !assets
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
          percent={tip ? Math.min(100, (synced / tip) * 100) : 0}
          connecting={!tip}
          currentHeight={synced}
          targetHeight={tip}
          startBlock={0}
          onRetry={() => void queryClient.invalidateQueries({ queryKey: ['latestBlockHeight'] })}
        />
      }
      view={view}
      amount={'usd' in hero ? fmtUsd(hero.usd) : fmtAmount(hero.um)}
      unit={'usd' in hero ? 'usd' : undefined}
      sub={
        'usd' in hero
          ? 'in usdc.inj on penumbra'
          : assets?.length
            ? `${assets.length} ${assets.length === 1 ? 'asset' : 'assets'} · shielded`
            : undefined
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
              <BalanceRow
                key={a.key}
                tile={<Tile tone={a.um ? 'accent' : 'quiet'}>{a.symbol.slice(0, 2)}</Tile>}
                label={a.name}
                tag={a.symbol.toLowerCase()}
                amount={fmtAmount(a.amount)}
                note={
                  <span className='text-[11px] text-fg-muted'>
                    {a.usd === undefined ? 'no price' : fmtUsd(a.usd)}
                  </span>
                }
                onPress={() => setOpen(a)}
              />
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

      <AssetSheet asset={open} onClose={() => setOpen(undefined)} />
      <AskHistorySheet hasFunds={funded} />
    </HomeScreen>
  );
};
