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

import { COSMOS_CHAINS } from '@repo/wallet/networks/cosmos/chains';
import { ZCASHME_BASE_URL } from '../services/zcashme/api';
import { DEFAULT_CONTACT_DISCOVERY_RELAY } from '../config/contact-discovery-relay';
import { PENUMBRA_MAINNET_ENDPOINTS, defaultPenumbraEndpoint } from '../config/penumbra-endpoints';
import { ZCASH_MAINNET_ENDPOINTS, defaultZcashEndpoint } from '../config/zcash-endpoints';
import { hostOf } from './destination';
import type { EgressRule, EgressTable } from './egress-table';
import type { NetPurpose } from './purpose';

export type { EgressDecision, EgressRealm, EgressReason, EgressTable } from './egress-table';

/** The storage keys the policy reads. A change to any of them recompiles the table. */
export const EGRESS_INPUT_KEYS = [
  'enabledNetworks',
  'networkEndpoints',
  'grpcEndpoint',
  'customNetworks',
  'netEgress',
  'zidDiscovery',
  'zcashMeConfig',
  'keplrCompat',
  'votingConfigOverride',
  'zitadelRelayUrl',
  'zcashWallets',
] as const;

/** What those keys hold, read loosely: storage is written by older builds too. */
export interface EgressInputs {
  enabledNetworks?: string[];
  networkEndpoints?: Record<string, string | undefined>;
  grpcEndpoint?: string;
  customNetworks?: unknown[];
  netEgress?: {
    destinations?: Record<string, { state?: string }>;
    optIns?: Record<string, 'allowed' | 'blocked'>;
  };
  zidDiscovery?: { enabled?: boolean; relayEndpoint?: string };
  zcashMeConfig?: { mode?: string; mirrorUrl?: string };
  keplrCompat?: boolean;
  votingConfigOverride?: { enabled?: boolean; url?: string };
  zitadelRelayUrl?: string;
  /** only `multisig.relayUrl` is read: each multisig wallet's own relay */
  zcashWallets?: { multisig?: { relayUrl?: unknown } }[];
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
    id: 'penumbra',
    label: 'penumbra node',
    purpose: 'chain-rpc',
    gate: { kind: 'network', networks: ['penumbra'] },
    urls: i => [penumbraEndpoint(i)],
  },
  {
    id: 'penumbra-registry',
    label: 'penumbra asset registry',
    purpose: 'registry',
    gate: { kind: 'network', networks: ['penumbra'] },
    // the registry json, and the asset icons it points at
    urls: () => [
      'https://raw.githubusercontent.com/penumbrafi/registry/',
      'https://raw.githubusercontent.com/prax-wallet/registry/',
      'https://raw.githubusercontent.com/cosmos/chain-registry/',
    ],
  },
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
    // the endpoint picker's speed check, and the sync's tip cross-check
    label: 'other zcash servers',
    purpose: 'indexer',
    gate: { kind: 'optional' },
    urls: () => [...ZCASH_MAINNET_ENDPOINTS.map(p => p.url), 'https://hosh.zec.rocks'],
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
    // the pinned config; the vote and pir servers it names are granted per
    // host once the user opts in (services/voting/api.ts)
    label: 'zcash voting',
    purpose: 'vote',
    gate: { kind: 'optional' },
    urls: i => [
      'https://raw.githubusercontent.com/valargroup/token-holder-voting-config/',
      i.votingConfigOverride?.enabled ? i.votingConfigOverride.url?.trim() : undefined,
    ],
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
  /** `required` rows serve an enabled network; `optional` rows need an opt-in */
  kind: DestinationKind['kind'];
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
export const describeEgress = (i: EgressInputs): DestinationView[] =>
  DESTINATIONS.filter(d => !d.hidden).map(spec => {
    const { on, why } = stateOf(spec, i);
    const hosts = spec.urls(i).flatMap(u => {
      const t = u ? targetOf(u) : undefined;
      return t ? [`${t.host}${t.path}`] : [];
    });
    return {
      id: spec.id,
      label: spec.label,
      purpose: spec.purpose,
      kind: spec.gate.kind,
      on,
      why,
      hosts: [...new Set(hosts)],
    };
  });

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
    if (record?.state === 'allowed' || record?.state === 'blocked') {
      hosts[host] = record.state;
    }
  }
  return { rules, hosts, adhoc: i.keplrCompat === true };
};
