/**
 * Regression tests for the LP-NFT picker pollution.
 *
 * Root cause: the home screen preloads `['balances', account]` with the RAW
 * balance list, while send / swap used to filter inside their own queryFn under
 * the SAME key. react-query served the preloaded raw cache and never ran the
 * picker's queryFn, so its filter never applied. The fix keeps ONE raw queryFn
 * for every consumer and filters per observer via `select`. These tests pin
 * that down against a real QueryClient cache.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { Metadata, ValueView } from '@penumbra-zone/protobuf/penumbra/core/asset/v1/asset_pb';
import { BalancesResponse } from '@penumbra-zone/protobuf/penumbra/view/v1/view_pb';
import {
  filterSelectableBalances,
  positionLabel,
  selectPickerBalances,
  selectPickerBuckets,
  selectPositionBalances,
  selectWithdrawableBalances,
} from '../utils/is-fungible-asset';

const balancesMock = vi.fn();
vi.mock('../clients', () => ({
  viewClient: { balances: (...args: unknown[]) => balancesMock(...args) },
}));

// imported after the mock is registered (vi.mock is hoisted anyway)
const { balancesQueryOptions, balancesQueryKey } = await import('./penumbra-balances');

const balanceOf = (
  base: string,
  display: string,
  symbol: string,
  priorityScore = 0n,
): BalancesResponse =>
  new BalancesResponse({
    balanceView: new ValueView({
      valueView: {
        case: 'knownAssetId',
        value: { metadata: new Metadata({ base, display, symbol, priorityScore }) },
      },
    }),
  });

// Realistic fixtures: LP NFTs carry base `lpnft_opened_...` and display
// `lpNft:opened(...)` (the display form the user saw flooding the picker).
const um = balanceOf('upenumbra', 'penumbra', 'UM', 50n);
const usdc = balanceOf('transfer/channel-2/uusdc', 'transfer/channel-2/usdc', 'USDC', 100n);
const lpOpen = balanceOf(
  'lpnft_opened_plpid1aaaaaaaaaaaaaaaaaaaaaaaaaaaaz',
  'lpNft:opened(plpid1aaaaaaaaaaaaaaaaaaaaaaaaaaaaz)',
  '',
);
const lpClosed = balanceOf(
  'lpnft_closed_plpid1bbbbbbbbbbbbbbbbbbbbbbbbbbbbz',
  'lpNft:closed(plpid1bbbbbbbbbbbbbbbbbbbbbbbbbbbbz)',
  '',
);
const auction = balanceOf('auctionnft_0_pauctid1ccccccccc', 'auctionnft_0_pauctid1ccccccccc', '');
const unnamed = balanceOf('passet1zzz', '', '');
const vote = balanceOf('voted_on_7', 'voted_on_7', '');
const proposal = balanceOf('proposal_7_deposit', 'proposal_7_deposit', '');
const delegation = balanceOf('udelegation_penumbravalid1x', 'delegation_penumbravalid1x', '');

const RAW = [lpOpen, um, unnamed, lpClosed, usdc, auction, vote, proposal, delegation];

describe('picker selectors', () => {
  it('assets = fungible AND named only, priorityScore desc', () => {
    expect(selectPickerBalances(RAW)).toEqual([usdc, um]);
  });

  it('positions = only LP / auction NFTs (governance + staking stay hidden)', () => {
    const positions = selectPositionBalances(RAW);
    expect(positions).toEqual([lpOpen, lpClosed, auction]);
    expect(positions).not.toContain(vote);
    expect(positions).not.toContain(proposal);
    expect(positions).not.toContain(delegation);
  });

  it('matches LP NFTs on display too when base is missing', () => {
    const displayOnly = balanceOf('', 'lpnft_opened_plpid1q', '');
    expect(selectPositionBalances([displayOnly])).toEqual([displayOnly]);
  });

  it('buckets agree with the individual selectors', () => {
    expect(selectPickerBuckets(RAW)).toEqual({
      assets: [usdc, um],
      positions: [lpOpen, lpClosed, auction],
    });
  });

  it('withdrawable keeps the IBC form semantics (selectable + base, original order)', () => {
    expect(selectWithdrawableBalances(RAW)).toEqual([um, usdc]);
    expect(filterSelectableBalances(RAW)).toEqual([um, usdc]);
  });

  it('never mutates the shared cached array', () => {
    const raw = [...RAW];
    selectPickerBuckets(raw);
    selectWithdrawableBalances(raw);
    expect(raw).toEqual(RAW);
  });

  it('labels positions by state + short id', () => {
    const meta = (b: BalancesResponse) =>
      b.balanceView?.valueView.case === 'knownAssetId'
        ? b.balanceView.valueView.value.metadata
        : undefined;
    expect(positionLabel(meta(lpOpen))).toBe('opened plpid1aaaa...aaaz');
    expect(positionLabel(meta(lpClosed))).toMatch(/^closed plpid1/);
    expect(positionLabel(meta(auction))).toMatch(/^auction pauctid1/);
    expect(positionLabel(meta(um))).toBeUndefined();
  });
});

describe('shared ["balances", account] cache', () => {
  let qc: QueryClient;

  beforeEach(() => {
    qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    balancesMock.mockReset();
  });

  afterEach(() => {
    qc.clear();
  });

  it('uses the exact key the preload and every consumer share', () => {
    expect(balancesQueryOptions(0).queryKey).toEqual(['balances', 0]);
    expect(balancesQueryKey(3)).toEqual(['balances', 3]);
  });

  // mount an observer the way useQuery does (subscribe triggers the
  // fetch-on-mount decision), let any fetch kick off, then unmount.
  const mount = async (observer: QueryObserver<never, Error, unknown>) => {
    const unsubscribe = observer.subscribe(() => undefined);
    await new Promise(resolve => setTimeout(resolve, 0));
    unsubscribe();
  };

  it('ROOT CAUSE: a filtering queryFn never runs once the preload seeded the raw list', async () => {
    // what the home preload does (fresh data, dataUpdatedAt = now)
    qc.setQueryData(['balances', 0], RAW);

    // the OLD picker shape: filter inside queryFn, same key, 30s staleTime
    const oldQueryFn = vi.fn(async () => selectPickerBalances(RAW));
    const old = new QueryObserver(qc, {
      queryKey: ['balances', 0],
      queryFn: oldQueryFn,
      staleTime: 30_000,
    });
    await mount(old as unknown as QueryObserver<never, Error, unknown>);
    expect(oldQueryFn).not.toHaveBeenCalled();
    expect(old.getCurrentResult().data).toContain(lpOpen); // the bug: LP NFTs reach the picker
  });

  it('FIX: picker select filters the preloaded raw cache (no LP NFTs, no unnamed)', async () => {
    qc.setQueryData(['balances', 0], RAW);

    const picker = new QueryObserver(qc, {
      ...balancesQueryOptions(0),
      staleTime: 30_000,
      select: selectPickerBuckets,
    });
    await mount(picker as unknown as QueryObserver<never, Error, unknown>);
    const result = picker.getCurrentResult().data;

    expect(balancesMock).not.toHaveBeenCalled(); // served from cache
    expect(result?.assets).toEqual([usdc, um]);
    expect(result?.assets).not.toContain(lpOpen);
    expect(result?.assets).not.toContain(lpClosed);
    expect(result?.assets).not.toContain(unnamed);
    expect(result?.positions).toEqual([lpOpen, lpClosed, auction]);
    // the cache itself is untouched raw data for the other consumers
    expect(qc.getQueryData(['balances', 0])).toBe(RAW);
  });

  it('order-independent: if the picker fetches first, the cache still holds RAW', async () => {
    balancesMock.mockImplementation(async function* () {
      yield* RAW;
    });

    const picker = new QueryObserver(qc, {
      ...balancesQueryOptions(0),
      select: selectPickerBalances,
    });
    const unsubscribe = picker.subscribe(() => undefined);
    await vi.waitFor(() => expect(picker.getCurrentResult().isSuccess).toBe(true));
    unsubscribe();

    expect(balancesMock).toHaveBeenCalledWith({ accountFilter: { account: 0 } });
    expect(picker.getCurrentResult().data).toEqual([usdc, um]);
    // assets table / positions tab (no select) see the full raw list
    expect(qc.getQueryData(['balances', 0])).toEqual(RAW);
  });

  it('does not cache [] on failure (assets table must see the error)', async () => {
    balancesMock.mockImplementation(() => {
      throw new Error('view service unreachable');
    });
    await qc.prefetchQuery(balancesQueryOptions(0)); // never throws
    const state = qc.getQueryState(['balances', 0]);
    expect(state?.status).toBe('error');
    expect(state?.data).toBeUndefined();
  });
});
