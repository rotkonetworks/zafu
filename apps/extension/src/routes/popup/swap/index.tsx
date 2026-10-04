/**
 * swap page
 *
 * penumbra: private on-chain DEX swap via simulation service
 * zcash: crosschain swap over every route that carries the pair (crosschain.tsx)
 */

import { useState, useMemo, useCallback, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useLocation } from 'react-router-dom';
import { viewClient, simulationClient } from '../../../clients';
import { Button } from '@repo/ui/components/ui/button';
import { Row, RowGroup } from '@repo/ui/components/ui/row';
import { Sensitive } from '../../../components/sensitive';
import { ScreenHeader } from '../../../components/screen-header';
import { useStore } from '../../../state';
import { selectActiveNetwork, selectPenumbraAccount } from '../../../state/keyring';
import { TransactionPlannerRequest } from '@penumbra-zone/protobuf/penumbra/view/v1/view_pb';
import { Amount } from '@penumbra-zone/protobuf/penumbra/core/num/v1/num_pb';
import { Value, Metadata } from '@penumbra-zone/protobuf/penumbra/core/asset/v1/asset_pb';
import { getMetadataFromBalancesResponse } from '@penumbra-zone/getters/balances-response';
import { getAssetIdFromValueView } from '@penumbra-zone/getters/value-view';
import { symbolFromMetadata } from '../../../utils/asset-display';
import { fromValueView } from '@penumbrafi/types/amount';
import { isFungibleMetadata, selectPickerBuckets } from '../../../utils/is-fungible-asset';
import { balancesQueryOptions } from '../../../hooks/penumbra-balances';
import type {
  BalancesResponse,
  AssetsResponse,
} from '@penumbra-zone/protobuf/penumbra/view/v1/view_pb';
import { useBackNav } from '../../../utils/navigate';
import { PenumbraFlow } from '../send/penumbra-flow';
import { Footer, Main } from '../send/send-ui';
import { AmountField, PickSheet } from '../send/send-fields';
import { BalanceSheet } from '../send/balance-sheet';
import { PopupPath } from '../paths';
import { hasFeature } from '../../../config/networks';
import type { SwapLinkState } from '../../../links/land';
import { CrosschainSwap } from './crosschain';
import { splitLoHi } from '@penumbrafi/types/lo-hi';
import { fromUnits } from '../../../state/swap/provider';
import { toBaseUnits } from '../../../state/ibc-withdraw-amount';
import { traceOut, u128 } from './penumbra-units';
import { reachOf, splitByReach } from './reachable';
import { usePenumbraRoutes } from '../../../transparent/penumbra-routes';
import { chainByChainId } from '@repo/wallet/networks/cosmos/chains';

/**
 * Router state accepted by the swap page. Set from the row-level "Swap X"
 * quick-action on the home asset list so the from-leg boots pre-selected.
 */
interface SwapLocationState extends Partial<SwapLinkState> {
  /** an open swap to reopen where it stood (home's in-flight card) */
  resume?: string;
  /** Base denom of the asset to preselect as the FROM leg. Falls back to
   *  top-priority balance when the denom is not found. */
  prefillFromAsset?: string;
}

/** input asset with balance */
interface InputAsset {
  balance: BalancesResponse;
  symbol: string;
  amount: string;
  assetId: Uint8Array | undefined;
  exponent: number;
  metadata?: Metadata;
}

/** stable empty list so memo/effect deps don't churn while balances load */
const EMPTY_BALANCES: BalancesResponse[] = [];

/**
 * The display unit's exponent from the asset's own metadata, or undefined
 * when the metadata does not say. Never a guess: an exponent off by k shows
 * a quote off by 10^k, and Penumbra swaps have no minimum output, so the
 * quote is the only safeguard the user gets. An asset without one is not
 * offered here.
 */
const displayExponent = (meta: Metadata | undefined): number | undefined =>
  meta?.denomUnits.find(u => u.denom === meta.display)?.exponent;

/** exact base units of what is typed, or undefined when it can't be sent as typed */
const typedUnits = (text: string, exponent: number): bigint | undefined => {
  try {
    return toBaseUnits(text, exponent);
  } catch {
    return undefined;
  }
};

const sameId = (a?: Uint8Array, b?: Uint8Array) =>
  !!a && !!b && a.length === b.length && a.every((v, i) => v === b[i]);

/** output asset from assets list */
interface OutputAsset {
  response: AssetsResponse;
  symbol: string;
  assetId: Uint8Array | undefined;
  exponent: number;
  metadata?: Metadata;
}

export const SwapPage = () => {
  const activeNetwork = useStore(selectActiveNetwork);
  const location = useLocation();
  const swapState = location.state as SwapLocationState | undefined;

  // gate on the capability, not the chain: a network without swap has no page
  // here. Which implementation renders below is chain-specific routing.
  if (!hasFeature(activeNetwork, 'swap')) {
    return (
      <div className='flex flex-col items-center justify-center gap-3 py-12 text-center'>
        <div className='bg-primary/10 p-4'>
          <span className='i-ph-shuffle h-8 w-8 text-zigner-gold' />
        </div>
        <div>
          <h2 className='text-lg'>swap</h2>
          <p className='mt-1 text-sm text-fg-muted'>swapping is not available for this network.</p>
        </div>
      </div>
    );
  }

  if (activeNetwork === 'zcash') {
    // a new link remounts the form, filled in afresh
    return (
      <CrosschainSwap
        key={location.key}
        link={swapState?.link ? { link: swapState.link, via: swapState.via } : undefined}
        resume={swapState?.resume}
      />
    );
  }
  if (swapState?.link) {
    return (
      <p className='px-4 py-12 text-center text-sm text-fg-muted'>
        swap links open with zcash · please switch to zcash, then open the link again
      </p>
    );
  }
  return <PenumbraSwap prefillFromAsset={swapState?.prefillFromAsset} />;
};

// ── Penumbra DEX Swap ──

const PenumbraSwap = ({ prefillFromAsset }: { prefillFromAsset?: string } = {}) => {
  const goBack = useBackNav(PopupPath.INDEX);
  const penumbraAccount = useStore(selectPenumbraAccount);
  const [amountIn, setAmountIn] = useState('');
  const [pick, setPick] = useState<'in' | 'out'>();
  const [selectedIn, setSelectedIn] = useState<InputAsset | undefined>();
  const [selectedOut, setSelectedOut] = useState<OutputAsset | undefined>();
  const [showClosed, setShowClosed] = useState(false);
  const routes = usePenumbraRoutes();

  // fetch balances
  // The ['balances', account] cache holds the RAW list (the home screen
  // preloads it); `select` buckets it per observer, so the picker filter
  // applies no matter who populated the cache.
  const {
    data: buckets,
    isLoading: balancesLoading,
    refetch: refetchBalances,
  } = useQuery({
    ...balancesQueryOptions(penumbraAccount),
    staleTime: 30_000,
    select: selectPickerBuckets,
  });
  const balances = buckets?.assets ?? EMPTY_BALANCES;
  const { data: allAssets = [], isLoading: assetsLoading } = useQuery({
    queryKey: ['assets'],
    staleTime: 300_000,
    queryFn: async () => {
      try {
        const raw = await Array.fromAsync(viewClient.assets({}));
        return raw
          .filter(resp => isFungibleMetadata(resp.denomMetadata))
          .sort((a, b) =>
            Number((b.denomMetadata?.priorityScore ?? 0n) - (a.denomMetadata?.priorityScore ?? 0n)),
          );
      } catch {
        return [];
      }
    },
  });

  const inputAssets: InputAsset[] = useMemo(() => {
    return balances.flatMap(b => {
      const metadata = getMetadataFromBalancesResponse.optional(b);
      const exponent = displayExponent(metadata);
      if (exponent === undefined) {
        return [];
      }
      const symbol = symbolFromMetadata(metadata);
      const amt = b.balanceView ? fromValueView(b.balanceView) : 0;
      const amount = typeof amt === 'string' ? amt : amt.toString();
      const assetId = b.balanceView ? getAssetIdFromValueView(b.balanceView)?.inner : undefined;
      return [{ balance: b, symbol, amount, assetId, exponent, metadata }];
    });
  }, [balances]);

  const outputAssets: OutputAsset[] = useMemo(() => {
    return allAssets.flatMap(resp => {
      const meta = resp.denomMetadata;
      const exponent = displayExponent(meta);
      if (exponent === undefined) {
        return [];
      }
      const symbol = symbolFromMetadata(meta);
      const assetId = meta?.penumbraAssetId?.inner;
      return [{ response: resp, symbol, assetId, exponent, metadata: meta }];
    });
  }, [allAssets]);

  // Auto-select the FROM leg. If the row-level "Swap X" quick-action passed
  // a base denom, prefer the matching input asset; fall back to the
  // top-priority balance so the form is never empty when the user has funds.
  useEffect(() => {
    if (selectedIn || inputAssets.length === 0) {
      return;
    }
    const match = prefillFromAsset
      ? inputAssets.find(a => a.metadata?.base === prefillFromAsset)
      : undefined;
    setSelectedIn(match ?? inputAssets[0]);
  }, [inputAssets, selectedIn, prefillFromAsset]);

  // exact base units of what is typed; never a float, never cut short: digits
  // past the asset's exponent are refused, not dropped, so what is reviewed
  // is what is swapped
  const typed = selectedIn && amountIn.trim() ? typedUnits(amountIn, selectedIn.exponent) : 0n;
  const tooPrecise =
    typed === undefined && (amountIn.split('.')[1]?.length ?? 0) > (selectedIn?.exponent ?? 0);
  const units = typed ?? 0n;
  const {
    data: simulation,
    isLoading: simLoading,
    error: simError,
  } = useQuery({
    queryKey: ['simulate', selectedIn?.assetId, selectedOut?.assetId, amountIn],
    enabled: !!selectedIn && !!selectedOut && units > 0n,
    staleTime: 10_000,
    queryFn: async () => {
      if (!selectedIn || !selectedOut || units <= 0n) {
        return null;
      }
      const result = await simulationClient.simulateTrade({
        input: new Value({
          amount: new Amount(splitLoHi(units)),
          assetId: { inner: selectedIn.assetId },
        }),
        output: { inner: selectedOut.assetId },
      });
      if (!result.output) {
        return null;
      }
      const out = traceOut(result.output.traces);
      // Penumbra always returns an `unfilled` Value; only a non-zero one is a
      // partial fill (input that couldn't fill at the price, returned to you).
      const unfilled = u128(result.unfilled?.amount);
      // the rate is against the filled input only: what came back never traded
      const filled = units - unfilled;
      const rate =
        filled > 0n
          ? Number(fromUnits(out, selectedOut.exponent, 18)) /
            Number(fromUnits(filled, selectedIn.exponent, 18))
          : 0;
      return {
        outputAmount: fromUnits(out, selectedOut.exponent, 6),
        rate: rate > 0 ? rate : undefined,
        unfilled:
          unfilled > 0n
            ? { amount: fromUnits(unfilled, selectedIn.exponent, 6), symbol: selectedIn.symbol }
            : undefined,
      };
    },
  });

  const handleMax = useCallback(() => {
    if (selectedIn) {
      setAmountIn(selectedIn.amount);
    }
  }, [selectedIn]);

  const handleFlip = useCallback(() => {
    const newIn = inputAssets.find(a => sameId(a.assetId, selectedOut?.assetId));
    const newOut = outputAssets.find(a => sameId(a.assetId, selectedIn?.assetId));
    if (newIn && newOut) {
      setSelectedIn(newIn);
      setSelectedOut(newOut);
      setAmountIn('');
    }
  }, [selectedIn, selectedOut, inputAssets, outputAssets]);

  const canReview = !!selectedIn && !!selectedOut && units > 0n && !!simulation;

  const plan = async () => {
    const { address: claimAddress } = await viewClient.addressByIndex({
      addressIndex: { account: penumbraAccount },
    });
    return new TransactionPlannerRequest({
      swaps: [
        {
          targetAsset: { inner: selectedOut!.assetId },
          value: new Value({
            amount: new Amount(splitLoHi(units)),
            assetId: { inner: selectedIn!.assetId },
          }),
          claimAddress,
        },
      ],
      source: { account: penumbraAccount },
    });
  };

  const unitIn = (selectedIn?.symbol ?? 'um').toLowerCase();
  const unitOut = (selectedOut?.symbol ?? 'asset').toLowerCase();
  const rate =
    simulation?.rate &&
    `1 ${unitIn} = ${
      simulation.rate < 0.001
        ? simulation.rate.toPrecision(3)
        : simulation.rate.toLocaleString(undefined, { maximumFractionDigits: 6 })
    } ${unitOut}`;
  const line = (
    <>
      <Sensitive>{`${amountIn} ${unitIn}`}</Sensitive> for about{' '}
      <Sensitive>{`${simulation?.outputAmount ?? '0'} ${unitOut}`}</Sensitive>
    </>
  );
  const { shown: reachableOut, hidden: closedOut } = splitByReach(
    outputAssets.filter(a => !sameId(a.assetId, selectedIn?.assetId)),
    a => a.metadata?.base,
    a => inputAssets.some(i => sameId(i.assetId, a.assetId)),
    routes,
  );
  const outChoices = showClosed ? [...reachableOut, ...closedOut] : reachableOut;
  const outDescription = (a: OutputAsset) => {
    const reach = reachOf(a.metadata?.base, routes);
    return reach.reachable
      ? reach.via && chainByChainId(reach.via)?.name.toLowerCase()
      : `${reach.via} · can't leave penumbra`;
  };

  return (
    <PenumbraFlow
      onClose={goBack}
      tx={{
        sending: <>swap {line}</>,
        label: `swap ${amountIn} ${selectedIn?.symbol ?? ''} for ${selectedOut?.symbol ?? ''}`,
        plan,
        onSent: () => {
          void refetchBalances();
          setAmountIn('');
        },
        review: {
          lead: 'you swap',
          amount: amountIn,
          unit: unitIn,
          rows: [
            ['you get about', `${simulation?.outputAmount ?? '0'} ${unitOut}`],
            ...(rate ? [['rate', rate] as const] : []),
            ['fee', 'shown before you approve'],
          ],
          privacy: 'shielded · the dex sees the batch, not you',
          confirm: 'swap',
        },
        done: <>{line} · it lands once the claim is processed</>,
      }}
    >
      {review => (
        <>
          <ScreenHeader title='swap' onBack={goBack} />
          <Main className='gap-[18px] pt-5'>
            <AmountField
              label='you pay'
              value={amountIn}
              onChange={setAmountIn}
              unit={balancesLoading ? 'reading' : unitIn}
              onUnit={() => setPick('in')}
              available={selectedIn?.amount}
              onMax={handleMax}
              canMax={!!selectedIn}
              autoFocus={!!prefillFromAsset}
              warn={!!simError || tooPrecise}
              helper={
                tooPrecise
                  ? `${(selectedIn?.symbol ?? 'this asset').toLowerCase()} goes to ${selectedIn?.exponent ?? 0} decimal places · please shorten the amount`
                  : simError
                    ? 'the dex could not price this right now · please try again'
                    : simulation?.unfilled
                      ? `only part fills at this price · ${simulation.unfilled.amount} ${simulation.unfilled.symbol.toLowerCase()} comes back`
                      : simLoading
                        ? 'pricing'
                        : rate
              }
            />
            <RowGroup>
              <Row
                type='value'
                label='you get'
                description={
                  selectedIn && selectedOut
                    ? `${simulation?.outputAmount ?? '0'} ${unitOut}`
                    : undefined
                }
                value={assetsLoading ? 'reading' : selectedOut ? unitOut : 'choose'}
                onPress={() => setPick('out')}
              />
            </RowGroup>
            {selectedIn && selectedOut && (
              <Button variant='quiet' size='sm' onClick={handleFlip} className='self-start px-0'>
                <span className='i-lucide-arrow-up-down size-3.5' />
                flip
              </Button>
            )}
          </Main>
          <Footer>
            <Button onClick={review} disabled={!canReview} className='w-full'>
              {simLoading ? 'pricing' : 'review swap'}
            </Button>
          </Footer>
          <BalanceSheet
            open={pick === 'in'}
            onOpenChange={o => setPick(o ? 'in' : undefined)}
            assets={balances}
            onPick={b => setSelectedIn(inputAssets.find(a => a.balance === b))}
          />
          <PickSheet
            title='you get'
            search
            open={pick === 'out'}
            onOpenChange={o => setPick(o ? 'out' : undefined)}
            picks={outChoices.map((a, i) => ({
              key: i,
              label: a.symbol,
              description: outDescription(a),
            }))}
            onPick={i => setSelectedOut(outChoices[i])}
            foot={
              closedOut.length > 0 && (
                <Button
                  variant='quiet'
                  size='sm'
                  onClick={() => setShowClosed(!showClosed)}
                  className='w-full'
                >
                  {showClosed
                    ? 'hide closed channels'
                    : `show ${closedOut.length} from closed channels`}
                </Button>
              )
            }
          />
        </>
      )}
    </PenumbraFlow>
  );
};
