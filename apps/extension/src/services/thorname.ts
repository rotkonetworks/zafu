/**
 * THORNames: short names THORChain maps to one address per chain. Forward
 * lookups only (name -> address); there is no reverse lookup on purpose. A
 * lookup tells the node operator which name, from your ip, so nothing is
 * asked until the `thorname` destination is on.
 */

import { readEgressView, requestEgressOptIn } from '../net/egress-opt-in';
import { THORNAME_PATH, ThornodeRefusal, thornodeGet } from './thornode';

export const THORNAME_EGRESS = 'thorname';

/** thorchain's rule: 1-30 of [a-z0-9+_-]; no dots, so `name.CHAIN` memo syntax never matches */
const NAME = /^[A-Za-z0-9+_-]{1,30}$/;
/** things that already are addresses: base58 (btc, ltc, doge legacy), bech32, hex */
const ADDRESS = [/^[1-9A-HJ-NP-Za-km-z]{25,}$/, /^[a-z]{1,15}1[02-9ac-hj-np-z]{6,}$/, /^0x/i];

export const isThorName = (input: string): boolean =>
  NAME.test(input) && !ADDRESS.some(re => re.test(input));

/** zafu networks (contact networks, cosmos chain ids) as thorchain alias chains */
const CHAIN_OF: Record<string, string> = {
  zcash: 'ZEC',
  bitcoin: 'BTC',
  ethereum: 'ETH',
  base: 'BASE',
  avalanche: 'AVAX',
  solana: 'SOL',
  cosmoshub: 'GAIA',
};

/** the alias chain for a zafu network; a cosmos chain id counts by its name */
export const thorChainOf = (network: string, chainId?: string): string | undefined =>
  CHAIN_OF[network === 'cosmos' && chainId ? chainId.replace(/-\d+$/, '') : network];

export interface ThorNameRecord {
  name: string;
  aliases?: { chain: string; address: string }[];
}

export const aliasFor = (record: ThorNameRecord, chain: string): string | undefined =>
  record.aliases?.find(a => a.chain.toUpperCase() === chain.toUpperCase())?.address || undefined;

export type ThorNameAnswer =
  /** off and not asked: nothing was sent */
  | { kind: 'ask' }
  | { kind: 'declined' }
  | { kind: 'missing' }
  | { kind: 'no-alias'; name: string; chain: string }
  | { kind: 'found'; name: string; chain: string; address: string }
  | { kind: 'error' };

/** one request per name per session: asking again tells the node nothing new, but twice */
const records = new Map<string, Promise<ThorNameRecord>>();

const record = (name: string): Promise<ThorNameRecord> => {
  const key = name.toLowerCase();
  const hit = records.get(key);
  if (hit) {
    return hit;
  }
  const next = thornodeGet<ThorNameRecord>(`${THORNAME_PATH}/${encodeURIComponent(key)}`);
  records.set(key, next);
  // only thorchain's own answer is kept; a node that did not answer may next time
  next.catch(e => !(e instanceof ThornodeRefusal) && records.delete(key));
  return next;
};

/**
 * Resolve `name` to its `chain` alias. `ask` is a user's press: it may raise
 * the egress sheet. Without it, the lookup runs only if the user already
 * allowed name lookups.
 */
export const lookupThorName = async (
  name: string,
  chain: string,
  ask: boolean,
): Promise<ThorNameAnswer> => {
  const on = ask
    ? await requestEgressOptIn(THORNAME_EGRESS)
    : !!(await readEgressView()).find(d => d.id === THORNAME_EGRESS)?.on;
  if (!on) {
    return { kind: ask ? 'declined' : 'ask' };
  }
  try {
    const r = await record(name);
    const address = aliasFor(r, chain);
    return address
      ? { kind: 'found', name: r.name || name, chain, address }
      : { kind: 'no-alias', name: r.name || name, chain };
  } catch (e) {
    // thornode answers 4xx for a name nobody registered
    return { kind: e instanceof ThornodeRefusal ? 'missing' : 'error' };
  }
};

/** forget cached records (tests) */
export const clearThorNameCache = (): void => records.clear();
