import { lazy, Suspense, useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { PenumbraAccountPicker } from '../../../components/penumbra-account-picker';
import { Sensitive } from '../../../components/sensitive';
import { PopupPath } from '../paths';
import { AssetListSkeleton } from '../../../components/primitives/skeleton';
import { StatusSlot } from '@repo/ui/components/ui/status-slot';
import { useSyncProgress } from '../../../hooks/full-sync-height';
import { useOnline } from '../../../hooks/use-online';
import { classifySyncFailure } from '../../../state/sync-failure';
import { syncNotice } from '../../../components/zcash/sync-notice';
import { getDisplayDenomFromView } from '@penumbra-zone/getters/value-view';
import { fromValueView } from '@rotko/penumbra-types/amount';
import type { BalancesResponse } from '@penumbra-zone/protobuf/penumbra/view/v1/view_pb';
import { balancesQueryOptions, balancesQueryKey } from '../../../hooks/penumbra-balances';
import { Row, RowGroup } from '@repo/ui/components/ui/row';
import { AskHistorySheet } from './history';

/** lazy load network-specific content - only load when needed */
const AssetsTable = lazy(() => import('./assets-table').then(m => ({ default: m.AssetsTable })));

// Cosmos sub-wallets render under the Penumbra view to surface
// unshielded balances the user can shield. Lazy so non-Penumbra views
// don't pay the chunk.
const CosmosSubwallets = lazy(() =>
  import('./cosmos-subwallets').then(m => ({ default: m.CosmosSubwallets })),
);

/** UM total across balances; module-level so react-query's select is stable. */
const selectUmTotal = (balances: BalancesResponse[]): number => {
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
};

/** penumbra-specific content - balance card + sync bar + account picker + assets */
export const PenumbraContent = ({
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
  const notice = syncNotice({
    online: useOnline(),
    failure: error ? classifySyncFailure(error) : null,
  });

  const isSyncing = (latestBlockHeight ?? 0) - (fullSyncHeight ?? 0) > 10;
  const syncPct =
    latestBlockHeight && fullSyncHeight
      ? Math.min(100, Math.round((Number(fullSyncHeight) / Number(latestBlockHeight)) * 100))
      : 0;

  const syncLabel = !latestBlockHeight
    ? 'connecting...'
    : isSyncing
      ? `syncing ${syncPct}%`
      : `block ${(fullSyncHeight ?? latestBlockHeight).toLocaleString()}`;

  // UM total for the balance card, derived from the SAME cached balances stream
  // the assets table uses (react-query `select` runs on the shared cache). It
  // used to run its own full viewClient.balances stream - over every note,
  // hundreds of LP NFTs on a big wallet - so every block paid for two.
  const { data: umBalance } = useQuery({
    ...balancesQueryOptions(account),
    staleTime: 5_000,
    select: selectUmTotal,
  });

  // refresh balances when sync height advances (no flicker). Same key as the
  // assets table's refresh, so concurrent invalidations share ONE fetch.
  const queryClient = useQueryClient();
  const prevHeight = useRef(fullSyncHeight);
  useEffect(() => {
    if (fullSyncHeight && fullSyncHeight !== prevHeight.current) {
      prevHeight.current = fullSyncHeight;
      void queryClient.invalidateQueries({ queryKey: balancesQueryKey(account) });
    }
  }, [fullSyncHeight, account, queryClient]);

  // Amount and unit kept apart so the unit can be set subordinate, the same
  // as the zcash hero. Concatenating them forced both to one size, which is
  // what made the figure read flat.
  const balanceAmount =
    umBalance != null && umBalance > 0
      ? umBalance.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 6 })
      : umBalance != null
        ? '0'
        : null;
  const balanceSyncing = balanceAmount == null && isSyncing;

  return (
    <div className='flex-1 flex flex-col gap-3'>
      {/* balance card - matches the zcash hero card (accent border, 'balance'
          kicker) so the two networks read as one design, not two. */}
      <div className='border border-network-accent/20 bg-elev-1 p-4'>
        <span className='kicker'>balance</span>
        <div className='mt-1 flex min-w-0 items-baseline gap-1.5'>
          {balanceSyncing ? (
            <span className='text-hero leading-none text-fg-dim tabular lowercase'>syncing…</span>
          ) : (
            <>
              <span className='min-w-0 truncate text-hero leading-none tracking-tight text-network-accent tabular'>
                <Sensitive>{balanceAmount ?? '0'}</Sensitive>
              </span>
              <span className='shrink-0 text-title leading-none text-network-accent/60 tabular'>
                UM
              </span>
            </>
          )}
        </div>
        <div className='mt-1 text-label text-fg-dim tabular'>{syncLabel}</div>
      </div>

      {/* action row directly under the balance - Zashi placement */}
      {actions}

      {/* Trade entry - the shielded DEX was only reachable from the apps grid
          and the menu footer; surface it on the Penumbra home next to the swap
          action. Opens in a new tab, same as the apps grid. */}
      <RowGroup>
        <Row
          type='screen'
          icon='i-ph-chart-line-up'
          label='trade on penumbra'
          description='shielded swaps & liquidity positions'
          onPress={() => window.open('https://penumbra.fi', '_blank', 'noopener,noreferrer')}
        />
      </RowGroup>

      {/* single message slot for penumbra: only the backup nudge competes */}
      {nudge}

      {/* sync status - a fixed-height reserved slot, not a growing card. The
          same classified line as zcash (state/sync-failure.ts), never the raw
          error, and offline before anything about the node. */}
      {(isSyncing || !latestBlockHeight || notice) && (
        <StatusSlot
          tone={notice ? 'warn' : 'gold'}
          icon={notice ? 'i-ph-warning' : 'i-ph-arrows-clockwise'}
          progress={notice ? undefined : syncPct}
          action={
            notice?.action?.kind === 'settings'
              ? {
                  label: notice.action.label,
                  onClick: () => navigate(`${PopupPath.SETTINGS_NETWORKS}?network=penumbra`),
                }
              : undefined
          }
        >
          {notice?.text ?? syncLabel}
        </StatusSlot>
      )}

      {/* account picker - between sync bar and assets */}
      <PenumbraAccountPicker account={account} onChange={onAccountChange} />

      <div className='kicker mb-2'>assets</div>
      <Suspense fallback={<AssetListSkeleton rows={4} />}>
        <AssetsTable account={account} />
      </Suspense>

      {/* the transparent chains tied to the same key, checked only on request.
          Not split by Penumbra account: burners use the wallet's own derivation. */}
      <Suspense fallback={null}>
        <CosmosSubwallets />
      </Suspense>

      <AskHistorySheet hasFunds={(umBalance ?? 0) > 0} />
    </div>
  );
};
