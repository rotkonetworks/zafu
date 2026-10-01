/**
 * What penumbra assets are worth in usd (USDC.inj) and um, from the chain
 * itself. No price service, no third party.
 *
 * Threat note - what the penumbra node sees on each path:
 * - local: the view service records clearing prices against its numeraires
 *   (UM, USDC.inj) from the batch swap outputs in the compact blocks every
 *   wallet downloads. Reading them sends nothing.
 * - fixed: a SimulateTrade of one display unit of every registry-active
 *   asset into UM and into USDC.inj, in one stable order, the same list and
 *   amounts for every zafu user and run whatever the wallet holds. The node
 *   learns that a zafu wallet with penumbra on opened its home with a stale
 *   cache (it already sees the wallet syncing), and nothing of what it holds;
 *   balances and amounts never leave the device.
 * A held asset's price is its local one first, then the fixed pass, then a
 * cross through the other quote.
 */

/** an asset as the DEX knows it: base64 asset id and display exponent from the registry */
export interface Unit {
  id: string;
  exponent: number;
}

/** what a simulated trade filled, in base units: input consumed and output received */
export interface Fill {
  filled: bigint;
  out: bigint;
}

/** one simulated trade of `amount` base units of `from` into `to` */
export type Simulate = (from: Unit, to: Unit, amount: bigint) => Promise<Fill | undefined>;

/** price per display unit by asset id, or null for no route */
export type Prices = Record<string, number | null>;

/** prices per quote name (usd, um) */
export type Book<Q extends string> = Record<Q, Prices>;

/** each quote's asset, and the asset routed through when there is no direct route */
export type Quotes<Q extends string> = Record<Q, { quote: Unit; hub: Unit }>;

/** display-unit price from a fill, against the filled portion only; nothing filled is no price */
export const rateOf = (from: Unit, to: Unit, fill?: Fill): number | null =>
  fill && fill.filled > 0n && fill.out > 0n
    ? (Number(fill.out) / Number(fill.filled)) * 10 ** (from.exponent - to.exponent)
    : null;

const quoteAssets = <Q extends string>(quotes: Quotes<Q>) =>
  Object.values<{ quote: Unit }>(quotes).map(q => q.quote);

/** the fixed pass's trades: every asset into every quote asset but itself, sorted by id */
export const fixedPairs = <Q extends string>(universe: Unit[], quotes: Quotes<Q>) => {
  const assets = [...new Map([...universe, ...quoteAssets(quotes)].map(u => [u.id, u])).values()];
  return assets
    .sort((a, b) => (a.id < b.id ? -1 : 1))
    .flatMap(a => quoteAssets(quotes).flatMap(q => (q.id === a.id ? [] : [[a, q] as const])));
};

/** trades at once; enough to finish quickly without crowding the node */
const BATCH = 16;

/**
 * The fixed pass: one trade of one display unit per pair, BATCH at a time,
 * then each asset's price in each quote, through the hub when there is no
 * direct route. Takes no holdings, so every wallet sends the same thing.
 */
export const fixedBook =
  <Q extends string>(simulate: Simulate, universe: Unit[], quotes: Quotes<Q>) =>
  async (): Promise<Book<Q>> => {
    const pairs = fixedPairs(universe, quotes);
    const rates = new Map<string, number | null>();
    for (let i = 0; i < pairs.length; i += BATCH) {
      await Promise.all(
        pairs.slice(i, i + BATCH).map(async ([from, to]) => {
          const fill = await simulate(from, to, 10n ** BigInt(from.exponent)).catch(
            () => undefined,
          );
          rates.set(`${from.id}>${to.id}`, rateOf(from, to, fill));
        }),
      );
    }
    const rate = (a: string, b: string) => (a === b ? 1 : (rates.get(`${a}>${b}`) ?? null));
    const book = {} as Book<Q>;
    for (const q of Object.keys(quotes) as Q[]) {
      const { quote, hub } = quotes[q];
      const viaHub = (id: string) => {
        const [toHub, hubOut] = [rate(id, hub.id), rate(hub.id, quote.id)];
        return toHub !== null && hubOut !== null ? toHub * hubOut : null;
      };
      book[q] = Object.fromEntries(
        [...new Set(pairs.map(([a]) => a.id))].map(id => [id, rate(id, quote.id) ?? viaHub(id)]),
      );
    }
    return book;
  };

/** the wallet's own recorded prices, per asset id and quote */
export type Local<Q extends string> = Record<string, Partial<Record<Q, number>>>;

/**
 * Held assets' prices per quote: the local price first, then the fixed
 * pass, then a cross through the hub (the asset's price in the hub's own
 * quote times the hub's price in this one).
 */
export const combine = <Q extends string>(
  quotes: Quotes<Q>,
  local: Local<Q>,
  fixed?: Book<Q>,
): Book<Q> => {
  const names = Object.keys(quotes) as Q[];
  const direct = (id: string, q: Q) =>
    id === quotes[q].quote.id ? 1 : (local[id]?.[q] ?? fixed?.[q][id] ?? null);
  const book = {} as Book<Q>;
  for (const q of names) {
    const hubQ = names.find(n => quotes[n].quote.id === quotes[q].hub.id);
    const hubPrice = direct(quotes[q].hub.id, q);
    book[q] = Object.fromEntries(
      Object.keys(local).map(id => {
        const inHub = hubQ && hubPrice !== null ? direct(id, hubQ) : null;
        return [id, direct(id, q) ?? (inHub != null ? inHub * hubPrice! : null)];
      }),
    );
  }
  return book;
};

/** a fixed pass as it sits in session storage */
export interface PriceEntry<Q extends string = string> {
  at: number;
  book: Book<Q>;
}

/** the fixed pass covers the same assets for everyone, so only its age matters */
export const isFresh = (entry: PriceEntry | undefined, now: number, ttl: number) =>
  !!entry && now - entry.at < ttl;

/** a cache in front of the fixed pass: a fresh stored pass answers, otherwise one new pass is stored */
export const cached =
  <Q extends string>(
    store: {
      get: () => Promise<PriceEntry<Q> | undefined>;
      set: (e: PriceEntry<Q>) => Promise<void>;
    },
    ttl: number,
    now: () => number = Date.now,
  ) =>
  (service: () => Promise<Book<Q>>) =>
  async (): Promise<PriceEntry<Q>> => {
    const hit = await store.get();
    if (hit && isFresh(hit, now(), ttl)) {
      return hit;
    }
    const entry = { at: now(), book: await service() };
    await store.set(entry);
    return entry;
  };
