/**
 * The balance check for one transparent chain (Noble, Injective, ...) under
 * Penumbra, run only when the user asks for it. Nothing here polls.
 *
 * The result and the derived addresses live in session storage (memory only,
 * gone when the browser closes), keyed per wallet and chain: hd.ts keeps
 * nothing but index numbers on disk, and so does this. Reopening the popup
 * shows the last result with its age instead of asking the chain again.
 */

import { storedList } from '@repo/storage-chrome/stored-list';
import { getCosmosChain, type CosmosChainId } from '@repo/wallet/networks/cosmos/chains';
import { conduitFor } from '@repo/wallet/networks/transparent/conduit';
import { peekHdIndex } from '@repo/storage-chrome/cosmos-chain-counters';
import { getRpcPool } from '../hooks/transparent-rpc';
import { shortSymbol } from '../utils/asset-display';
import { knownAssets } from './assets';
import { readFundedIndices, readShownIndices, rememberFundedIndices, scanIndices } from './hd';

export interface DepositAsset {
  denom: string;
  symbol: string;
  amount: bigint;
  /** undefined for a denom we can't identify (shown in base units) */
  decimals?: number;
  formatted: string;
}

/** a burner that held something when it was checked */
export interface DepositWallet {
  index: number;
  address: string;
  assets: DepositAsset[];
}

export interface ChainCheck {
  /** epoch ms the check finished */
  at: number;
  funded: DepositWallet[];
  /** addresses no node answered for; their last known balance is kept */
  missed: number;
}

/** what a chain's home row shows, derived from settings and the cached check */
export type CheckState =
  | { kind: 'off' }
  | { kind: 'unchecked' }
  | { kind: 'checking' }
  | { kind: 'unanswered' | 'funded' | 'empty'; check: ChainCheck };

export const checkState = ({
  enabled,
  checking,
  check,
}: {
  enabled: boolean;
  checking: boolean;
  check: ChainCheck | null | undefined;
}): CheckState => {
  if (!enabled) {
    return { kind: 'off' };
  }
  if (checking) {
    return { kind: 'checking' };
  }
  if (!check) {
    return { kind: 'unchecked' };
  }
  const kind = check.missed > 0 ? 'unanswered' : check.funded.length ? 'funded' : 'empty';
  return { kind, check };
};

/** "just now", "2 min ago", "3 h ago", "4 d ago" */
export const ago = (at: number, now = Date.now()): string => {
  const min = Math.floor((now - at) / 60_000);
  if (min < 1) {
    return 'just now';
  }
  if (min < 60) {
    return `${min} min ago`;
  }
  const h = Math.floor(min / 60);
  return h < 24 ? `${h} h ago` : `${Math.floor(h / 24)} d ago`;
};

const checkKey = (keyId: string, chainId: CosmosChainId) => `transparentCheck:${keyId}:${chainId}`;
const addressesKey = (keyId: string, chainId: CosmosChainId) =>
  `transparentAddresses:${keyId}:${chainId}`;

const session = {
  get: async <T>(key: string): Promise<T | undefined> =>
    (await chrome.storage.session.get(key))[key] as T | undefined,
  set: (key: string, value: unknown) => chrome.storage.session.set({ [key]: value }),
};

/** bigints as strings: storage holds JSON */
const toStored = (c: ChainCheck) =>
  JSON.parse(JSON.stringify(c, (_, v: unknown) => (typeof v === 'bigint' ? `${v}` : v))) as unknown;

const fromStored = (raw: unknown): ChainCheck | null => {
  const c = raw as ChainCheck | undefined;
  if (!c || typeof c.at !== 'number' || !Array.isArray(c.funded)) {
    return null;
  }
  return {
    at: c.at,
    missed: Number(c.missed) || 0,
    funded: c.funded.map(w => ({
      ...w,
      assets: storedList<(typeof w.assets)[number]>(w.assets).map(a => ({
        ...a,
        amount: BigInt(a.amount),
      })),
    })),
  };
};

export const readCheck = async (keyId: string, chainId: CosmosChainId) =>
  fromStored(await session.get(checkKey(keyId, chainId)));

/**
 * Addresses for `indices`, derived only where the session does not hold one
 * yet, so a repeat check never needs the recovery phrase.
 */
export const deriveAddresses = async (
  keyId: string,
  chainId: CosmosChainId,
  indices: readonly number[],
  mnemonic: () => Promise<string>,
): Promise<Map<number, string>> => {
  const known = (await session.get<Record<string, string>>(addressesKey(keyId, chainId))) ?? {};
  const missing = indices.filter(i => !known[i]);
  if (missing.length) {
    const phrase = await mnemonic();
    const conduit = conduitFor(chainId);
    for (const i of missing) {
      known[i] = await conduit.deriveAddress(phrase, i);
    }
    await session.set(addressesKey(keyId, chainId), known);
  }
  return new Map(indices.map(i => [i, known[i]!]));
};

/** format base units with decimals, trimmed to 6 places */
export const formatBalance = (amount: bigint, decimals: number, symbol: string): string => {
  const divisor = 10n ** BigInt(decimals);
  const fraction = (amount % divisor).toString().padStart(decimals, '0').replace(/0+$/, '');
  return fraction
    ? `${amount / divisor}.${fraction.slice(0, 6)} ${symbol}`
    : `${amount / divisor} ${symbol}`;
};

/** Penumbra's UM as it lands on Noble; other IBC hashes fall back to the shared sanitizer */
const KNOWN_IBC_DENOMS: Record<string, string> = {
  'ibc/955A03D0BC92B11738A1E4B0C9F2AAF05B79929703F907D2D7AF5A0D405AE8C1': 'UM',
};

/**
 * Known assets carry their real decimals (INJ is 18, USDC 6); an unknown
 * denom is still listed, in raw base units, so no funds disappear from view.
 * The chain's own asset comes first: raw amounts don't compare across
 * decimals, so INJ dust would otherwise lead over real USDC.
 */
export const toDepositAssets = (
  chainId: CosmosChainId,
  balances: readonly { denom: string; amount: bigint }[],
): DepositAsset[] => {
  const known = knownAssets(chainId);
  const rank = (a: { denom: string }) => Number(a.denom === getCosmosChain(chainId).denom);
  return balances
    .filter(b => b.amount > 0n)
    .map(b => {
      const meta = known.get(b.denom.toLowerCase());
      const symbol = meta?.symbol ?? KNOWN_IBC_DENOMS[b.denom] ?? shortSymbol(b.denom);
      return {
        denom: b.denom,
        symbol,
        amount: b.amount,
        decimals: meta?.decimals,
        formatted: meta
          ? formatBalance(b.amount, meta.decimals, symbol)
          : `${b.amount} ${symbol} (base units)`,
      };
    })
    .sort((a, b) => rank(b) - rank(a) || Number(b.amount - a.amount));
};

/** how many addresses are asked about at once */
const BATCH = 8;

/**
 * Ask the chain about every address worth watching: the regular scan (low
 * indices, the recent ones, every one that ever held funds) and every address
 * ever handed out, since an exchange may keep paying a rotated address.
 *
 * Each address goes through a different endpoint of the pool (by index), so no
 * single provider sees them all together; a failure falls back to the primary
 * rather than hide a funded burner. An address nobody answered for keeps what
 * the previous check saw.
 */
export const runCheck = async (
  keyId: string,
  chainId: CosmosChainId,
  mnemonic: () => Promise<string>,
): Promise<ChainCheck> => {
  const [highest, remembered, shown, pool, prev] = await Promise.all([
    peekHdIndex(chainId),
    readFundedIndices(chainId, keyId),
    readShownIndices(chainId, keyId),
    getRpcPool(chainId),
    readCheck(keyId, chainId),
  ]);
  const indices = [...new Set([...scanIndices(highest, remembered), ...shown])].sort(
    (a, b) => a - b,
  );
  const addresses = await deriveAddresses(keyId, chainId, indices, mnemonic);
  const conduit = conduitFor(chainId);

  const ask = async (index: number): Promise<DepositWallet | 'missed'> => {
    const address = addresses.get(index)!;
    const balances = await conduit
      .queryBalances(address, pool[index % pool.length])
      .catch(() => conduit.queryBalances(address))
      .catch(() => undefined);
    return balances ? { index, address, assets: toDepositAssets(chainId, balances) } : 'missed';
  };

  const funded: DepositWallet[] = [];
  let missed = 0;
  for (let i = 0; i < indices.length; i += BATCH) {
    const batch = indices.slice(i, i + BATCH);
    (await Promise.all(batch.map(ask))).forEach((r, j) => {
      if (r === 'missed') {
        missed++;
        const last = prev?.funded.find(w => w.index === batch[j]);
        if (last) {
          funded.push(last);
        }
      } else if (r.assets.length) {
        funded.push(r);
      }
    });
  }

  if (funded.some(w => !remembered.includes(w.index))) {
    await rememberFundedIndices(
      chainId,
      keyId,
      funded.map(w => w.index),
    );
  }
  const check: ChainCheck = { at: Date.now(), funded, missed };
  await session.set(checkKey(keyId, chainId), toStored(check));
  return check;
};
