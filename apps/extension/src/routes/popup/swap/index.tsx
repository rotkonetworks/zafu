/**
 * penumbra swap page
 *
 * allows users to privately swap assets using penumbra's shielded dex
 * uses simulation service for quotes
 */

import { useState, useMemo, useCallback, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { MixIcon, ChevronDownIcon, UpdateIcon, ArrowDownIcon } from '@radix-ui/react-icons';
import { viewClient, simulationClient } from '../../../clients';
import { usePenumbraTransaction } from '../../../hooks/penumbra-transaction';
import { useStore } from '../../../state';
import { activeNetworkSelector } from '../../../state/active-network';
import { TransactionPlannerRequest } from '@penumbra-zone/protobuf/penumbra/view/v1/view_pb';
import { Amount } from '@penumbra-zone/protobuf/penumbra/core/num/v1/num_pb';
import { Value } from '@penumbra-zone/protobuf/penumbra/core/asset/v1/asset_pb';
import { getMetadataFromBalancesResponse } from '@penumbra-zone/getters/balances-response';
import { getDisplayDenomFromView, getAssetIdFromValueView, getDisplayDenomExponentFromValueView } from '@penumbra-zone/getters/value-view';
import { fromValueView } from '@penumbra-zone/types/amount';
import { assetPatterns } from '@penumbra-zone/types/assets';
import { cn } from '@repo/ui/lib/utils';
import type { BalancesResponse, AssetsResponse } from '@penumbra-zone/protobuf/penumbra/view/v1/view_pb';

/** input asset with balance */
interface InputAsset {
  balance: BalancesResponse;
  symbol: string;
  amount: string;
  assetId: Uint8Array | undefined;
  exponent: number;
}

/** output asset from assets list */
interface OutputAsset {
  response: AssetsResponse;
  symbol: string;
  assetId: Uint8Array | undefined;
  exponent: number;
}

/** Penumbra swap page */
export const SwapPage = () => {
  const { activeNetwork } = useStore(activeNetworkSelector);
  const [amountIn, setAmountIn] = useState('');
  const [assetInOpen, setAssetInOpen] = useState(false);
  const [assetOutOpen, setAssetOutOpen] = useState(false);
  const [selectedIn, setSelectedIn] = useState<InputAsset | undefined>();
  const [selectedOut, setSelectedOut] = useState<OutputAsset | undefined>();
  const [txStatus, setTxStatus] = useState<'idle' | 'planning' | 'signing' | 'broadcasting' | 'success' | 'error'>('idle');
  const [txHash, setTxHash] = useState<string | undefined>();
  const [txError, setTxError] = useState<string | undefined>();

  const penumbraTx = usePenumbraTransaction();

  // only show for penumbra network
  if (activeNetwork !== 'penumbra') {
    return (
      <div className='flex flex-col items-center justify-center gap-4 p-6 pt-16 text-center'>
        <div className='rounded-full bg-primary/10 p-4'>
          <MixIcon className='h-8 w-8 text-primary' />
        </div>
        <div>
          <h2 className='text-lg font-semibold'>swap</h2>
          <p className='mt-1 text-sm text-muted-foreground'>
            swapping is only available for penumbra network.
          </p>
        </div>
      </div>
    );
  }

  // fetch balances
  const { data: balances = [], isLoading: balancesLoading, refetch: refetchBalances } = useQuery({
    queryKey: ['balances', 0],
    staleTime: 30_000,
    queryFn: async () => {
      try {
        const raw = await Array.fromAsync(viewClient.balances({ accountFilter: { account: 0 } }));
        return raw
          .filter(b => {
            const meta = getMetadataFromBalancesResponse.optional(b);
            if (!meta?.base || typeof meta.base !== 'string') return true;
            // filter out NFTs and LP tokens
            return !(
              assetPatterns.auctionNft.matches(meta.base) ||
              assetPatterns.lpNft.matches(meta.base) ||
              assetPatterns.proposalNft.matches(meta.base) ||
              assetPatterns.votingReceipt.matches(meta.base) ||
              assetPatterns.delegationToken.matches(meta.base) ||
              assetPatterns.unbondingToken.matches(meta.base)
            );
          })
          .sort((a, b) => {
            const aScore = getMetadataFromBalancesResponse.optional(a)?.priorityScore ?? 0n;
            const bScore = getMetadataFromBalancesResponse.optional(b)?.priorityScore ?? 0n;
            return Number(bScore - aScore);
          });
      } catch {
        return [];
      }
    },
  });

  // fetch all known assets for swap output selection
  const { data: allAssets = [], isLoading: assetsLoading } = useQuery({
    queryKey: ['assets'],
    staleTime: 300_000,
    queryFn: async () => {
      try {
        const raw = await Array.fromAsync(viewClient.assets({}));
        return raw
          .filter(resp => {
            const meta = resp.denomMetadata;
            if (!meta?.base || typeof meta.base !== 'string') return true;
            // filter out NFTs
            return !(
              assetPatterns.auctionNft.matches(meta.base) ||
              assetPatterns.lpNft.matches(meta.base) ||
              assetPatterns.proposalNft.matches(meta.base) ||
              assetPatterns.votingReceipt.matches(meta.base) ||
              assetPatterns.delegationToken.matches(meta.base) ||
              assetPatterns.unbondingToken.matches(meta.base)
            );
          })
          .sort((a, b) => Number((b.denomMetadata?.priorityScore ?? 0n) - (a.denomMetadata?.priorityScore ?? 0n)));
      } catch {
        return [];
      }
    },
  });

  // convert balances to input assets
  const inputAssets: InputAsset[] = useMemo(() => {
    return balances.map(b => {
      const symbol = b.balanceView ? getDisplayDenomFromView(b.balanceView) || 'Unknown' : 'Unknown';
      const amt = b.balanceView ? fromValueView(b.balanceView) : 0;
      const amount = typeof amt === 'string' ? amt : amt.toString();
      const assetId = b.balanceView ? getAssetIdFromValueView(b.balanceView)?.inner : undefined;
      const exponent = b.balanceView ? getDisplayDenomExponentFromValueView(b.balanceView) : 6;
      return { balance: b, symbol, amount, assetId, exponent };
    });
  }, [balances]);

  // convert all assets to output options
  const outputAssets: OutputAsset[] = useMemo(() => {
    return allAssets.map(resp => {
      const meta = resp.denomMetadata;
      const symbol = meta?.symbol || meta?.display || meta?.base || 'Unknown';
      const assetId = meta?.penumbraAssetId?.inner;
      const exponent = meta?.denomUnits?.find(u => u.denom === meta?.display)?.exponent ?? 6;
      return { response: resp, symbol, assetId, exponent };
    });
  }, [allAssets]);

  // auto-select first asset
  useEffect(() => {
    if (!selectedIn && inputAssets.length > 0) {
      setSelectedIn(inputAssets[0]);
    }
  }, [inputAssets, selectedIn]);

  // simulate swap to get output amount
  const { data: simulation, isLoading: simLoading, error: simError } = useQuery({
    queryKey: ['simulate', selectedIn?.assetId, selectedOut?.assetId, amountIn],
    enabled: !!selectedIn && !!selectedOut && parseFloat(amountIn) > 0,
    staleTime: 10_000,
    queryFn: async () => {
      if (!selectedIn || !selectedOut || !amountIn || parseFloat(amountIn) <= 0) return null;

      try {
        // convert amount to base units
        const multiplier = 10 ** selectedIn.exponent;
        const baseAmount = BigInt(Math.floor(parseFloat(amountIn) * multiplier));

        const inputValue = new Value({
          amount: new Amount({ lo: baseAmount, hi: 0n }),
          assetId: { inner: selectedIn.assetId },
        });

        const result = await simulationClient.simulateTrade({
          input: inputValue,
          output: { inner: selectedOut.assetId },
        });

        // get output amount from swap execution traces
        // the simulation returns output as SwapExecution which has traces
        const execution = result.output;
        if (!execution) return null;

        // get total output from traces
        let totalOutput = 0n;
        for (const trace of execution.traces ?? []) {
          // last value in trace is the output
          const outputValue = trace.value?.at(-1);
          if (outputValue?.amount) {
            totalOutput += outputValue.amount.lo ?? 0n;
          }
        }

        const outputAmount = Number(totalOutput) / (10 ** selectedOut.exponent);

        return {
          outputAmount: outputAmount.toFixed(6),
          priceImpact: result.unfilled ? 'partial fill' : undefined,
        };
      } catch (err) {
        console.error('simulation error:', err);
        throw err;
      }
    },
  });

  const handleMax = useCallback(() => {
    if (selectedIn) {
      setAmountIn(selectedIn.amount);
    }
  }, [selectedIn]);

  // swap assets in and out
  const handleFlip = useCallback(() => {
    if (selectedIn && selectedOut) {
      // find if we have balance for the output asset
      const newIn = inputAssets.find(a =>
        a.assetId && selectedOut.assetId &&
        a.assetId.length === selectedOut.assetId.length &&
        a.assetId.every((v, i) => v === selectedOut.assetId![i])
      );
      if (newIn) {
        // find output asset for current input
        const newOut = outputAssets.find(a =>
          a.assetId && selectedIn.assetId &&
          a.assetId.length === selectedIn.assetId.length &&
          a.assetId.every((v, i) => v === selectedIn.assetId![i])
        );
        if (newOut) {
          setSelectedIn(newIn);
          setSelectedOut(newOut);
          setAmountIn('');
        }
      }
    }
  }, [selectedIn, selectedOut, inputAssets, outputAssets]);

  const canSubmit = selectedIn && selectedOut && parseFloat(amountIn) > 0 && simulation && txStatus === 'idle';

  const handleSubmit = useCallback(async () => {
    if (!canSubmit || !selectedIn || !selectedOut) return;

    setTxStatus('planning');
    setTxError(undefined);

    try {
      // convert amount to base units
      const multiplier = 10 ** selectedIn.exponent;
      const baseAmount = BigInt(Math.floor(parseFloat(amountIn) * multiplier));

      // create swap transaction planner request
      const planRequest = new TransactionPlannerRequest({
        swaps: [{
          targetAsset: { inner: selectedOut.assetId },
          value: new Value({
            amount: new Amount({ lo: baseAmount, hi: 0n }),
            assetId: { inner: selectedIn.assetId },
          }),
          claimAddress: undefined, // use default address
        }],
        source: { account: 0 },
      });

      setTxStatus('signing');
      const result = await penumbraTx.mutateAsync(planRequest);

      setTxStatus('success');
      setTxHash(result.txId);

      // refetch balances after swap
      void refetchBalances();
    } catch (err) {
      setTxStatus('error');
      setTxError(err instanceof Error ? err.message : 'swap failed');
    }
  }, [canSubmit, selectedIn, selectedOut, amountIn, penumbraTx, refetchBalances]);

  const handleReset = useCallback(() => {
    setTxStatus('idle');
    setTxHash(undefined);
    setTxError(undefined);
    setAmountIn('');
  }, []);

  return (
    <div className='flex flex-col gap-4 p-4'>
      <div className='flex items-center gap-2 mb-2'>
        <MixIcon className='h-5 w-5 text-zigner-gold' />
        <h2 className='text-lg font-semibold'>swap</h2>
      </div>

      {/* input asset */}
      <div className='rounded-lg border border-border bg-muted/20 p-3'>
        <div className='flex items-center justify-between mb-2'>
          <span className='text-xs text-muted-foreground'>you pay</span>
          {selectedIn && (
            <span className='text-xs text-muted-foreground'>
              balance: {selectedIn.amount}
            </span>
          )}
        </div>
        <div className='flex items-center gap-2'>
          <input
            type='text'
            value={amountIn}
            onChange={e => setAmountIn(e.target.value)}
            placeholder='0.00'
            disabled={txStatus !== 'idle'}
            className='flex-1 bg-transparent text-lg font-medium text-foreground placeholder:text-muted-foreground focus:outline-none disabled:opacity-50'
          />
          <button
            onClick={handleMax}
            disabled={txStatus !== 'idle' || !selectedIn}
            className='text-xs text-zigner-gold hover:text-zigner-gold-light disabled:opacity-50'
          >
            max
          </button>
        </div>
        <div className='mt-2 relative'>
          <button
            onClick={() => setAssetInOpen(!assetInOpen)}
            disabled={txStatus !== 'idle' || balancesLoading}
            className='flex items-center gap-2 rounded-md bg-background/50 px-3 py-1.5 text-sm transition-colors hover:bg-background disabled:opacity-50'
          >
            {balancesLoading ? (
              <span className='text-muted-foreground'>loading...</span>
            ) : selectedIn ? (
              <span className='font-medium'>{selectedIn.symbol}</span>
            ) : (
              <span className='text-muted-foreground'>select</span>
            )}
            <ChevronDownIcon className={cn('h-4 w-4 transition-transform', assetInOpen && 'rotate-180')} />
          </button>

          {assetInOpen && (
            <div className='absolute top-full left-0 right-0 z-20 mt-1 max-h-48 overflow-y-auto rounded-lg border border-border bg-background shadow-lg'>
              {inputAssets.map((item, i) => (
                <button
                  key={i}
                  onClick={() => {
                    setSelectedIn(item);
                    setAssetInOpen(false);
                  }}
                  className={cn(
                    'flex w-full items-center justify-between px-3 py-2 text-sm transition-colors hover:bg-muted/50',
                    selectedIn === item && 'bg-muted/30'
                  )}
                >
                  <span>{item.symbol}</span>
                  <span className='text-muted-foreground'>{item.amount}</span>
                </button>
              ))}
              {inputAssets.length === 0 && (
                <div className='px-3 py-2 text-sm text-muted-foreground'>no assets</div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* swap direction button */}
      <div className='flex justify-center -my-2'>
        <button
          onClick={handleFlip}
          disabled={txStatus !== 'idle' || !selectedIn || !selectedOut}
          className='rounded-full border border-border bg-background p-2 shadow-sm transition-colors hover:bg-muted disabled:opacity-50'
        >
          <ArrowDownIcon className='h-4 w-4' />
        </button>
      </div>

      {/* output asset */}
      <div className='rounded-lg border border-border bg-muted/20 p-3'>
        <div className='flex items-center justify-between mb-2'>
          <span className='text-xs text-muted-foreground'>you receive</span>
          {simLoading && (
            <span className='flex items-center gap-1 text-xs text-muted-foreground'>
              <UpdateIcon className='h-3 w-3 animate-spin' />
              simulating...
            </span>
          )}
        </div>
        <div className='flex items-center gap-2'>
          <div className='flex-1 text-lg font-medium text-foreground'>
            {simulation?.outputAmount ?? '0.00'}
          </div>
        </div>
        <div className='mt-2 relative'>
          <button
            onClick={() => setAssetOutOpen(!assetOutOpen)}
            disabled={txStatus !== 'idle' || assetsLoading}
            className='flex items-center gap-2 rounded-md bg-background/50 px-3 py-1.5 text-sm transition-colors hover:bg-background disabled:opacity-50'
          >
            {assetsLoading ? (
              <span className='text-muted-foreground'>loading...</span>
            ) : selectedOut ? (
              <span className='font-medium'>{selectedOut.symbol}</span>
            ) : (
              <span className='text-muted-foreground'>select</span>
            )}
            <ChevronDownIcon className={cn('h-4 w-4 transition-transform', assetOutOpen && 'rotate-180')} />
          </button>

          {assetOutOpen && (
            <div className='absolute top-full left-0 right-0 z-20 mt-1 max-h-48 overflow-y-auto rounded-lg border border-border bg-background shadow-lg'>
              {outputAssets
                .filter(a => {
                  // exclude currently selected input asset
                  if (!selectedIn?.assetId || !a.assetId) return true;
                  if (selectedIn.assetId.length !== a.assetId.length) return true;
                  return !selectedIn.assetId.every((v, i) => v === a.assetId![i]);
                })
                .map((item, i) => (
                  <button
                    key={i}
                    onClick={() => {
                      setSelectedOut(item);
                      setAssetOutOpen(false);
                    }}
                    className={cn(
                      'flex w-full items-center px-3 py-2 text-sm transition-colors hover:bg-muted/50',
                      selectedOut?.symbol === item.symbol && 'bg-muted/30'
                    )}
                  >
                    <span>{item.symbol}</span>
                  </button>
                ))}
              {outputAssets.length === 0 && (
                <div className='px-3 py-2 text-sm text-muted-foreground'>no assets</div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* simulation info */}
      {simulation?.priceImpact && (
        <div className='rounded-lg border border-yellow-500/30 bg-yellow-500/10 p-2'>
          <p className='text-xs text-yellow-400'>
            {simulation.priceImpact}
          </p>
        </div>
      )}

      {simError && (
        <p className='text-xs text-red-500'>
          {(simError as Error).message || 'failed to simulate swap'}
        </p>
      )}

      {/* transaction status */}
      {txStatus === 'success' && txHash && (
        <div className='rounded-lg border border-green-500/30 bg-green-500/10 p-3'>
          <p className='text-sm text-green-400'>swap submitted!</p>
          <p className='text-xs text-muted-foreground mt-1 font-mono break-all'>
            {txHash}
          </p>
          <p className='text-xs text-muted-foreground mt-2'>
            note: swap outputs will be available after the claim transaction is processed.
          </p>
        </div>
      )}

      {txStatus === 'error' && txError && (
        <div className='rounded-lg border border-red-500/30 bg-red-500/10 p-3'>
          <p className='text-sm text-red-400'>swap failed</p>
          <p className='text-xs text-muted-foreground mt-1'>{txError}</p>
        </div>
      )}

      {/* submit button */}
      <button
        onClick={() => {
          if (txStatus === 'success' || txStatus === 'error') {
            handleReset();
          } else {
            void handleSubmit();
          }
        }}
        disabled={
          (txStatus === 'idle' && !canSubmit) ||
          txStatus === 'planning' ||
          txStatus === 'signing' ||
          txStatus === 'broadcasting'
        }
        className={cn(
          'mt-2 w-full rounded-lg bg-zigner-gold py-3 text-sm font-medium text-zigner-dark',
          'transition-all duration-100 hover:bg-zigner-gold-light active:scale-[0.99]',
          'disabled:opacity-50 disabled:cursor-not-allowed'
        )}
      >
        {txStatus === 'planning' && 'building swap...'}
        {txStatus === 'signing' && 'signing...'}
        {txStatus === 'broadcasting' && 'broadcasting...'}
        {txStatus === 'idle' && (simLoading ? 'simulating...' : 'swap')}
        {txStatus === 'success' && 'swap again'}
        {txStatus === 'error' && 'retry'}
      </button>

      <p className='text-center text-xs text-muted-foreground'>
        private swap using penumbra dex
      </p>
    </div>
  );
};
