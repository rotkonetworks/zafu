/**
 * swap page
 *
 * penumbra: private on-chain DEX swap via simulation service
 * zcash: crosschain swap via NEAR 1Click (same API as Zashi mobile)
 */

import { useState, useMemo, useCallback, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { MixIcon, ChevronDownIcon, UpdateIcon, ArrowDownIcon, CopyIcon, CheckIcon } from '@radix-ui/react-icons';
import { viewClient, simulationClient } from '../../../clients';
import { usePenumbraTransaction } from '../../../hooks/penumbra-transaction';
import { useStore } from '../../../state';
import { selectActiveNetwork, selectPenumbraAccount } from '../../../state/keyring';
import { TransactionPlannerRequest } from '@penumbra-zone/protobuf/penumbra/view/v1/view_pb';
import { Amount } from '@penumbra-zone/protobuf/penumbra/core/num/v1/num_pb';
import { Value } from '@penumbra-zone/protobuf/penumbra/core/asset/v1/asset_pb';
import { getMetadataFromBalancesResponse } from '@penumbra-zone/getters/balances-response';
import { getDisplayDenomFromView, getAssetIdFromValueView, getDisplayDenomExponentFromValueView } from '@penumbra-zone/getters/value-view';
import { fromValueView } from '@rotko/penumbra-types/amount';
import { assetPatterns } from '@rotko/penumbra-types/assets';
import { cn } from '@repo/ui/lib/utils';
import { useActiveAddress } from '../../../hooks/use-address';
import { getBalanceInWorker } from '../../../state/keyring/network-worker';
import {
  getSupportedTokens,
  requestQuote,
  checkSwapStatus,
  filterSwappableTokens,
  toBaseUnits,
  ZEC_ASSET_ID,
  type NearToken,
  type SwapQuoteResponse,
  type SwapStatus,
} from '../../../state/near-swap';
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

export const SwapPage = () => {
  const activeNetwork = useStore(selectActiveNetwork);

  if (activeNetwork === 'zcash') return <ZcashCrosschainSwap />;
  if (activeNetwork === 'penumbra') return <PenumbraSwap />;

  return (
    <div className='flex flex-col items-center justify-center gap-4 p-6 pt-16 text-center'>
      <div className='rounded-full bg-primary/10 p-4'>
        <MixIcon className='h-8 w-8 text-primary' />
      </div>
      <div>
        <h2 className='text-lg font-semibold'>swap</h2>
        <p className='mt-1 text-sm text-muted-foreground'>
          swapping is not available for this network.
        </p>
      </div>
    </div>
  );
};

// ── Zcash Crosschain Swap (NEAR 1Click) ──

type ZcashSwapStep = 'input' | 'quoting' | 'deposit' | 'polling' | 'done' | 'error';

const ZcashCrosschainSwap = () => {
  const { address: zcashAddress } = useActiveAddress();
  const [step, setStep] = useState<ZcashSwapStep>('input');
  const [direction, setDirection] = useState<'from_zec' | 'into_zec'>('from_zec');
  const [amountIn, setAmountIn] = useState('');
  const [selectedToken, setSelectedToken] = useState<NearToken | undefined>();
  const [tokenPickerOpen, setTokenPickerOpen] = useState(false);
  const [destinationAddress, setDestinationAddress] = useState('');
  const [quote, setQuote] = useState<SwapQuoteResponse | undefined>();
  const [swapStatus, setSwapStatus] = useState<SwapStatus | null>(null);
  const [error, setError] = useState<string | undefined>();
  const [copied, setCopied] = useState(false);
  const [balanceZec, setBalanceZec] = useState<string | undefined>();

  // fetch ZEC balance
  useEffect(() => {
    getBalanceInWorker('zcash', 'default').then(b => {
      const zec = (Number(b) / 1e8).toFixed(8);
      setBalanceZec(zec);
    }).catch(() => {});
  }, []);

  // fetch supported tokens
  const { data: tokens = [], isLoading: tokensLoading } = useQuery({
    queryKey: ['near-tokens'],
    staleTime: 300_000,
    queryFn: async () => {
      const all = await getSupportedTokens();
      return filterSwappableTokens(all);
    },
  });

  // popular tokens first
  const sortedTokens = useMemo(() => {
    const popular = ['BTC', 'ETH', 'USDC', 'USDT', 'SOL', 'NEAR'];
    return [...tokens].sort((a, b) => {
      const ai = popular.indexOf(a.symbol);
      const bi = popular.indexOf(b.symbol);
      if (ai >= 0 && bi >= 0) return ai - bi;
      if (ai >= 0) return -1;
      if (bi >= 0) return 1;
      return a.symbol.localeCompare(b.symbol);
    });
  }, [tokens]);

  const handleRequestQuote = useCallback(async () => {
    if (!selectedToken || !amountIn || parseFloat(amountIn) <= 0 || !zcashAddress) return;

    setStep('quoting');
    setError(undefined);

    try {
      const isFromZec = direction === 'from_zec';
      const originAsset = isFromZec ? ZEC_ASSET_ID : selectedToken.assetId;
      const destAsset = isFromZec ? selectedToken.assetId : ZEC_ASSET_ID;
      const originDecimals = isFromZec ? 8 : selectedToken.decimals;
      const amount = toBaseUnits(amountIn, originDecimals);

      // recipient: where the output goes
      const recipient = isFromZec ? (destinationAddress || '') : zcashAddress;
      // refund: where to return funds if swap fails
      const refundTo = isFromZec ? zcashAddress : (destinationAddress || '');

      if (isFromZec && !destinationAddress) {
        setError('enter destination address for the receiving chain');
        setStep('input');
        return;
      }
      if (!isFromZec && !destinationAddress) {
        setError('enter your address on the sending chain');
        setStep('input');
        return;
      }

      const resp = await requestQuote({
        swapType: 'EXACT_INPUT',
        amount,
        originAsset,
        destinationAsset: destAsset,
        recipient,
        refundTo,
      });

      setQuote(resp);
      setStep('deposit');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed to get quote');
      setStep('error');
    }
  }, [selectedToken, amountIn, direction, zcashAddress, destinationAddress]);

  // poll swap status when in deposit/polling step
  useEffect(() => {
    if ((step !== 'deposit' && step !== 'polling') || !quote) return;

    const interval = setInterval(async () => {
      try {
        const status = await checkSwapStatus(quote.quote.depositAddress);
        setSwapStatus(status.status);
        if (status.status === 'SUCCESS') {
          setStep('done');
        } else if (status.status === 'FAILED' || status.status === 'REFUNDED') {
          setError(`swap ${status.status.toLowerCase()}`);
          setStep('error');
        } else if (status.status && status.status !== 'INCOMPLETE_DEPOSIT') {
          setStep('polling');
        }
      } catch { /* continue polling */ }
    }, 5000);

    return () => clearInterval(interval);
  }, [step, quote]);

  const handleCopyDeposit = useCallback(() => {
    if (!quote) return;
    void navigator.clipboard.writeText(quote.quote.depositAddress);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  }, [quote]);

  const handleReset = useCallback(() => {
    setStep('input');
    setQuote(undefined);
    setSwapStatus(null);
    setError(undefined);
    setAmountIn('');
  }, []);

  const canQuote = selectedToken && parseFloat(amountIn) > 0 && zcashAddress &&
    (direction === 'from_zec' ? destinationAddress : destinationAddress);

  return (
    <div className='flex flex-col gap-4 p-4'>
      <div className='flex items-center gap-2 mb-2'>
        <MixIcon className='h-5 w-5 text-zigner-gold' />
        <h2 className='text-lg font-semibold'>crosschain swap</h2>
      </div>

      {/* direction toggle */}
      <div className='flex gap-2'>
        <button
          onClick={() => setDirection('from_zec')}
          disabled={step !== 'input'}
          className={cn(
            'flex-1 rounded-lg py-2 text-sm font-medium transition-colors',
            direction === 'from_zec'
              ? 'bg-primary text-primary-foreground'
              : 'bg-muted text-muted-foreground hover:bg-muted/80',
            step !== 'input' && 'opacity-50'
          )}
        >
          ZEC &rarr; other
        </button>
        <button
          onClick={() => setDirection('into_zec')}
          disabled={step !== 'input'}
          className={cn(
            'flex-1 rounded-lg py-2 text-sm font-medium transition-colors',
            direction === 'into_zec'
              ? 'bg-primary text-primary-foreground'
              : 'bg-muted text-muted-foreground hover:bg-muted/80',
            step !== 'input' && 'opacity-50'
          )}
        >
          other &rarr; ZEC
        </button>
      </div>

      {step === 'input' && (
        <>
          {/* amount input */}
          <div className='rounded-lg border border-border bg-muted/20 p-3'>
            <div className='flex items-center justify-between mb-2'>
              <span className='text-xs text-muted-foreground'>
                {direction === 'from_zec' ? 'you send' : 'you send'}
              </span>
              {direction === 'from_zec' && balanceZec && (
                <span className='text-xs text-muted-foreground'>
                  balance: {balanceZec} ZEC
                </span>
              )}
            </div>
            <div className='flex items-center gap-2'>
              <input
                type='text'
                value={amountIn}
                onChange={e => setAmountIn(e.target.value)}
                placeholder='0.00'
                className='flex-1 bg-transparent text-lg font-medium text-foreground placeholder:text-muted-foreground focus:outline-none'
              />
              {direction === 'from_zec' && balanceZec && (
                <button
                  onClick={() => {
                    const max = Math.max(0, parseFloat(balanceZec) - 0.0001);
                    setAmountIn(max.toFixed(8));
                  }}
                  className='text-xs text-zigner-gold hover:text-zigner-gold-light'
                >
                  max
                </button>
              )}
            </div>
            <div className='mt-1 text-xs text-muted-foreground'>
              {direction === 'from_zec' ? 'ZEC' : selectedToken?.symbol ?? 'select token'}
            </div>
          </div>

          <div className='flex justify-center -my-2'>
            <ArrowDownIcon className='h-4 w-4 text-muted-foreground' />
          </div>

          {/* token selector */}
          <div className='rounded-lg border border-border bg-muted/20 p-3'>
            <div className='flex items-center justify-between mb-2'>
              <span className='text-xs text-muted-foreground'>
                {direction === 'from_zec' ? 'you receive' : 'you receive ZEC'}
              </span>
            </div>
            <div className='relative'>
              <button
                onClick={() => setTokenPickerOpen(!tokenPickerOpen)}
                disabled={tokensLoading}
                className='flex items-center gap-2 rounded-md bg-background/50 px-3 py-1.5 text-sm transition-colors hover:bg-background disabled:opacity-50'
              >
                {tokensLoading ? (
                  <span className='text-muted-foreground'>loading tokens...</span>
                ) : selectedToken ? (
                  <span className='font-medium'>
                    {selectedToken.symbol}
                    <span className='ml-1 text-muted-foreground text-xs'>({selectedToken.blockchain})</span>
                  </span>
                ) : (
                  <span className='text-muted-foreground'>select token</span>
                )}
                <ChevronDownIcon className={cn('h-4 w-4 transition-transform', tokenPickerOpen && 'rotate-180')} />
              </button>

              {tokenPickerOpen && (
                <div className='absolute top-full left-0 right-0 z-20 mt-1 max-h-48 overflow-y-auto rounded-lg border border-border bg-background shadow-lg'>
                  {sortedTokens.map((t) => (
                    <button
                      key={t.assetId}
                      onClick={() => {
                        setSelectedToken(t);
                        setTokenPickerOpen(false);
                      }}
                      className={cn(
                        'flex w-full items-center justify-between px-3 py-2 text-sm transition-colors hover:bg-muted/50',
                        selectedToken?.assetId === t.assetId && 'bg-muted/30'
                      )}
                    >
                      <span className='font-medium'>{t.symbol}</span>
                      <span className='text-xs text-muted-foreground'>{t.blockchain}</span>
                    </button>
                  ))}
                  {sortedTokens.length === 0 && (
                    <div className='px-3 py-2 text-sm text-muted-foreground'>no tokens available</div>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* destination address */}
          <div className='rounded-lg border border-border bg-muted/20 p-3'>
            <div className='text-xs text-muted-foreground mb-1'>
              {direction === 'from_zec'
                ? `${selectedToken?.blockchain ?? 'destination'} address`
                : `your ${selectedToken?.blockchain ?? 'source'} address (for sending + refund)`}
            </div>
            <input
              type='text'
              value={destinationAddress}
              onChange={e => setDestinationAddress(e.target.value)}
              placeholder={direction === 'from_zec' ? 'recipient address' : 'your address on source chain'}
              className='w-full bg-transparent text-sm font-mono text-foreground placeholder:text-muted-foreground focus:outline-none'
            />
          </div>

          {error && (
            <p className='text-xs text-red-500'>{error}</p>
          )}

          <button
            onClick={() => void handleRequestQuote()}
            disabled={!canQuote}
            className={cn(
              'w-full rounded-lg bg-zigner-gold py-3 text-sm font-medium text-zigner-dark',
              'transition-all duration-100 hover:bg-zigner-gold-light active:scale-[0.99]',
              'disabled:opacity-50 disabled:cursor-not-allowed'
            )}
          >
            get quote
          </button>

          <p className='text-center text-xs text-muted-foreground'>
            crosschain swap via NEAR 1Click
          </p>
        </>
      )}

      {step === 'quoting' && (
        <div className='flex flex-col items-center gap-3 py-8'>
          <UpdateIcon className='h-6 w-6 animate-spin text-muted-foreground' />
          <p className='text-sm text-muted-foreground'>fetching quote...</p>
        </div>
      )}

      {(step === 'deposit' || step === 'polling') && quote && (
        <div className='flex flex-col gap-3'>
          {/* quote summary */}
          <div className='rounded-lg border border-border bg-muted/20 p-3'>
            <div className='text-xs text-muted-foreground mb-2'>quote</div>
            <div className='flex justify-between text-sm'>
              <span>you send</span>
              <span className='font-medium'>
                {quote.quote.amountInFormatted}
                {' '}
                {direction === 'from_zec' ? 'ZEC' : selectedToken?.symbol}
              </span>
            </div>
            <div className='flex justify-between text-sm mt-1'>
              <span>you receive</span>
              <span className='font-medium'>
                {quote.quote.amountOutFormatted}
                {' '}
                {direction === 'from_zec' ? selectedToken?.symbol : 'ZEC'}
              </span>
            </div>
            {quote.quote.amountInUsd !== '0' && (
              <div className='flex justify-between text-xs text-muted-foreground mt-1'>
                <span>value</span>
                <span>${parseFloat(quote.quote.amountInUsd).toFixed(2)}</span>
              </div>
            )}
          </div>

          {/* deposit address */}
          <div className='rounded-lg border border-zigner-gold/30 bg-zigner-gold/5 p-3'>
            <div className='text-xs text-muted-foreground mb-1'>
              {direction === 'from_zec'
                ? 'send ZEC to this address'
                : `send ${selectedToken?.symbol} to this address`}
            </div>
            <div className='flex items-start gap-2'>
              <p className='flex-1 text-xs font-mono text-foreground break-all'>
                {quote.quote.depositAddress}
              </p>
              <button onClick={handleCopyDeposit} className='shrink-0 p-1 hover:text-zigner-gold'>
                {copied ? <CheckIcon className='h-4 w-4' /> : <CopyIcon className='h-4 w-4' />}
              </button>
            </div>
          </div>

          {/* status */}
          <div className='rounded-lg border border-border bg-muted/20 p-3'>
            <div className='flex items-center gap-2'>
              {step === 'polling' ? (
                <UpdateIcon className='h-4 w-4 animate-spin text-zigner-gold' />
              ) : (
                <div className='h-2 w-2 rounded-full bg-yellow-500 animate-pulse' />
              )}
              <span className='text-sm'>
                {swapStatus === 'PROCESSING' && 'processing swap...'}
                {swapStatus === 'PENDING_DEPOSIT' && 'deposit detected, waiting for confirmations...'}
                {swapStatus === 'KNOWN_DEPOSIT_TX' && 'deposit transaction found...'}
                {swapStatus === 'INCOMPLETE_DEPOSIT' && 'waiting for full deposit...'}
                {!swapStatus && 'waiting for deposit...'}
              </span>
            </div>
          </div>

          <button
            onClick={handleReset}
            className='text-xs text-muted-foreground hover:text-foreground'
          >
            cancel
          </button>
        </div>
      )}

      {step === 'done' && (
        <div className='flex flex-col gap-3'>
          <div className='rounded-lg border border-green-500/30 bg-green-500/10 p-3'>
            <p className='text-sm text-green-400'>swap complete!</p>
            {quote && (
              <p className='text-xs text-muted-foreground mt-1'>
                {quote.quote.amountInFormatted} {direction === 'from_zec' ? 'ZEC' : selectedToken?.symbol}
                {' → '}
                {quote.quote.amountOutFormatted} {direction === 'from_zec' ? selectedToken?.symbol : 'ZEC'}
              </p>
            )}
          </div>
          <button
            onClick={handleReset}
            className={cn(
              'w-full rounded-lg bg-zigner-gold py-3 text-sm font-medium text-zigner-dark',
              'transition-all duration-100 hover:bg-zigner-gold-light active:scale-[0.99]'
            )}
          >
            swap again
          </button>
        </div>
      )}

      {step === 'error' && (
        <div className='flex flex-col gap-3'>
          <div className='rounded-lg border border-red-500/30 bg-red-500/10 p-3'>
            <p className='text-sm text-red-400'>swap failed</p>
            <p className='text-xs text-muted-foreground mt-1'>{error}</p>
          </div>
          <button
            onClick={handleReset}
            className={cn(
              'w-full rounded-lg bg-zigner-gold py-3 text-sm font-medium text-zigner-dark',
              'transition-all duration-100 hover:bg-zigner-gold-light active:scale-[0.99]'
            )}
          >
            try again
          </button>
        </div>
      )}
    </div>
  );
};

// ── Penumbra DEX Swap ──

const PenumbraSwap = () => {
  const penumbraAccount = useStore(selectPenumbraAccount);
  const [amountIn, setAmountIn] = useState('');
  const [assetInOpen, setAssetInOpen] = useState(false);
  const [assetOutOpen, setAssetOutOpen] = useState(false);
  const [selectedIn, setSelectedIn] = useState<InputAsset | undefined>();
  const [selectedOut, setSelectedOut] = useState<OutputAsset | undefined>();
  const [txStatus, setTxStatus] = useState<'idle' | 'planning' | 'signing' | 'broadcasting' | 'success' | 'error'>('idle');
  const [txHash, setTxHash] = useState<string | undefined>();
  const [txError, setTxError] = useState<string | undefined>();

  const penumbraTx = usePenumbraTransaction();

  // fetch balances
  const { data: balances = [], isLoading: balancesLoading, refetch: refetchBalances } = useQuery({
    queryKey: ['balances', penumbraAccount],
    staleTime: 30_000,
    queryFn: async () => {
      try {
        const raw = await Array.fromAsync(viewClient.balances({ accountFilter: { account: penumbraAccount } }));
        return raw
          .filter(b => {
            const meta = getMetadataFromBalancesResponse.optional(b);
            if (!meta?.base || typeof meta.base !== 'string') return true;
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

  const outputAssets: OutputAsset[] = useMemo(() => {
    return allAssets.map(resp => {
      const meta = resp.denomMetadata;
      const symbol = meta?.symbol || meta?.display || meta?.base || 'Unknown';
      const assetId = meta?.penumbraAssetId?.inner;
      const exponent = meta?.denomUnits?.find(u => u.denom === meta?.display)?.exponent ?? 6;
      return { response: resp, symbol, assetId, exponent };
    });
  }, [allAssets]);

  useEffect(() => {
    if (!selectedIn && inputAssets.length > 0) {
      setSelectedIn(inputAssets[0]);
    }
  }, [inputAssets, selectedIn]);

  const { data: simulation, isLoading: simLoading, error: simError } = useQuery({
    queryKey: ['simulate', selectedIn?.assetId, selectedOut?.assetId, amountIn],
    enabled: !!selectedIn && !!selectedOut && parseFloat(amountIn) > 0,
    staleTime: 10_000,
    queryFn: async () => {
      if (!selectedIn || !selectedOut || !amountIn || parseFloat(amountIn) <= 0) return null;

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

      const execution = result.output;
      if (!execution) return null;

      let totalOutput = 0n;
      for (const trace of execution.traces ?? []) {
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
    },
  });

  const handleMax = useCallback(() => {
    if (selectedIn) setAmountIn(selectedIn.amount);
  }, [selectedIn]);

  const handleFlip = useCallback(() => {
    if (selectedIn && selectedOut) {
      const newIn = inputAssets.find(a =>
        a.assetId && selectedOut.assetId &&
        a.assetId.length === selectedOut.assetId.length &&
        a.assetId.every((v, i) => v === selectedOut.assetId![i])
      );
      if (newIn) {
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
      const multiplier = 10 ** selectedIn.exponent;
      const baseAmount = BigInt(Math.floor(parseFloat(amountIn) * multiplier));

      const planRequest = new TransactionPlannerRequest({
        swaps: [{
          targetAsset: { inner: selectedOut.assetId },
          value: new Value({
            amount: new Amount({ lo: baseAmount, hi: 0n }),
            assetId: { inner: selectedIn.assetId },
          }),
          claimAddress: undefined,
        }],
        source: { account: penumbraAccount },
      });

      setTxStatus('signing');
      const result = await penumbraTx.mutateAsync(planRequest);

      setTxStatus('success');
      setTxHash(result.txId);
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
                  onClick={() => { setSelectedIn(item); setAssetInOpen(false); }}
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

      {/* swap direction */}
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
                  if (!selectedIn?.assetId || !a.assetId) return true;
                  if (selectedIn.assetId.length !== a.assetId.length) return true;
                  return !selectedIn.assetId.every((v, i) => v === a.assetId![i]);
                })
                .map((item, i) => (
                  <button
                    key={i}
                    onClick={() => { setSelectedOut(item); setAssetOutOpen(false); }}
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

      {simulation?.priceImpact && (
        <div className='rounded-lg border border-yellow-500/30 bg-yellow-500/10 p-2'>
          <p className='text-xs text-yellow-400'>{simulation.priceImpact}</p>
        </div>
      )}

      {simError && (
        <p className='text-xs text-red-500'>
          {(simError as Error).message || 'failed to simulate swap'}
        </p>
      )}

      {txStatus === 'success' && txHash && (
        <div className='rounded-lg border border-green-500/30 bg-green-500/10 p-3'>
          <p className='text-sm text-green-400'>swap submitted!</p>
          <p className='text-xs text-muted-foreground mt-1 font-mono break-all'>{txHash}</p>
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

      <button
        onClick={() => {
          if (txStatus === 'success' || txStatus === 'error') handleReset();
          else void handleSubmit();
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
