/**
 * Everything zafu may talk to, and when.
 *
 * Default deny. A destination is contacted only when
 *  - it serves a network the user enabled (the endpoint they have configured
 *    for it, never a hardcoded host - change the endpoint and the allowance
 *    moves with it), or
 *  - it is an optional service the user turned on, through its own setting or
 *    by saying yes to {@link requestEgressOptIn}.
 * A per-destination and per-host allow/block from the user wins over both.
 *
 * This file compiles settings into an {@link EgressTable}; `./egress-table`
 * decides a request against it. Both are pure: storage, the channel to other
 * realms and the patched globals live in `./egress`.
 */

import { COSMOS_CHAINS, type CosmosChainId } from '@repo/wallet/networks/cosmos/chains';
import { ZCASHME_BASE_URL } from '../services/zcashme/api';
import { DEFAULT_CONTACT_DISCOVERY_RELAY } from '../config/contact-discovery-relay';
import { PENUMBRA_MAINNET_ENDPOINTS, defaultPenumbraEndpoint } from '../config/penumbra-endpoints';
import { ZCASH_MAINNET_ENDPOINTS, defaultZcashEndpoint } from '../config/zcash-endpoints';
import { BUNDLED_SERVICE_CONFIG } from '../services/voting/bundled-config';
import { pickIndependentPeer } from '../workers/cross-verify';
import { hostOf } from './destination';
import { matchRule, type EgressRule, type EgressTable } from './egress-table';
import type { NetPurpose } from './purpose';

export type { EgressDecision, EgressRealm, EgressReason, EgressTable } from './egress-table';

/** where a chain's user-edited rpc pool is stored; noble + injective keep the keys they shipped with */
export const rpcPoolKey = (chainId: CosmosChainId): string =>
  chainId === 'injective'
    ? 'injectiveRpcPool'
    : chainId === 'noble'
      ? 'nobleRpcEndpoints'
      : `${chainId}RpcEndpoints`;

/** The storage keys the policy reads. A change to any of them recompiles the table. */
export const EGRESS_INPUT_KEYS: readonly string[] = [
  'enabledNetworks',
  'networkEndpoints',
  'grpcEndpoint',
  'customNetworks',
  'netEgress',
  'zidDiscovery',
  'zcashMeConfig',
  'keplrCompat',
  'zitadelRelayUrl',
  'zcashWallets',
  'zcashBackend',
  ...(Object.keys(COSMOS_CHAINS) as CosmosChainId[]).map(rpcPoolKey),
];

/** What those keys hold, read loosely: storage is written by older builds too. */
export interface EgressInputs {
  enabledNetworks?: string[];
  networkEndpoints?: Record<string, string | undefined>;
  grpcEndpoint?: string;
  customNetworks?: unknown[];
  netEgress?: {
    /** `trusted` only on v1 records: zafu auto-allowed them, the user never chose */
    destinations?: Record<string, { state?: string; trusted?: boolean }>;
    optIns?: Record<string, 'allowed' | 'blocked'>;
  };
  zidDiscovery?: { enabled?: boolean; relayEndpoint?: string };
  zcashMeConfig?: { mode?: string; mirrorUrl?: string };
  keplrCompat?: boolean;
  zitadelRelayUrl?: string;
  /** only `multisig.relayUrl` is read: each multisig wallet's own relay */
  zcashWallets?: { multisig?: { relayUrl?: unknown } }[];
  /** absent means the shipped default, zidecar */
  zcashBackend?: string;
}

/**
 * How a destination earns its allowance:
 *  - `network`: required while any of these networks is enabled;
 *  - `optional`: off until the user opts in (its own setting, when it has
 *    one, counts as the opt-in);
 *  - `configured`: the user added it themselves, so it is on until blocked.
 */
export type DestinationKind =
  | { kind: 'network'; networks: readonly string[] }
  | { kind: 'optional'; setting?: (i: EgressInputs) => boolean }
  | { kind: 'configured' };

export interface DestinationSpec {
  id: string;
  /** what the settings list calls it, lowercase */
  label: string;
  purpose: NetPurpose;
  gate: DestinationKind;
  /** the urls (host plus optional path prefix) it owns under these settings */
  urls: (i: EgressInputs) => (string | undefined)[];
  /** shelved service: not listed in settings, never on by default */
  hidden?: boolean;
}

/** the user's own rpc pool for a chain: what its balance checks rotate across */
const rpcPool = (i: EgressInputs, chainId: CosmosChainId): string[] => {
  const pool = (i as Record<string, unknown>)[rpcPoolKey(chainId)];
  return Array.isArray(pool) ? pool.filter((u): u is string => typeof u === 'string') : [];
};

const endpoint = (i: EgressInputs, network: string): string | undefined =>
  i.networkEndpoints?.[network]?.trim() || undefined;

/** The user's zcash light client: the configured endpoint, else the shipped default. */
export const zcashEndpoint = (i: EgressInputs): string =>
  endpoint(i, 'zcash') ?? defaultZcashEndpoint().url;

/** Same resolution as `resolvePenumbraEndpoint`, over the loaded inputs. */
export const penumbraEndpoint = (i: EgressInputs): string =>
  endpoint(i, 'penumbra') ?? (i.grpcEndpoint?.trim() || defaultPenumbraEndpoint().url);

const customNetworkUrls = (i: EgressInputs): string[] =>
  (i.customNetworks ?? []).flatMap(n => {
    const r = n as { rpc?: unknown; rest?: unknown };
    return [r.rpc, r.rest].filter((u): u is string => typeof u === 'string');
  });

/** Networks zafu has no endpoint preset for: the configured endpoint only, plus what their client fetches. */
const OTHER_NETWORKS: Record<string, string[]> = {
  polkadot: ['https://paritytech.github.io/chainspecs/'],
  kusama: ['https://paritytech.github.io/chainspecs/'],
  ethereum: [],
  bitcoin: [],
};

const multisigRelays = (i: EgressInputs): string[] =>
  (i.zcashWallets ?? []).flatMap(w =>
    typeof w?.multisig?.relayUrl === 'string' && w.multisig.relayUrl ? [w.multisig.relayUrl] : [],
  );

/**
 * The table. Order matters only on an exact tie (same host, same path
 * prefix), where the earlier row wins: the configured endpoint before the
 * preset pool it came from.
 */
export const DESTINATIONS: readonly DestinationSpec[] = [
  {
    id: 'zcash',
    label: 'zcash light client',
    purpose: 'chain-rpc',
    gate: { kind: 'network', networks: ['zcash'] },
    urls: i => [zcashEndpoint(i)],
  },
  {
    id: 'zcash-tip-check',
    // opt-in: zafu talks to no node the user did not choose. Turning this on
    // asks one independent operator for the tip as a "right network" check.
    // Same helper the worker calls (workers/cross-verify.ts), so the peer
    // the policy allows is always the one the sync actually asks.
    label: 'zcash tip cross-check',
    purpose: 'indexer',
    gate: { kind: 'optional' },
    // a zidecar extra (ZCASH_BACKENDS): nothing to allow behind a standard lightwalletd
    urls: i =>
      i.zcashBackend === 'lightwalletd' ? [] : [pickIndependentPeer(zcashEndpoint(i))?.url],
  },
  {
    id: 'penumbra',
    label: 'penumbra node',
    purpose: 'chain-rpc',
    gate: { kind: 'network', networks: ['penumbra'] },
    urls: i => [penumbraEndpoint(i)],
  },
  // the penumbra asset registry (json + icons) is bundled at build time
  // (@penumbrafi/registry, see packages/context/src/registry-client.ts and
  // shared/components/registry-icons.ts) - there is no runtime destination
  // for it any more, so raw.githubusercontent.com is simply unknown.
  ...Object.values(COSMOS_CHAINS).map(
    (chain): DestinationSpec => ({
      id: chain.id,
      label: `${chain.name.toLowerCase()} nodes`,
      purpose: 'chain-rpc',
      gate: { kind: 'network', networks: [chain.id] },
      urls: i => [
        endpoint(i, chain.id),
        chain.rpcEndpoint,
        chain.restEndpoint,
        ...(chain.rpcEndpoints ?? []),
        ...rpcPool(i, chain.id),
      ],
    }),
  ),
  ...Object.entries(OTHER_NETWORKS).map(
    ([id, urls]): DestinationSpec => ({
      id,
      label: `${id} node`,
      purpose: 'chain-rpc',
      gate: { kind: 'network', networks: [id] },
      urls: i => [endpoint(i, id), ...urls],
    }),
  ),
  {
    id: 'custom-networks',
    label: 'your own networks',
    purpose: 'chain-rpc',
    gate: { kind: 'configured' },
    urls: customNetworkUrls,
  },
  {
    id: 'zcash-servers',
    // the node sheet's speed test
    label: 'other zcash servers',
    purpose: 'indexer',
    gate: { kind: 'optional' },
    urls: () => ZCASH_MAINNET_ENDPOINTS.map(p => p.url),
  },
  {
    id: 'penumbra-servers',
    label: 'other penumbra nodes',
    purpose: 'indexer',
    gate: { kind: 'optional' },
    urls: () => PENUMBRA_MAINNET_ENDPOINTS.map(p => p.url),
  },
  {
    id: 'zcash-me',
    label: 'zcash.me directory',
    purpose: 'registry',
    gate: { kind: 'optional', setting: i => (i.zcashMeConfig?.mode ?? 'off') !== 'off' },
    urls: i => [ZCASHME_BASE_URL, i.zcashMeConfig?.mirrorUrl?.trim() || undefined],
  },
  {
    id: 'contact-discovery',
    label: 'contact discovery relay',
    purpose: 'relay',
    gate: { kind: 'optional', setting: i => i.zidDiscovery?.enabled === true },
    urls: i => [
      `${(i.zidDiscovery?.relayEndpoint?.trim() || DEFAULT_CONTACT_DISCOVERY_RELAY).replace(/\/$/, '')}/bucket`,
    ],
  },
  {
    id: 'chat-relay',
    label: 'chat relay',
    purpose: 'relay',
    gate: { kind: 'optional' },
    urls: i => ['wss://zrelay.rotko.net/ws', 'wss://zcash.rotko.net/ws', i.zitadelRelayUrl],
  },
  {
    id: 'multisig-relay',
    label: 'multisig relay',
    purpose: 'relay',
    gate: { kind: 'optional' },
    urls: i => [
      'https://relay.zafu.pro',
      'https://zcash.rotko.net/rendezvous/',
      ...multisigRelays(i),
    ],
  },
  {
    id: 'voting',
    // the config (which servers to ask) is bundled with the release, not
    // fetched - these are the vote and pir hosts it names.
    label: 'zcash voting',
    purpose: 'vote',
    gate: { kind: 'optional' },
    urls: () =>
      [...BUNDLED_SERVICE_CONFIG.vote_servers, ...BUNDLED_SERVICE_CONFIG.pir_endpoints].map(
        s => s.url,
      ),
  },
  {
    id: 'sponsor',
    label: 'injective gas sponsor',
    purpose: 'chain-rpc',
    gate: { kind: 'optional' },
    urls: () => ['https://sponsor.zafu.pro'],
  },
  {
    id: 'near-swap',
    label: 'near intents swap',
    purpose: 'swap',
    gate: { kind: 'optional' },
    urls: () => ['https://1click.chaindefuser.com'],
  },
  {
    id: 'thorchain',
    label: 'thorchain swap',
    purpose: 'swap',
    gate: { kind: 'optional' },
    urls: () => [
      'https://thornode.ninerealms.com',
      'https://gateway.liquify.com/chain/thorchain_api',
    ],
  },
  {
    id: 'skip',
    label: 'skip ibc routing',
    purpose: 'swap',
    gate: { kind: 'optional' },
    urls: () => ['https://api.skip.build'],
  },
  {
    id: 'license',
    label: 'license server',
    purpose: 'license',
    gate: { kind: 'optional' },
    urls: () => ['https://license.zafu.pro', 'https://zpro.rotko.net'],
    hidden: true,
  },
];

export const destinationSpec = (id: string): DestinationSpec | undefined =>
  DESTINATIONS.find(d => d.id === id);

/** Why a destination is on or off right now - what the settings row says. */
export type DestinationWhy =
  | 'network'
  | 'network-off'
  | 'setting'
  | 'configured'
  | 'you-allowed'
  | 'you-blocked'
  | 'default-off';

export interface DestinationView {
  id: string;
  label: string;
  purpose: NetPurpose;
  kind: DestinationKind['kind'];
  /** an enabled network needs it (or the user added it): blocking it breaks that network */
  needed: boolean;
  /** the enabled networks it serves, for "zcash cannot sync while this is blocked" */
  networks: string[];
  on: boolean;
  why: DestinationWhy;
  /** the hosts it would contact, `host` or `host/path` */
  hosts: string[];
}

const stateOf = (spec: DestinationSpec, i: EgressInputs): { on: boolean; why: DestinationWhy } => {
  const choice = i.netEgress?.optIns?.[spec.id];
  if (choice === 'blocked') {
    return { on: false, why: 'you-blocked' };
  }
  if (choice === 'allowed' && !spec.hidden) {
    return { on: true, why: 'you-allowed' };
  }
  const gate = spec.gate;
  if (gate.kind === 'configured') {
    return { on: true, why: 'configured' };
  }
  if (gate.kind === 'network') {
    const enabled = gate.networks.some(n => i.enabledNetworks?.includes(n));
    return enabled ? { on: true, why: 'network' } : { on: false, why: 'network-off' };
  }
  return gate.setting?.(i) ? { on: true, why: 'setting' } : { on: false, why: 'default-off' };
};

const targetOf = (url: string): { host: string; path: string } | undefined => {
  const host = hostOf(url);
  if (!host) {
    return undefined;
  }
  const path = new URL(url).pathname;
  return { host, path: path === '/' ? '' : path };
};

const REASON: Partial<Record<DestinationWhy, EgressRule['reason']>> = {
  'you-blocked': 'blocked',
  'network-off': 'network-off',
  'default-off': 'opt-in',
};

/** Every destination with its current state: the "everything zafu talks to" list. */
export const describeEgress = (i: EgressInputs): DestinationView[] => {
  const table = compileEgress(i);
  return DESTINATIONS.filter(d => !d.hidden).map(spec => {
    const { on, why } = stateOf(spec, i);
    // only the hosts this destination owns: the configured zcash endpoint is
    // the light client's, not also one of the "other zcash servers"
    const hosts = spec.urls(i).flatMap(u => {
      const t = u ? targetOf(u) : undefined;
      const owned = t && matchRule(table, `https://${t.host}${t.path}`)?.destination === spec.id;
      return owned ? [`${t.host}${t.path}`] : [];
    });
    const networks =
      spec.gate.kind === 'network'
        ? spec.gate.networks.filter(n => i.enabledNetworks?.includes(n))
        : [];
    return {
      id: spec.id,
      label: spec.label,
      purpose: spec.purpose,
      kind: spec.gate.kind,
      needed: networks.length > 0 || (spec.gate.kind === 'configured' && hosts.length > 0),
      networks,
      on,
      why,
      hosts: [...new Set(hosts)],
    };
  });
};

/** Compile settings into the table every realm decides against. */
export const compileEgress = (i: EgressInputs): EgressTable => {
  const rules: EgressRule[] = [];
  for (const spec of DESTINATIONS) {
    const { on, why } = stateOf(spec, i);
    for (const url of spec.urls(i)) {
      const target = url ? targetOf(url) : undefined;
      if (target) {
        rules.push({
          ...target,
          destination: spec.id,
          allow: on,
          reason: on ? undefined : REASON[why],
        });
      }
    }
  }
  const hosts: EgressTable['hosts'] = {};
  for (const [host, record] of Object.entries(i.netEgress?.destinations ?? {})) {
    if (record?.state === 'blocked' || (record?.state === 'allowed' && !record.trusted)) {
      hosts[host] = record.state;
    }
  }
  return { rules, hosts, adhoc: i.keplrCompat === true };
};
