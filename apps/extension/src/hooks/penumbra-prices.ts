import { useQuery } from '@tanstack/react-query';
import { joinLoHiAmount } from '@penumbrafi/types/amount';
import { base64ToUint8Array } from '@penumbrafi/types/base64';
import { sessionExtStorage } from '@repo/storage-chrome/session';
import { simulationClient } from '../clients';
import { cached, fixedBook, type Simulate } from '../penumbra/price';
import { QUOTES, UNIVERSE } from '../penumbra/quotes';

/** a pass is reused for five minutes; after that the next visit to the home runs one */
const TTL = 5 * 60_000;

/** SimulationService.simulateTrade on the user's penumbra node, as a fill */
const simulate: Simulate = async (from, to, amount) => {
  const { output, unfilled } = await simulationClient.simulateTrade({
    input: { amount: { lo: amount, hi: 0n }, assetId: { inner: base64ToUint8Array(from.id) } },
    output: { inner: base64ToUint8Array(to.id) },
  });
  const out = (output?.traces ?? []).reduce((t, tr) => {
    const last = tr.value.at(-1)?.amount;
    return last ? t + joinLoHiAmount(last) : t;
  }, 0n);
  return { out, filled: amount - (unfilled?.amount ? joinLoHiAmount(unfilled.amount) : 0n) };
};

const refreshFixedPrices = cached(
  {
    get: () => sessionExtStorage.get('penumbraPrices'),
    set: entry => sessionExtStorage.set('penumbraPrices', entry),
  },
  TTL,
)(fixedBook(simulate, UNIVERSE, QUOTES));

/**
 * The fixed pass's prices (see penumbra/price.ts): run when the penumbra
 * home is read to the tip and the stored pass is missing or stale, never
 * while it sits open, and never shaped by what the wallet holds.
 */
export const useFixedPrices = (ready: boolean) =>
  useQuery({
    queryKey: ['penumbraFixedPrices'],
    enabled: ready,
    staleTime: TTL,
    refetchOnWindowFocus: false,
    queryFn: refreshFixedPrices,
  });
