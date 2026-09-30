/**
 * One-time upgrade of the v1 destination ledger to the default-deny policy.
 *
 * v1 allowed every host zafu ships, for every user, and wrote each one it
 * contacted into the ledger as `allowed`. v2 allows only what an enabled
 * network or an opted-in service needs. The rule for existing users: keep what
 * they actively turned on, turn off what was merely on by default.
 *
 *  - A `blocked` host stays blocked: that was always a user decision.
 *  - An `allowed` host that was only `trusted` (auto-allowed because zafu
 *    shipped it) loses its allowance; the policy now decides it from the
 *    user's networks and services. An `allowed` host that was never trusted
 *    was a yes to the consent prompt, and stays allowed.
 *  - Services with their own switch (zcash.me, contact discovery) need
 *    nothing: the switch is the opt-in, and both defaulted to off.
 *  - Services that had no switch and were simply reachable are opted in only
 *    where storage shows the user actually uses them: multisig wallets keep
 *    their relay, chat users keep the chat relay, and a cosmos chain the
 *    worker had already talked to (a pending IBC transfer, a dapp send) stays
 *    reachable. Everything else - swaps, voting, the gas sponsor, speed checks,
 *    other nodes - is off until asked.
 */

import { COSMOS_CHAINS } from '@repo/wallet/networks/cosmos/chains';
import { hostOf } from './destination';

type Raw = Record<string, unknown>;

const obj = (v: unknown): Raw => (typeof v === 'object' && v !== null ? (v as Raw) : {});

/** The v2 ledger for a v1 one, given everything in local storage. Pure. */
export const migrateNetEgress = (storage: Raw): Raw | undefined => {
  const ledger = obj(storage['netEgress']);
  if (ledger['v'] === 2) {
    return undefined;
  }

  const destinations: Raw = {};
  for (const [host, value] of Object.entries(obj(ledger['destinations']))) {
    const record = obj(value);
    const autoAllowed = record['state'] === 'allowed' && record['trusted'] === true;
    destinations[host] = { ...record, state: autoAllowed ? 'pending' : record['state'] };
  }

  const optIns: Record<string, 'allowed'> = {};
  const wallets = Array.isArray(storage['zcashWallets']) ? storage['zcashWallets'] : [];
  if (wallets.some(w => obj(w)['multisig'] !== undefined)) {
    optIns['multisig-relay'] = 'allowed';
  }
  if (Object.keys(storage).some(k => k === 'zitadelRelayUrl' || k.startsWith('zidNick:'))) {
    optIns['chat-relay'] = 'allowed';
  }
  const used = new Set(
    Object.entries(obj(ledger['destinations']))
      .filter(([, r]) => obj(r)['state'] !== 'blocked' && Number(obj(r)['calls'] ?? 0) > 0)
      .map(([host]) => host),
  );
  for (const chain of Object.values(COSMOS_CHAINS)) {
    const hosts = [chain.rpcEndpoint, chain.restEndpoint, ...(chain.rpcEndpoints ?? [])].map(
      hostOf,
    );
    if (hosts.some(h => h && used.has(h))) {
      optIns[chain.id] = 'allowed';
    }
  }

  return { v: 2, destinations, optIns: { ...optIns, ...obj(ledger['optIns']) } };
};

/**
 * Run once, from the service worker. Idempotent: a v2 ledger is left alone. A
 * missing ledger is migrated too - a zcash-only install never wrote one (its
 * sync ran outside the old worker-only gate) but may still have multisig
 * wallets or chat history to keep working; on a fresh install it simply
 * writes the empty v2 ledger.
 */
export const runNetEgressMigration = async (): Promise<void> => {
  const ledger = obj((await chrome.storage.local.get('netEgress'))['netEgress']);
  if (ledger['v'] === 2) {
    return;
  }
  const next = migrateNetEgress(await chrome.storage.local.get(null));
  if (next) {
    await chrome.storage.local.set({ netEgress: next });
  }
};
