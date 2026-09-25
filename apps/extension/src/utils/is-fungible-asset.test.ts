import { describe, expect, it } from 'vitest';
import { Metadata, ValueView } from '@penumbra-zone/protobuf/penumbra/core/asset/v1/asset_pb';
import { BalancesResponse } from '@penumbra-zone/protobuf/penumbra/view/v1/view_pb';
import {
  filterFungibleBalances,
  isFungibleBalance,
  isFungibleMetadata,
  isNonFungibleDisplay,
} from './is-fungible-asset';

const meta = (base: string, display = base, symbol = ''): Metadata =>
  new Metadata({ base, display, symbol });

const balanceOf = (metadata: Metadata): BalancesResponse =>
  new BalancesResponse({
    balanceView: new ValueView({
      valueView: { case: 'knownAssetId', value: { metadata } },
    }),
  });

describe('isNonFungibleDisplay', () => {
  it.each([
    ['lpnft_opened_plpid1abc'],
    ['lpnft_closed_plpid1abc'],
    ['lpnft_withdrawn_plpid1abc'],
    ['lpnft_claimed_plpid1abc'],
    ['auctionnft_0_pauctid1abc'],
    ['delegation_penumbravalid1abc'],
    ['unbonding_start_at_123_penumbravalid1abc'],
    ['voted_on_42'],
    ['proposal_42'],
  ])('flags %s as non-fungible', display => {
    expect(isNonFungibleDisplay(display)).toBe(true);
  });

  it.each([
    ['penumbra'],
    ['upenumbra'],
    ['usdc'],
    ['transfer/channel-2/uusdc'],
    ['ibc/955A03D0BC92B11738A1E4B0C9F2AAF05B79929703F907D2D7AF5A0D405AE8C1'],
    ['inj'],
    ['gm'],
  ])('leaves %s alone', display => {
    expect(isNonFungibleDisplay(display)).toBe(false);
  });

  it('treats empty / missing input as fungible (never silently drops)', () => {
    expect(isNonFungibleDisplay(undefined)).toBe(false);
    expect(isNonFungibleDisplay('')).toBe(false);
  });
});

describe('isFungibleMetadata', () => {
  it('inspects the display denom, not the base', () => {
    // delegation base carries the u prefix; display does not.
    const delegation = meta('udelegation_penumbravalid1abc', 'delegation_penumbravalid1abc');
    expect(isFungibleMetadata(delegation)).toBe(false);
  });

  it('unknown metadata is fungible by default', () => {
    expect(isFungibleMetadata(undefined)).toBe(true);
    expect(isFungibleMetadata(meta(''))).toBe(true);
  });

  it('a regular token stays fungible', () => {
    expect(isFungibleMetadata(meta('upenumbra', 'penumbra', 'UM'))).toBe(true);
  });
});

describe('filterFungibleBalances', () => {
  it('drops every synthetic per-position token and preserves order of the rest', () => {
    const um = balanceOf(meta('upenumbra', 'penumbra', 'UM'));
    const usdc = balanceOf(meta('transfer/channel-2/uusdc', 'transfer/channel-2/uusdc', 'USDC'));
    const lp = balanceOf(meta('lpnft_opened_plpid1x', 'lpnft_opened_plpid1x'));
    const del = balanceOf(meta('udelegation_penumbravalid1x', 'delegation_penumbravalid1x'));
    const unb = balanceOf(
      meta('uunbonding_start_at_10_penumbravalid1x', 'unbonding_start_at_10_penumbravalid1x'),
    );
    const vote = balanceOf(meta('voted_on_1', 'voted_on_1'));
    const prop = balanceOf(meta('proposal_1', 'proposal_1'));
    const auc = balanceOf(meta('auctionnft_0_pauctid1x', 'auctionnft_0_pauctid1x'));

    const kept = filterFungibleBalances([um, lp, usdc, del, unb, vote, prop, auc]);
    expect(kept).toEqual([um, usdc]);
  });

  it('per-item isFungibleBalance agrees with the bulk filter', () => {
    const lp = balanceOf(meta('lpnft_opened_plpid1x'));
    const um = balanceOf(meta('upenumbra', 'penumbra', 'UM'));
    expect(isFungibleBalance(lp)).toBe(false);
    expect(isFungibleBalance(um)).toBe(true);
  });
});
