import { describe, expect, it, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import { AddressView } from '@penumbra-zone/protobuf/penumbra/core/keys/v1/keys_pb';
import { BalancesResponse } from '@penumbra-zone/protobuf/penumbra/view/v1/view_pb';

const balancesMock = vi.fn();
vi.mock('../clients', () => ({
  viewClient: { balances: (...args: unknown[]) => balancesMock(...args) },
}));

const { fundedAccounts, penumbraAccountsQuery } = await import('./penumbra-accounts');

const heldIn = (account: number) =>
  new BalancesResponse({
    accountAddress: new AddressView({
      addressView: { case: 'decoded', value: { index: { account } } },
    }),
  });

describe('penumbra accounts holding funds', () => {
  it('reads the account of every balance, once each', () => {
    const raw = [heldIn(0), heldIn(3), heldIn(4173902), heldIn(3), heldIn(100055)];
    expect(fundedAccounts(raw)).toEqual([0, 3, 4173902, 100055]);
  });

  it('a balance with no decoded address is account 0', () => {
    expect(fundedAccounts([new BalancesResponse()])).toEqual([0]);
  });

  it('asks the view service for every account, with no account filter', async () => {
    balancesMock.mockImplementation(async function* () {
      yield* [heldIn(0), heldIn(4173902)];
    });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await expect(qc.fetchQuery(penumbraAccountsQuery('vault-1'))).resolves.toEqual([0, 4173902]);
    expect(balancesMock).toHaveBeenCalledWith({});
  });

  it('keeps each wallet apart in the cache', () => {
    expect(penumbraAccountsQuery('a').queryKey).not.toEqual(penumbraAccountsQuery('b').queryKey);
  });
});
