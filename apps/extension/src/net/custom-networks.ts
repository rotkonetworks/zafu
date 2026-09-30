/**
 * Networks the user added themselves.
 *
 * The wallet ships a fixed set (COSMOS_CHAINS) and nobody can derive a chain
 * zafu has never heard of, so a custom entry is about *reachability*: a node the
 * user runs or trusts, for a chain zafu already supports, or for one it only
 * knows as an IBC counterparty. Its hosts feed the egress inventory as trusted
 * (the user typed them - prompting for your own node is theatre), and the entry
 * carries the chain id so the rest of the wallet can resolve a route by chain id
 * exactly as it does for a shipped chain.
 *
 * Shape is owned here (not in @repo/storage-chrome, which declares the key as
 * `unknown`) so the parsing rules and the record live in one file, the same way
 * `net/destination.ts` owns the ledger.
 */

import { localExtStorage } from '@repo/storage-chrome/local';
import { hostOf } from './destination';
import { forgetDestination } from './ledger';

export interface CustomNetwork {
  /** stable id, generated on add; what remove() takes */
  id: string;
  /** what the user calls it in settings */
  name: string;
  /** the chain this endpoint serves (cosmos chain id, e.g. `noble-1`) */
  chainId: string;
  /** the RPC endpoint zafu contacts */
  rpc: string;
  /** optional REST/API endpoint, when the user has one */
  rest?: string;
  /** bech32 prefix, for rendering addresses of this chain */
  prefix?: string;
  addedAt: number;
}

const isString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim() !== '';

const parseCustomNetwork = (raw: unknown): CustomNetwork | undefined => {
  if (typeof raw !== 'object' || raw === null) {
    return undefined;
  }
  const record = raw as Record<string, unknown>;
  const { id, name, chainId, rpc, rest, prefix, addedAt } = record;
  if (!isString(id) || !isString(name) || !isString(chainId) || !isString(rpc)) {
    return undefined;
  }
  return {
    id,
    name,
    chainId,
    rpc,
    rest: isString(rest) ? rest : undefined,
    prefix: isString(prefix) ? prefix : undefined,
    addedAt: typeof addedAt === 'number' ? addedAt : 0,
  };
};

/** Defensive read: a hand-edited or older value degrades to the entries that parse. */
export const parseCustomNetworks = (raw: unknown): CustomNetwork[] => {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.flatMap(entry => {
    const parsed = parseCustomNetwork(entry);
    return parsed ? [parsed] : [];
  });
};

export const readCustomNetworks = async (): Promise<CustomNetwork[]> => {
  const stored = await localExtStorage.get('customNetworks');
  return parseCustomNetworks(stored);
};

const writeCustomNetworks = async (networks: CustomNetwork[]): Promise<void> => {
  await localExtStorage.set('customNetworks', networks);
};

export interface NewCustomNetwork {
  name: string;
  chainId: string;
  rpc: string;
  rest?: string;
  prefix?: string;
}

/** Add a network. One endpoint per chain: a second entry for the same chain replaces it. */
export const addCustomNetwork = async (input: NewCustomNetwork): Promise<CustomNetwork> => {
  const entry: CustomNetwork = {
    id: crypto.randomUUID(),
    name: input.name.trim(),
    chainId: input.chainId.trim(),
    rpc: input.rpc.trim(),
    rest: input.rest?.trim() || undefined,
    prefix: input.prefix?.trim() || undefined,
    addedAt: Date.now(),
  };
  const existing = await readCustomNetworks();
  await writeCustomNetworks([...existing.filter(n => n.chainId !== entry.chainId), entry]);
  return entry;
};

/**
 * Every host this entry covers (its rpc, and its rest endpoint when it has one).
 *
 * One place answers "what does this network talk to", so the inventory that
 * trusts the hosts and the removal that forgets them cannot disagree.
 */
export const customNetworkHosts = (network: CustomNetwork): string[] => {
  const hosts: string[] = [];
  for (const url of [network.rpc, network.rest]) {
    if (!url) {
      continue;
    }
    const host = hostOf(url);
    if (host && !hosts.includes(host)) {
      hosts.push(host);
    }
  }
  return hosts;
};

/** Remove a network and forget the hosts it was covering. */
export const removeCustomNetwork = async (id: string): Promise<CustomNetwork | undefined> => {
  const existing = await readCustomNetworks();
  const removed = existing.find(n => n.id === id);
  if (!removed) {
    return undefined;
  }
  await writeCustomNetworks(existing.filter(n => n.id !== id));
  // The ledger entry existed only because the user configured this network;
  // keeping it would leave the host trusted (and listed) with nothing left to
  // justify it.
  for (const host of customNetworkHosts(removed)) {
    await forgetDestination(host);
  }
  return removed;
};
