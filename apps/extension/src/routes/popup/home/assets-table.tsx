import { useMemo, memo, useState, useCallback, useEffect, useRef } from 'react';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@repo/ui/components/ui/table';
import { ValueViewComponent } from '@repo/ui/components/ui/value';
import { Sensitive } from '../../../components/sensitive';
import { ValueView } from '@penumbra-zone/protobuf/penumbra/core/asset/v1/asset_pb';
import { getDisplayDenomFromView, getEquivalentValues } from '@penumbra-zone/getters/value-view';
import { getMetadataFromBalancesResponse } from '@penumbra-zone/getters/balances-response';
import { asValueView } from '@penumbra-zone/getters/equivalent-value';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { viewClient, stakeClient, sctClient } from '../../../clients';
import { assetPatterns } from '@rotko/penumbra-types/assets';
import { fromValueView } from '@rotko/penumbra-types/amount';
import { filterFungibleBalances } from '../../../utils/is-fungible-asset';
import type { BalancesResponse } from '@penumbra-zone/protobuf/penumbra/view/v1/view_pb';
import { TransactionPlannerRequest } from '@penumbra-zone/protobuf/penumbra/view/v1/view_pb';
import { useSyncProgress } from '../../../hooks/full-sync-height';
import { usePenumbraTransaction } from '../../../hooks/penumbra-transaction';
import { bech32mIdentityKey, identityKeyFromBech32m } from '@penumbra-zone/bech32m/penumbravalid';
import { isSidePanel, isDedicatedWindow } from '../../../utils/popup-detection';
import { openInSidePanel } from '../../../utils/navigate';
import { PopupPath } from '../paths';
import { useNavigate } from 'react-router-dom';
import { symbolFromMetadata } from '../../../utils/asset-display';

const UNBONDING_DELAY_BLOCKS = 120_960;

/** memoized equivalent values display */
const EquivalentValues = memo(({ valueView }: { valueView?: ValueView }) => {
  const equivalentValuesAsValueViews = useMemo(
    () => (getEquivalentValues.optional(valueView) ?? []).map(asValueView),
    [valueView],
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

/**
 * True when this balance represents a synthetic per-position token (LP NFT,
 * delegation/unbonding, auction, governance vote/proposal). These are chain
 * state, not something the user can "send X" or "swap X" — the row-level
 * Send/Swap quick actions must not appear on them. The main balance-list
 * filter above already drops the NFT variants; delegation and unbonding
 * tokens still render (they show a Claim affordance instead) so this guard
 * covers those too, and stays correct when the shared fungible-asset filter
 * lands and removes them from the list entirely.
 */
const isNonFungibleBalance = (balance: BalancesResponse): boolean => {
  const meta = getMetadataFromBalancesResponse.optional(balance);
  const display = meta?.display;
  if (!display) {
    return false;
  }
  return (
    assetPatterns.delegationToken.matches(display) ||
    assetPatterns.unbondingToken.matches(display) ||
    assetPatterns.lpNft.matches(display) ||
    assetPatterns.auctionNft.matches(display) ||
    assetPatterns.proposalNft.matches(display) ||
    assetPatterns.votingReceipt.matches(display)
  );
};

/** memoized row component */
const AssetRow = memo(
  ({
    balance,
    currentBlockHeight,
    validatorName,
    onClaim,
    onSend,
    onSwap,
  }: {
    balance: BalancesResponse;
    currentBlockHeight?: number;
    validatorName?: string;
    onClaim?: () => void;
    /** invoked with the balance's base denom (unique across the wallet) */
    onSend?: (base: string) => void;
    onSwap?: (base: string) => void;
  }) => {
    const meta = getMetadataFromBalancesResponse.optional(balance);
    const base = typeof meta?.base === 'string' ? meta.base : undefined;
    const symbol = symbolFromMetadata(meta);
    const showActions = !!base && !isNonFungibleBalance(balance) && !!(onSend || onSwap);

    return (
      <TableRow className='group'>
        <TableCell>
          <Sensitive>
            <ValueViewComponent
              view={balance.balanceView}
              currentBlockHeight={currentBlockHeight}
              validatorName={validatorName}
              onClaim={onClaim}
            />
          </Sensitive>
        </TableCell>
        <TableCell>
          <Sensitive>
            <EquivalentValues valueView={balance.balanceView} />
          </Sensitive>
        </TableCell>
        <TableCell className='w-px whitespace-nowrap text-right'>
          {showActions && (
            <div className='flex items-center justify-end gap-1'>
              {onSend && (
                <button
                  type='button'
                  onClick={() => onSend(base)}
                  aria-label={`Send ${symbol}`}
                  title={`send ${symbol}`}
                  className='inline-flex h-7 w-7 items-center justify-center rounded-md text-fg-muted transition-colors hover:bg-elev-2 hover:text-fg-high focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-zigner-gold/60'
                >
                  <span className='i-ph-arrow-up-right h-4 w-4' />
                </button>
              )}
              {onSwap && (
                <button
                  type='button'
                  onClick={() => onSwap(base)}
                  aria-label={`Swap ${symbol}`}
                  title={`swap ${symbol}`}
                  className='inline-flex h-7 w-7 items-center justify-center rounded-md text-fg-muted transition-colors hover:bg-elev-2 hover:text-fg-high focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-zigner-gold/60'
                >
                  <span className='i-ph-arrows-left-right h-4 w-4' />
                </button>
              )}
            </div>
          )}
        </TableCell>
      </TableRow>
    );
  },
);
AssetRow.displayName = 'AssetRow';

/** filter out non-fungible synthetic tokens (LP NFTs, delegation, etc.) */
const filterBalances = filterFungibleBalances;

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
  if (!metadata?.display) {
    return undefined;
  }
  const captured = assetPatterns.unbondingToken.capture(metadata.display);
  if (!captured) {
    return undefined;
  }
  return { idKey: captured.idKey, startAt: parseInt(captured.startAt, 10) };
};

type ClaimStatus =
  | 'idle'
  | 'confirm'
  | 'planning'
  | 'signing'
  | 'broadcasting'
  | 'success'
  | 'error';

export const AssetsTable = ({ account }: AssetsTableProps) => {
  const { latestBlockHeight } = useSyncProgress();
  const penumbraTx = usePenumbraTransaction();
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  // Quick-action nav handlers. Stable across renders so memo(AssetRow)
  // stays effective — the row only re-renders on balance changes.
  // Pre-fill travels via router state (already the mechanism SendPage
  // consumes for inbox compose etc.), keyed by the balance's `base` denom
  // because it is unique across the wallet and unambiguous (IBC base
  // denoms contain slashes that URL params would need to encode).
  const goSend = useCallback(
    (base: string) => navigate(PopupPath.SEND, { state: { prefillAsset: base } }),
    [navigate],
  );
  const goSwap = useCallback(
    (base: string) => navigate(PopupPath.SWAP, { state: { prefillFromAsset: base } }),
    [navigate],
  );

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
          if (!v.validatorInfo?.validator?.identityKey?.ik) {
            continue;
          }
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

  const {
    data: rawBalances,
    isLoading,
    error,
    refetch,
  } = useQuery({
    queryKey: ['balances', account],
    staleTime: 5_000,
    // Deliberately no try/catch here. Swallowing the failure made an
    // unreachable view service indistinguishable from an empty wallet, so a
    // user who simply lost their connection was shown "no assets yet" and the
    // funding on-ramp - the one thing a wallet must never say, because it reads
    // as "your money is gone". Let the error reach the render below.
    queryFn: async () => Array.fromAsync(viewClient.balances({ accountFilter: { account } })),
  });

  // refetch balances when sync height advances (live update, no flicker)
  const prevHeightRef = useRef(latestBlockHeight);
  useEffect(() => {
    if (latestBlockHeight && latestBlockHeight !== prevHeightRef.current) {
      prevHeightRef.current = latestBlockHeight;
      void queryClient.invalidateQueries({ queryKey: ['balances', account] });
    }
  }, [latestBlockHeight, account, queryClient]);

  // memoize expensive filter + sort operations
  const balances = useMemo(() => {
    if (!rawBalances?.length) {
      return [];
    }
    return sortBalances(filterBalances(rawBalances));
  }, [rawBalances]);

  // check for pending claim from popup → side panel handoff
  useEffect(() => {
    if (!balances.length) {
      return;
    }
    void chrome.storage.local.get('pendingClaim').then(({ pendingClaim }) => {
      if (!pendingClaim) {
        return;
      }
      void chrome.storage.local.remove('pendingClaim');
      const matching = balances.find(b => {
        const info = getUnbondingInfo(b);
        return (
          info && info.idKey === pendingClaim.validatorId && info.startAt === pendingClaim.startAt
        );
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
      if (!info) {
        return;
      }
      void chrome.storage.local.set({
        pendingClaim: { validatorId: info.idKey, startAt: info.startAt },
      });
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
    if (!claimBalance) {
      return;
    }

    const info = getUnbondingInfo(claimBalance);
    if (!info) {
      return;
    }

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
      if (!amount) {
        throw new Error('could not extract unbonding amount');
      }

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
        undelegationClaims: [
          {
            validatorIdentity: identityKey,
            unbondingStartHeight: BigInt(info.startAt),
            unbondingAmount: amount,
            penalty: penaltyRes.penalty,
          },
        ],
        source: { account },
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
      <div className='flex items-center justify-center py-12 text-sm text-fg-muted'>loading...</div>
    );
  }

  if (error) {
    return (
      <div className='flex flex-col items-center gap-3 px-4 py-10 text-center'>
        <span className='i-ph-warning-circle h-6 w-6 text-rust' />
        <span className='text-sm text-fg-muted'>couldn't load your balances</span>
        <span className='max-w-[18rem] text-xs leading-snug text-fg-muted/70'>
          the penumbra view service didn't answer - this is a connection problem, not an empty
          wallet.
        </span>
        <button
          type='button'
          onClick={() => void refetch()}
          className='text-xs text-zigner-gold hover:underline'
        >
          retry
        </button>
      </div>
    );
  }

  if (!balances.length) {
    return (
      <div className='flex flex-col items-center gap-4 px-4 py-10 text-center'>
        <div className='flex flex-col items-center gap-1'>
          <span className='i-ph-shield-check h-6 w-6 text-network-accent/60' />
          <span className='text-sm text-fg-muted'>no assets yet</span>
          <span className='text-xs text-fg-muted/70'>fund your shielded wallet with USDC</span>
        </div>
        <ol className='flex w-full max-w-[16rem] flex-col gap-2 text-left'>
          {[
            'withdraw USDC from Binance or Kraken to your wallet Injective address',
            'the wallet IBCs it to Penumbra - shield to go private',
          ].map((step, i) => (
            <li key={i} className='flex items-start gap-2 text-xs text-fg-muted'>
              <span className='mt-px flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-elev-2 text-label text-fg-dim'>
                {i + 1}
              </span>
              {step}
            </li>
          ))}
        </ol>
        <p className='max-w-[16rem] text-label leading-snug text-fg-dim'>
          holding USDC on Noble? that path is winding down - the bridge halts Dec 1, 2026. send what
          you have there to your wallet Noble address and shield it, but don't on-ramp fresh USDC to
          Noble.
        </p>
      </div>
    );
  }

  // extract claim modal info
  const claimInfo = claimBalance ? getUnbondingInfo(claimBalance) : undefined;
  const claimDisplayAmount = claimBalance?.balanceView
    ? fromValueView(claimBalance.balanceView).toFixed(6)
    : '0';
  const claimValidatorName = claimInfo?.idKey ? validatorNames?.get(claimInfo.idKey) : undefined;

  return (
    <>
      <div className='rounded-lg border border-border-soft bg-elev-1 overflow-hidden [&_td]:px-3 [&_th]:px-3'>
        <Table>
          <TableHeader className='group'>
            <TableRow>
              <TableHead>balance</TableHead>
              <TableHead>value</TableHead>
              <TableHead className='w-px'>
                <span className='sr-only'>actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {balances.map((balance, i) => {
              const info = getUnbondingInfo(balance);
              const validatorName = info?.idKey ? validatorNames?.get(info.idKey) : undefined;

              // determine if this unbonding token is ready to claim
              const isReady =
                info &&
                latestBlockHeight !== undefined &&
                latestBlockHeight >= info.startAt + UNBONDING_DELAY_BLOCKS;

              return (
                <AssetRow
                  key={i}
                  balance={balance}
                  currentBlockHeight={latestBlockHeight}
                  validatorName={validatorName}
                  onClaim={isReady ? () => openClaimForBalance(balance) : undefined}
                  onSend={goSend}
                  onSwap={goSwap}
                />
              );
            })}
          </TableBody>
        </Table>
      </div>

      {/* claim confirmation modal */}
      {claimBalance && claimStatus !== 'idle' && (
        <div className='fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm'>
          <div className='mx-4 w-full max-w-sm rounded-lg border border-border-soft bg-canvas p-5 shadow-xl'>
            <div className='flex items-center justify-between mb-4'>
              <h2 className='text-lg font-medium'>claim unbonding tokens</h2>
              {(claimStatus === 'confirm' ||
                claimStatus === 'success' ||
                claimStatus === 'error') && (
                <button
                  onClick={closeClaim}
                  className='text-fg-muted hover:text-fg-high transition-colors'
                >
                  <span className='i-ph-x h-4 w-4' />
                </button>
              )}
            </div>

            {claimStatus === 'confirm' && claimInfo && (
              <div className='flex flex-col gap-3'>
                <div className='rounded-lg border border-border-soft bg-elev-1 p-3'>
                  <div className='text-xs text-fg-muted'>amount to receive</div>
                  <div className='text-lg font-medium tabular-nums'>
                    <Sensitive>{claimDisplayAmount} UM</Sensitive>
                  </div>
                </div>

                <div className='text-sm'>
                  <div className='flex justify-between py-1'>
                    <span className='text-fg-muted'>validator</span>
                    <span className='text-right font-medium'>
                      {claimValidatorName ?? 'unknown'}
                    </span>
                  </div>
                  <div className='flex justify-between py-1'>
                    <span className='text-fg-muted'>unbonding start</span>
                    <span className='font-mono text-xs'>{claimInfo.startAt.toLocaleString()}</span>
                  </div>
                  <div className='flex justify-between py-1'>
                    <span className='text-fg-muted'>status</span>
                    <span className='text-fg-high'>ready to claim</span>
                  </div>
                </div>

                <div className='flex gap-2 mt-2'>
                  <button
                    onClick={closeClaim}
                    className='flex-1 rounded-lg border border-border-soft py-3 text-sm hover:bg-elev-1 transition-colors'
                  >
                    cancel
                  </button>
                  <button
                    onClick={() => void handleClaim()}
                    className='flex-1 rounded-lg bg-zigner-gold py-3 text-sm font-medium text-zigner-gold-foreground hover:bg-zigner-gold-light transition-colors'
                  >
                    confirm claim
                  </button>
                </div>
              </div>
            )}

            {(claimStatus === 'planning' ||
              claimStatus === 'signing' ||
              claimStatus === 'broadcasting') && (
              <div className='flex flex-col items-center gap-3 py-12'>
                <div className='h-6 w-6 animate-spin rounded-full border-2 border-zigner-gold border-t-transparent' />
                <p className='text-sm text-fg-muted'>
                  {claimStatus === 'planning' && 'building transaction plan...'}
                  {claimStatus === 'signing' && 'signing transaction...'}
                  {claimStatus === 'broadcasting' && 'broadcasting...'}
                </p>
              </div>
            )}

            {claimStatus === 'success' && (
              <div className='flex flex-col gap-3'>
                <p className='text-sm text-fg-high'>claim successful</p>
                {claimTxHash && (
                  <p className='text-xs text-fg-muted font-mono break-all'>tx: {claimTxHash}</p>
                )}
                <button
                  onClick={closeClaim}
                  className='mt-2 w-full rounded-lg border border-border-soft py-2 text-sm hover:bg-elev-1 transition-colors'
                >
                  close
                </button>
              </div>
            )}

            {claimStatus === 'error' && (
              <div className='flex flex-col gap-3'>
                <p className='text-sm text-red-400'>{claimError ?? 'claim failed'}</p>
                <div className='flex gap-2 mt-2'>
                  <button
                    onClick={closeClaim}
                    className='flex-1 rounded-lg border border-border-soft py-3 text-sm hover:bg-elev-1 transition-colors'
                  >
                    close
                  </button>
                  <button
                    onClick={() => {
                      setClaimStatus('confirm');
                      setClaimError(undefined);
                    }}
                    className='flex-1 rounded-lg bg-zigner-gold py-3 text-sm font-medium text-zigner-gold-foreground hover:bg-zigner-gold-light transition-colors'
                  >
                    retry
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
