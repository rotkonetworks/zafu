/**
 * Public sponsor stats. Everything shown is read from chain (balance, recent
 * sends) and cached for a minute, so the page cannot be used to hammer RPCs.
 * Only the daily counter comes from the service's own limits.
 */

const CACHE_MS = 60_000;
const MAX_RECORDS = 20;
/** about a day of Base blocks (2s) */
const BASE_WINDOW = 43_200n;

export interface SponsorRecord {
  time: string;
  txHash: string;
  to: string;
  amount: string;
  url: string;
}

export interface NetworkStats {
  symbol: string;
  /** also the donation address */
  sponsor: string;
  addressUrl: string;
  /** decimal string; null when the chain could not be read */
  balance: string | null;
  /** people the sponsor can still cover at the current cost; null when balance unknown */
  capacity: number | null;
  today: number;
  dailyCap: number;
  records: SponsorRecord[];
}

export interface Stats {
  updatedAt: string;
  injective: NetworkStats;
  base: NetworkStats | null;
}

interface RawRecord {
  time: string;
  txHash: string;
  to: string;
  amount: bigint;
}

export interface Source {
  symbol: string;
  sponsor: string;
  addressUrl: string;
  txUrl: (hash: string) => string;
  /** what one more person costs, in base units */
  unit: bigint;
  /** the sponsor stops below this */
  reserve: bigint;
  dailyCap: number;
  today: () => number;
  balance: () => Promise<bigint>;
  records: () => Promise<RawRecord[]>;
}

/** base units (18 decimals) as a trimmed decimal, six places at most */
export const units = (v: bigint): string => {
  const scale = 10n ** 12n;
  const micro = v / scale;
  const whole = micro / 1_000_000n;
  const frac = (micro % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : `${whole}`;
};

export const capacity = (balance: bigint, reserve: bigint, unit: bigint): number =>
  balance > reserve && unit > 0n ? Number((balance - reserve) / unit) : 0;

const orNull = async <T>(p: Promise<T>): Promise<T | null> => p.catch(() => null);

const chainRead = async (s: Source) => {
  const [balance, records] = await Promise.all([orNull(s.balance()), orNull(s.records())]);
  return { balance, records: records ?? [] };
};

const shape = (s: Source, read: Awaited<ReturnType<typeof chainRead>>): NetworkStats => ({
  symbol: s.symbol,
  sponsor: s.sponsor,
  addressUrl: s.addressUrl,
  balance: read.balance === null ? null : units(read.balance),
  capacity: read.balance === null ? null : capacity(read.balance, s.reserve, s.unit),
  today: s.today(),
  dailyCap: s.dailyCap,
  records: read.records.slice(0, MAX_RECORDS).map(r => ({
    time: r.time,
    txHash: r.txHash,
    to: r.to,
    amount: units(r.amount),
    url: s.txUrl(r.txHash),
  })),
});

/**
 * Reads are slow (the Base bisect takes seconds), so after the first one a
 * stale value is served while a single refresh runs in the background.
 */
const cached = <T>(fn: () => Promise<T>, now: () => number): (() => Promise<T>) => {
  let hit: { at: number; value: Promise<T> } | undefined;
  let refreshing = false;
  return () => {
    if (!hit) {
      hit = { at: now(), value: fn() };
    } else if (now() - hit.at >= CACHE_MS && !refreshing) {
      refreshing = true;
      void fn().then(value => {
        hit = { at: now(), value: Promise.resolve(value) };
        refreshing = false;
      });
    }
    return hit.value;
  };
};

/** `base` is absent when the Base drip is not configured */
export const makeStats = (
  sources: { injective: Source; base?: Source },
  now: () => number = Date.now,
): (() => Promise<Stats>) => {
  const reader = (s: Source) => {
    const read = cached(() => chainRead(s), now);
    return async () => shape(s, await read());
  };
  const injective = reader(sources.injective);
  const base = sources.base && reader(sources.base);
  return async () => ({
    updatedAt: new Date(now()).toISOString(),
    injective: await injective(),
    base: base ? await base() : null,
  });
};

interface LcdMsg {
  '@type'?: string;
  grantee?: string;
  allowance?: { spend_limit?: LcdCoin[]; allowance?: { spend_limit?: LcdCoin[] } };
}
interface LcdCoin {
  denom?: string;
  amount?: string;
}
interface LcdTx {
  txhash: string;
  code?: number;
  timestamp: string;
  tx?: { body?: { messages?: LcdMsg[] } };
}

const GRANT_TYPE = '/cosmos.feegrant.v1beta1.MsgGrantAllowance';

/** The granter's latest grants: LCD tx search, newest first. Failed txs are skipped. */
export const injectiveGrants = async (
  lcdUrl: string,
  granter: string,
  fetchFn: typeof fetch,
): Promise<RawRecord[]> => {
  const q = encodeURIComponent(`message.sender='${granter}'`);
  const res = await fetchFn(
    `${lcdUrl.replace(/\/$/, '')}/cosmos/tx/v1beta1/txs?query=${q}&order_by=ORDER_BY_DESC&limit=${MAX_RECORDS}`,
  );
  if (!res.ok) {
    throw new Error(`injective tx search failed: ${res.status}`);
  }
  const { tx_responses = [] } = (await res.json()) as { tx_responses?: LcdTx[] };
  return tx_responses
    .filter(t => !t.code)
    .flatMap(t =>
      (t.tx?.body?.messages ?? [])
        .filter(m => m['@type'] === GRANT_TYPE && m.grantee)
        .map(m => {
          const limit = (m.allowance?.allowance ?? m.allowance)?.spend_limit?.[0]?.amount;
          return {
            time: t.timestamp,
            txHash: t.txhash,
            to: m.grantee ?? '',
            amount: BigInt(limit ?? 0),
          };
        }),
    );
};

export interface BaseChain {
  head: () => Promise<bigint>;
  nonceAt: (address: string, block: bigint) => Promise<number>;
  block: (n: bigint) => Promise<{
    timestamp: bigint;
    transactions: { hash: string; from: string; to: string | null; value: bigint }[];
  }>;
}

/**
 * Plain RPC cannot list an address's transactions, and fetching whole blocks
 * is ~170 KB each. A sender's nonce only moves when it sends, so bisect the
 * last day on the nonce and fetch just the blocks where it changed: about
 * 15 cheap calls per send instead of 43,000 blocks.
 */
export const baseSends = async (chain: BaseChain, sponsor: string): Promise<RawRecord[]> => {
  const me = sponsor.toLowerCase();
  const head = await chain.head();
  const out: RawRecord[] = [];
  const bisect = async (lo: bigint, hi: bigint, loNonce: number, hiNonce: number) => {
    if (loNonce === hiNonce || out.length >= MAX_RECORDS) {
      return;
    }
    if (hi - lo === 1n) {
      const b = await chain.block(hi);
      const mine = b.transactions.filter(t => t.from.toLowerCase() === me).reverse();
      for (const t of mine) {
        out.push({
          time: new Date(Number(b.timestamp) * 1000).toISOString(),
          txHash: t.hash,
          to: t.to ?? '',
          amount: t.value,
        });
      }
      return;
    }
    const mid = (lo + hi) / 2n;
    const midNonce = await chain.nonceAt(sponsor, mid);
    await bisect(mid, hi, midNonce, hiNonce);
    await bisect(lo, mid, loNonce, midNonce);
  };
  const lo = head > BASE_WINDOW ? head - BASE_WINDOW : 0n;
  const [loNonce, hiNonce] = await Promise.all([
    chain.nonceAt(sponsor, lo),
    chain.nonceAt(sponsor, head),
  ]);
  await bisect(lo, head, loNonce, hiNonce);
  return out;
};

export interface DripLog {
  from: string;
  txHash: string;
  block: bigint;
  to: string;
  amount: bigint;
}

export interface BaseLogs {
  head: () => Promise<bigint>;
  /** Dripped events from this sponsor in [from, to], oldest first */
  logs: (from: bigint, to: bigint) => Promise<DripLog[]>;
  timestamp: (block: bigint) => Promise<bigint>;
}

/** public RPCs cap eth_getLogs ranges; 10k blocks is accepted by the ones we checked */
export const LOG_CHUNK = 10_000n;

/**
 * The sponsor's drips from the Drip contract's events, newest first. The
 * contract is callable by anyone, so `logs` asks for topic1 == sponsor and
 * anything else is dropped here again.
 */
export const baseDrips = async (chain: BaseLogs, sponsor: string): Promise<RawRecord[]> => {
  const head = await chain.head();
  const floor = head > BASE_WINDOW ? head - BASE_WINDOW : 0n;
  const found: DripLog[] = [];
  for (let to = head; to >= floor && found.length < MAX_RECORDS; to -= LOG_CHUNK) {
    const from = to - LOG_CHUNK + 1n > floor ? to - LOG_CHUNK + 1n : floor;
    const mine = (await chain.logs(from, to)).filter(
      l => l.from.toLowerCase() === sponsor.toLowerCase(),
    );
    found.push(...mine.reverse());
  }
  const recent = found.slice(0, MAX_RECORDS);
  const blocks = [...new Set(recent.map(l => l.block))];
  const times = new Map(
    await Promise.all(blocks.map(async b => [b, await chain.timestamp(b)] as const)),
  );
  return recent.map(l => ({
    time: new Date(Number(times.get(l.block)) * 1000).toISOString(),
    txHash: l.txHash,
    to: l.to,
    amount: l.amount,
  }));
};
