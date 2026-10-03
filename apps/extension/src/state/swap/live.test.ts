import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  focusManager,
  QueriesObserver,
  QueryClient,
  QueryObserver,
  type QueryObserverResult,
} from '@tanstack/react-query';

const egress = vi.hoisted(() => ({ asked: [] as string[], views: [] as unknown[] }));
vi.mock('../../net/egress-opt-in', () => ({
  readEgressView: () => Promise.resolve(egress.views),
  requestEgressOptIn: (id: string) => {
    egress.asked.push(id);
    return Promise.resolve(true);
  },
}));

import { PROVIDERS } from '.';
import { toUnits, type Quote, type QuoteRequest } from './provider';
import {
  chips,
  clean,
  defaultAmount,
  gates,
  lastOfPair,
  plain,
  quoteQuery,
  readLast,
  REFRESH_MS,
  refreshIn,
  saveLast,
} from './live';
import { nodeRefusal } from './thornode';
import { keepSwapPreload, preloadSwapQuote } from './preload';

const BTC = { symbol: 'BTC', chain: 'btc', decimals: 8 };
const req = (amountIn: string): QuoteRequest => ({
  direction: 'into_zec',
  token: BTC,
  amountIn,
  zcashAddress: 'u1shielded',
  zcashTransparent: 't1transparent',
  otherAddress: 'bc1qrefund',
});
const quoteOf = (amountIn: string, expiresAt?: number): Quote => ({
  route: 'near',
  amountOut: toUnits(amountIn, 8) * 60n,
  amountOutText: amountIn,
  amountInText: amountIn,
  depositAddress: '',
  recipient: 'u1shielded',
  expiresAt,
  raw: undefined,
});
const view = (id: string, on: boolean, why = on ? 'you-allowed' : 'default-off') => ({
  id,
  on,
  why,
});

/** a near quote per call that answers only when told to, and records its signal */
const deferredNear = () => {
  const calls: { amountIn: string; signal?: AbortSignal; answer: () => void }[] = [];
  vi.spyOn(PROVIDERS.near!, 'quote').mockImplementation(
    (r, signal) =>
      new Promise(resolve =>
        calls.push({ amountIn: r.amountIn, signal, answer: () => resolve(quoteOf(r.amountIn)) }),
      ),
  );
  return calls;
};

const flush = () => new Promise<void>(r => setTimeout(r, 0));

beforeEach(() => {
  egress.asked.length = 0;
  egress.views = [view('near-swap', true), view('thorchain', false)];
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  focusManager.setFocused(undefined);
});

describe('live quotes', () => {
  /** the screen's shape: one observer per route, as useQueries keeps them */
  const screen = (client: QueryClient, amountIn: string, token = BTC) => {
    const q = quoteQuery('near', 'w', { ...req(amountIn), token });
    return [{ ...q, placeholderData: () => lastOfPair(client, q.queryKey) }];
  };

  it('cancels a stale price, and an older answer never wins over a newer one', async () => {
    const calls = deferredNear();
    const client = new QueryClient();
    const observer = new QueriesObserver<QueryObserverResult<Quote>[]>(
      client,
      screen(client, '0.1'),
    );
    const unsubscribe = observer.subscribe(() => undefined);
    await flush();
    // the amount moved on before 0.1 answered
    observer.setQueries(screen(client, '0.2'));
    await flush();
    expect(calls.map(c => c.amountIn)).toEqual(['0.1', '0.2']);
    expect(calls[0]!.signal?.aborted).toBe(true);
    calls[1]!.answer();
    await flush();
    calls[0]!.answer();
    await flush();
    expect(observer.getCurrentResult()[0]!.data?.amountInText).toBe('0.2');
    unsubscribe();
  });

  it('keeps the last price of the same pair, marked, while the next amount is asked', async () => {
    const calls = deferredNear();
    const client = new QueryClient();
    const observer = new QueriesObserver<QueryObserverResult<Quote>[]>(
      client,
      screen(client, '0.1'),
    );
    const unsubscribe = observer.subscribe(() => undefined);
    await flush();
    calls[0]!.answer();
    await flush();
    observer.setQueries(screen(client, '0.2'));
    const [held] = observer.getCurrentResult();
    expect([held!.data?.amountInText, held!.isPlaceholderData]).toEqual(['0.1', true]);
    // another token is another pair: nothing of the old one shows
    observer.setQueries(screen(client, '0.2', { ...BTC, symbol: 'LTC', chain: 'ltc' }));
    expect(observer.getCurrentResult()[0]!.data).toBeUndefined();
    unsubscribe();
  });

  it('asks again while seen, never while hidden, and at once when seen again', async () => {
    vi.useFakeTimers();
    const ask = vi
      .spyOn(PROVIDERS.near!, 'quote')
      .mockImplementation(r => Promise.resolve(quoteOf(r.amountIn)));
    const client = new QueryClient();
    // as QueryClientProvider does: it hears the screen being seen again
    client.mount();
    const observer = new QueryObserver(client, quoteQuery('near', 'w', req('0.1')));
    const unsubscribe = observer.subscribe(() => undefined);
    await vi.advanceTimersByTimeAsync(0);
    expect(ask).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(REFRESH_MS + 100);
    expect(ask).toHaveBeenCalledTimes(2);
    focusManager.setFocused(false);
    await vi.advanceTimersByTimeAsync(REFRESH_MS * 4);
    expect(ask).toHaveBeenCalledTimes(2);
    focusManager.setFocused(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(ask).toHaveBeenCalledTimes(3);
    unsubscribe();
  });

  it('asks before a price expires, and never for no price', () => {
    expect(refreshIn(quoteOf('1'), 0, 0)).toBe(REFRESH_MS);
    expect(refreshIn(quoteOf('1', 20_000), 0, 0)).toBe(5_000);
    expect(refreshIn(quoteOf('1', 1_000), 0, 0)).toBe(1_000);
    expect(refreshIn(undefined, 0, 0)).toBe(false);
  });
});

describe('the amount the form opens with', () => {
  const max = toUnits('1.2384', 8);

  it('is 10% of the zec that can be sent, rounded down to a clean figure', () => {
    expect(defaultAmount('from_zec', max)).toBe('0.12');
    expect(defaultAmount('from_zec', 0n)).toBe('');
    expect(clean(12_384_000n)).toBe(12_000_000n);
    expect(clean(7n)).toBe(7n);
  });

  it('offers clean shares that never pass max, and max exactly', () => {
    expect(chips(max)).toEqual([
      { label: '10%', amount: '0.12' },
      { label: '25%', amount: '0.3' },
      { label: '50%', amount: '0.61' },
      { label: 'max', amount: '1.2384' },
    ]);
    for (const c of chips(toUnits('0.00099999', 8))) {
      expect(toUnits(c.amount, 8) <= toUnits('0.00099999', 8)).toBe(true);
    }
    expect(chips(0n)).toEqual([]);
  });

  it('into zec: about $100 of a priced token, else nothing', () => {
    expect(defaultAmount('into_zec', 0n, { ...BTC, usd: 110_000 })).toBe('0.0009');
    expect(
      defaultAmount('into_zec', 0n, { symbol: 'USDC', chain: 'eth', decimals: 6, usd: 1 }),
    ).toBe('100');
    expect(defaultAmount('into_zec', max, BTC)).toBe('');
  });
});

describe('the pair the screen reopens on', () => {
  it('is kept per wallet', async () => {
    await saveLast('w1', { direction: 'from_zec', token: BTC });
    await saveLast('w2', { direction: 'into_zec' });
    expect(await readLast()).toMatchObject({
      w1: { direction: 'from_zec', token: BTC },
      w2: { direction: 'into_zec' },
    });
  });
});

describe('routes that cannot quote', () => {
  const pair = { direction: 'into_zec', symbol: 'btc', chain: 'btc' } as const;

  it('say why in one plain line, never the node raw text', () => {
    const pool = nodeRefusal(
      'thorchain',
      new Error(
        'amount less than min swap amount (recommended_min_amount_in: 6129): invalid request',
      ),
      1_000_000n,
      'btc',
    );
    expect(plain('thor', pool)).toBe("can't fill this right now · its pool is too small");
    expect(
      plain('thor', nodeRefusal('thorchain', new Error('pool ZEC.ZEC not found'), 1n, 'btc')),
    ).toBe('could not quote this right now');
  });

  it('a pair a route does not trade, a route not asked yet, a blocked one: each a quiet line', () => {
    expect(gates(pair, egress.views as never)).toEqual([
      { route: 'near' },
      { route: 'thor', line: 'ask for a price', ask: true },
    ]);
    expect(
      gates(pair, [view('near-swap', true), view('thorchain', false, 'you-blocked')] as never),
    ).toEqual([{ route: 'near' }, { route: 'thor', line: 'you blocked it in settings' }]);
    expect(
      gates({ direction: 'from_zec', symbol: 'sol', chain: 'sol' }, egress.views as never)[1],
    ).toMatchObject({ route: 'thor', line: "doesn't trade sol on sol · near intents may" });
  });
});

describe('the swap quote preload', () => {
  it('asks only the routes already allowed, and never asks for permission', async () => {
    const ask = vi
      .spyOn(PROVIDERS.near!, 'quote')
      .mockImplementation(r => Promise.resolve(quoteOf(r.amountIn)));
    const thor = vi.spyOn(PROVIDERS.thor!, 'quote');
    const client = new QueryClient();
    await preloadSwapQuote({ client, wallet: 'w1' });
    expect(ask).not.toHaveBeenCalled();
    await keepSwapPreload('w1', req('0.3'));
    await preloadSwapQuote({ client, wallet: 'w1' });
    await flush();
    expect(ask).toHaveBeenCalledTimes(1);
    expect(ask.mock.lastCall?.[0]).toMatchObject({ amountIn: '0.3', dry: true });
    expect(thor).not.toHaveBeenCalled();
    expect(egress.asked).toEqual([]);
    // the screen opening on the same request finds the price there, without asking again
    expect(client.getQueryData(quoteQuery('near', 'w1', req('0.3')).queryKey)).toMatchObject({
      amountInText: '0.3',
    });
  });
});

describe('prices kept for a reopened popup', () => {
  it('come back at once, bigints and all, dimmed as old as they are; never an expired one', async () => {
    const { keepSwapQuotes, seedSwapQuotes } = await import('./preload');
    vi.spyOn(PROVIDERS.near!, 'quote').mockImplementation(r =>
      Promise.resolve({
        ...quoteOf(r.amountIn, Date.now() + 3_600_000),
        amountIn: undefined,
      } as Quote),
    );
    const first = new QueryClient();
    const stop = keepSwapQuotes(first, 'w9');
    const q = quoteQuery('near', 'w9', req('0.4'));
    await first.fetchQuery(q);
    await flush();
    stop();

    // a new popup: an empty cache, filled from session memory before anything is asked
    const next = new QueryClient();
    await seedSwapQuotes(next, 'w9');
    const back = next.getQueryData(q.queryKey);
    expect(back?.amountOut).toBe(toUnits('0.4', 8) * 60n);
    expect(next.getQueryState(q.queryKey)?.dataUpdatedAt).toBe(
      first.getQueryState(q.queryKey)?.dataUpdatedAt,
    );
    // past its window it is left out
    const late = new QueryClient();
    await seedSwapQuotes(late, 'w9', Date.now() + 3_600_000);
    expect(late.getQueryData(q.queryKey)).toBeUndefined();
  });
});
