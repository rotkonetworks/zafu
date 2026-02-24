import { useMemo, memo, useState, useCallback, useEffect } from 'react';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@repo/ui/components/ui/table';
import { ValueViewComponent } from '@repo/ui/components/ui/value';
import { ValueView } from '@penumbra-zone/protobuf/penumbra/core/asset/v1/asset_pb';
import { getDisplayDenomFromView, getEquivalentValues } from '@penumbra-zone/getters/value-view';
import { getMetadataFromBalancesResponse } from '@penumbra-zone/getters/balances-response';
import { asValueView } from '@penumbra-zone/getters/equivalent-value';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { viewClient, stakeClient, sctClient } from '../../../clients';
import { assetPatterns } from '@rotko/penumbra-types/assets';
import { fromValueView } from '@rotko/penumbra-types/amount';
import type { BalancesResponse } from '@penumbra-zone/protobuf/penumbra/view/v1/view_pb';
import { TransactionPlannerRequest } from '@penumbra-zone/protobuf/penumbra/view/v1/view_pb';
import { useSyncProgress } from '../../../hooks/full-sync-height';
import { usePenumbraTransaction } from '../../../hooks/penumbra-transaction';
import { bech32mIdentityKey, identityKeyFromBech32m } from '@penumbra-zone/bech32m/penumbravalid';
import { Cross2Icon } from '@radix-ui/react-icons';
import { isSidePanel, isDedicatedWindow } from '../../../utils/popup-detection';
import { openInSidePanel } from '../../../utils/navigate';
import { PopupPath } from '../paths';

const UNBONDING_DELAY_BLOCKS = 120_960;

/** memoized equivalent values display */
const EquivalentValues = memo(({ valueView }: { valueView?: ValueView }) => {
  const equivalentValuesAsValueViews = useMemo(
    () => (getEquivalentValues.optional(valueView) ?? []).map(asValueView),
    [valueView]
  );

  return (
    <div className='flex flex-wrap gap-2'>
      {equivalentValuesAsValueViews.map(equivalentValueAsValueView => (
        <ValueViewComponent
          key={getDisplayDenomFromView(equivalentValueAsValueView)}
          view={equivalentValueAsValueView}
          variant='equivalent'
        />
      ))}
    </div>
  );
});
EquivalentValues.displayName = 'EquivalentValues';

/** memoized row component */
const AssetRow = memo(({
  balance,
  currentBlockHeight,
  validatorName,
  onClaim,
}: {
  balance: BalancesResponse;
  currentBlockHeight?: number;
  validatorName?: string;
  onClaim?: () => void;
}) => (
  <TableRow className='group'>
    <TableCell>
      <ValueViewComponent
        view={balance.balanceView}
        currentBlockHeight={currentBlockHeight}
        validatorName={validatorName}
        onClaim={onClaim}
      />
    </TableCell>
    <TableCell>
      <EquivalentValues valueView={balance.balanceView} />
    </TableCell>
  </TableRow>
));
AssetRow.displayName = 'AssetRow';

/** filter out non-displayable assets */
const filterBalances = (balances: BalancesResponse[]): BalancesResponse[] =>
  balances.filter(balance => {
    const metadata = getMetadataFromBalancesResponse.optional(balance);
    if (!metadata?.base || typeof metadata.base !== 'string') return true;

    return !(
      assetPatterns.auctionNft.matches(metadata.base) ||
      assetPatterns.lpNft.matches(metadata.base) ||
      assetPatterns.proposalNft.matches(metadata.base) ||
      assetPatterns.votingReceipt.matches(metadata.base)
    );
  });

/** sort by priority score descending */
const sortBalances = (balances: BalancesResponse[]): BalancesResponse[] =>
  [...balances].sort((a, b) => {
    const aScore = getMetadataFromBalancesResponse.optional(a)?.priorityScore ?? 0n;
    const bScore = getMetadataFromBalancesResponse.optional(b)?.priorityScore ?? 0n;
    return Number(bScore - aScore);
  });

export interface AssetsTableProps {
  account: number;
}

/** parse unbonding token info from balance */
const getUnbondingInfo = (balance: BalancesResponse) => {
  const metadata = getMetadataFromBalancesResponse.optional(balance);
  if (!metadata?.display) return undefined;
  const captured = assetPatterns.unbondingToken.capture(metadata.display);
  if (!captured) return undefined;
  return { idKey: captured.idKey, startAt: parseInt(captured.startAt, 10) };
};

type ClaimStatus = 'idle' | 'confirm' | 'planning' | 'signing' | 'broadcasting' | 'success' | 'error';

export const AssetsTable = ({ account }: AssetsTableProps) => {
  const { latestBlockHeight } = useSyncProgress();
  const penumbraTx = usePenumbraTransaction();
  const queryClient = useQueryClient();

  // claim modal state
  const [claimBalance, setClaimBalance] = useState<BalancesResponse | undefined>();
  const [claimStatus, setClaimStatus] = useState<ClaimStatus>('idle');
  const [claimError, setClaimError] = useState<string>();
  const [claimTxHash, setClaimTxHash] = useState<string>();

  // fetch validators for name lookup
  const { data: validatorNames } = useQuery({
    queryKey: ['validator-names'],
    staleTime: 300_000, // 5 minutes
    queryFn: async () => {
      const map = new Map<string, string>();
      try {
        for await (const v of stakeClient.validatorInfo({})) {
          if (!v.validatorInfo?.validator?.identityKey?.ik) continue;
          const name = v.validatorInfo.validator.name || 'Unknown';
          const bech32 = bech32mIdentityKey({ ik: v.validatorInfo.validator.identityKey.ik });
          map.set(bech32, name);
        }
      } catch {
        // ignore errors
      }
      return map;
    },
  });

  const { data: rawBalances, isLoading, error } = useQuery({
    queryKey: ['balances', account],
    staleTime: Infinity,
    queryFn: async () => {
      try {
        return await Array.fromAsync(viewClient.balances({ accountFilter: { account } }));
      } catch {
        return [];
      }
    },
  });

  // memoize expensive filter + sort operations
  const balances = useMemo(() => {
    if (!rawBalances?.length) return [];
    return sortBalances(filterBalances(rawBalances));
  }, [rawBalances]);

  // check for pending claim from popup → side panel handoff
  useEffect(() => {
    if (!balances.length) return;
    void chrome.storage.local.get('pendingClaim').then(({ pendingClaim }) => {
      if (!pendingClaim) return;
      void chrome.storage.local.remove('pendingClaim');
      const matching = balances.find(b => {
        const info = getUnbondingInfo(b);
        return info && info.idKey === pendingClaim.validatorId && info.startAt === pendingClaim.startAt;
      });
      if (matching) {
        setClaimBalance(matching);
        setClaimStatus('confirm');
      }
    });
  }, [balances]);

  const openClaimForBalance = useCallback((balance: BalancesResponse) => {
    if (isSidePanel() || isDedicatedWindow()) {
      setClaimBalance(balance);
      setClaimStatus('confirm');
    } else {
      // store claim info, open side panel, and close the popup
      const info = getUnbondingInfo(balance);
      if (!info) return;
      void chrome.storage.local.set({ pendingClaim: { validatorId: info.idKey, startAt: info.startAt } });
      void openInSidePanel(PopupPath.INDEX).then(() => window.close());
    }
  }, []);

  const closeClaim = useCallback(() => {
    setClaimBalance(undefined);
    setClaimStatus('idle');
    setClaimError(undefined);
    setClaimTxHash(undefined);
  }, []);

  const handleClaim = useCallback(async () => {
    if (!claimBalance) return;

    const info = getUnbondingInfo(claimBalance);
    if (!info) return;

    setClaimStatus('planning');
    setClaimError(undefined);

    try {
      const identityKey = identityKeyFromBech32m(info.idKey);

      // extract the raw amount from the balance view
      const valueView = claimBalance.balanceView;
      let amount;
      if (valueView?.valueView.case === 'knownAssetId') {
        amount = valueView.valueView.value.amount;
      } else if (valueView?.valueView.case === 'unknownAssetId') {
        amount = valueView.valueView.value.amount;
      }
      if (!amount) throw new Error('could not extract unbonding amount');

      // query epochs to look up the correct penalty from the chain
      const [startEpochRes, currentEpochRes] = await Promise.all([
        sctClient.epochByHeight({ height: BigInt(info.startAt) }),
        sctClient.epochByHeight({ height: BigInt(latestBlockHeight ?? 0) }),
      ]);

      if (!startEpochRes.epoch || !currentEpochRes.epoch) {
        throw new Error('failed to resolve epoch for unbonding claim');
      }

      const penaltyRes = await stakeClient.validatorPenalty({
        identityKey,
        startEpochIndex: startEpochRes.epoch.index,
        endEpochIndex: currentEpochRes.epoch.index,
      });

      const planRequest = new TransactionPlannerRequest({
        undelegationClaims: [{
          validatorIdentity: identityKey,
          unbondingStartHeight: BigInt(info.startAt),
          unbondingAmount: amount,
          penalty: penaltyRes.penalty,
        }],
        source: { account: 0 },
      });

      setClaimStatus('signing');
      const result = await penumbraTx.mutateAsync(planRequest);

      setClaimStatus('success');
      setClaimTxHash(result.txId);

      // refetch balances
      void queryClient.invalidateQueries({ queryKey: ['balances'] });
    } catch (err) {
      setClaimStatus('error');
      setClaimError(err instanceof Error ? err.message : 'claim failed');
    }
  }, [claimBalance, penumbraTx, queryClient, latestBlockHeight]);

  if (isLoading) {
    return (
      <div className='flex items-center justify-center py-8 text-xs text-muted-foreground'>
        Loading...
      </div>
    );
  }

  if (error || !balances.length) {
    return (
      <div className='flex flex-col items-center justify-center gap-1 py-8 text-center'>
        <span className='text-sm text-muted-foreground'>No assets yet</span>
        <span className='text-xs text-muted-foreground/70'>
          Receive funds to get started
        </span>
      </div>
    );
  }

  // extract claim modal info
  const claimInfo = claimBalance ? getUnbondingInfo(claimBalance) : undefined;
  const claimDisplayAmount = claimBalance?.balanceView ? fromValueView(claimBalance.balanceView).toFixed(6) : '0';
  const claimValidatorName = claimInfo?.idKey ? validatorNames?.get(claimInfo.idKey) : undefined;

  return (
    <>
      <Table>
        <TableHeader className='group'>
          <TableRow>
            <TableHead>Balance</TableHead>
            <TableHead>Value</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {balances.map((balance, i) => {
            const info = getUnbondingInfo(balance);
            const validatorName = info?.idKey ? validatorNames?.get(info.idKey) : undefined;

            // determine if this unbonding token is ready to claim
            const isReady = info && latestBlockHeight !== undefined
              && latestBlockHeight >= info.startAt + UNBONDING_DELAY_BLOCKS;

            return (
              <AssetRow
                key={i}
                balance={balance}
                currentBlockHeight={latestBlockHeight}
                validatorName={validatorName}
                onClaim={isReady ? () => openClaimForBalance(balance) : undefined}
              />
            );
          })}
        </TableBody>
      </Table>

      {/* claim confirmation modal */}
      {claimBalance && claimStatus !== 'idle' && (
        <div className='fixed inset-0 z-50 flex items-center justify-center bg-black/60'>
          <div className='mx-4 w-full max-w-sm border border-border bg-background p-5 shadow-xl'>
            <div className='flex items-center justify-between mb-4'>
              <h2 className='text-lg font-semibold'>Claim Unbonding Tokens</h2>
              {(claimStatus === 'confirm' || claimStatus === 'success' || claimStatus === 'error') && (
                <button onClick={closeClaim} className='text-muted-foreground hover:text-foreground'>
                  <Cross2Icon className='h-4 w-4' />
                </button>
              )}
            </div>

            {claimStatus === 'confirm' && claimInfo && (
              <div className='flex flex-col gap-3'>
                <div className='border border-border bg-card p-3'>
                  <div className='text-xs text-muted-foreground'>Amount to receive</div>
                  <div className='text-lg font-semibold tabular-nums'>{claimDisplayAmount} UM</div>
                </div>

                <div className='text-sm'>
                  <div className='flex justify-between py-1'>
                    <span className='text-muted-foreground'>Validator</span>
                    <span className='text-right font-medium'>{claimValidatorName ?? 'Unknown'}</span>
                  </div>
                  <div className='flex justify-between py-1'>
                    <span className='text-muted-foreground'>Unbonding start</span>
                    <span className='font-mono text-xs'>{claimInfo.startAt.toLocaleString()}</span>
                  </div>
                  <div className='flex justify-between py-1'>
                    <span className='text-muted-foreground'>Status</span>
                    <span className='text-green-400'>Ready to claim</span>
                  </div>
                </div>

                <div className='flex gap-2 mt-2'>
                  <button
                    onClick={closeClaim}
                    className='flex-1 border border-border px-4 py-2 text-sm hover:bg-muted transition-colors'
                  >
                    Cancel
                  </button>
                  <button
                    onClick={() => void handleClaim()}
                    className='flex-1 bg-black px-4 py-2 text-sm font-medium text-white hover:bg-neutral-900 transition-colors'
                  >
                    Confirm Claim
                  </button>
                </div>
              </div>
            )}

            {(claimStatus === 'planning' || claimStatus === 'signing' || claimStatus === 'broadcasting') && (
              <div className='flex flex-col items-center gap-3 py-6'>
                <div className='h-6 w-6 animate-spin rounded-full border-2 border-teal border-t-transparent' />
                <p className='text-sm text-muted-foreground'>
                  {claimStatus === 'planning' && 'building transaction plan...'}
                  {claimStatus === 'signing' && 'signing transaction...'}
                  {claimStatus === 'broadcasting' && 'broadcasting...'}
                </p>
              </div>
            )}

            {claimStatus === 'success' && (
              <div className='flex flex-col gap-3'>
                <p className='text-sm text-green-400'>Claim successful!</p>
                {claimTxHash && (
                  <p className='text-xs text-muted-foreground font-mono break-all'>
                    tx: {claimTxHash}
                  </p>
                )}
                <button
                  onClick={closeClaim}
                  className='mt-2 w-full border border-border px-4 py-2 text-sm hover:bg-muted transition-colors'
                >
                  Close
                </button>
              </div>
            )}

            {claimStatus === 'error' && (
              <div className='flex flex-col gap-3'>
                <p className='text-sm text-red-400'>{claimError ?? 'claim failed'}</p>
                <div className='flex gap-2 mt-2'>
                  <button
                    onClick={closeClaim}
                    className='flex-1 border border-border px-4 py-2 text-sm hover:bg-muted transition-colors'
                  >
                    Close
                  </button>
                  <button
                    onClick={() => { setClaimStatus('confirm'); setClaimError(undefined); }}
                    className='flex-1 bg-black px-4 py-2 text-sm font-medium text-white hover:bg-neutral-900 transition-colors'
                  >
                    Retry
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
};
