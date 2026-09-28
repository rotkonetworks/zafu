/**
 * The trusted-destination inventory: every host that already has a legible
 * reason to be contacted, and where that reason came from.
 *
 * The policy (./policy.ts) refuses or prompts an UNKNOWN host and never asks
 * about a known one. "Known" is exactly this list:
 *
 *  - a device on this computer (loopback) - not a third party at all;
 *  - an endpoint zafu ships for an enabled network (the penumbra / zcash
 *    preset lists, the cosmos chain configs) - the user installed zafu with
 *    these, and prompting for them would be a prompt storm on a fresh install;
 *  - a host the user configured (a node picked in Settings > Networks, the
 *    legacy `grpcEndpoint`, a relay url, a voting config override) - asking
 *    permission for the node they just typed in is theatre;
 *  - zafu's own service hosts (the FROST relay, the license server, the gas
 *    sponsor) - constants in the build, not adoption from a third party.
 *
 * What is NOT here, deliberately: anything a web page advertised (a dapp's
 * `eth_chainId` endpoint, an injected session's RPC), anything hydrated from
 * the remote chain registry, and every host we have never seen. Those are the
 * adoption surfaces the gate exists to catch.
 */

import { localExtStorage } from '@repo/storage-chrome/local';
import { customNetworkHosts, readCustomNetworks } from './custom-networks';
import { COSMOS_CHAINS } from '@repo/wallet/networks/cosmos/chains';
import { DEFAULT_CONTACT_DISCOVERY_RELAY } from '../config/contact-discovery-relay';
import { PENUMBRA_MAINNET_ENDPOINTS } from '../config/penumbra-endpoints';
import { ZCASH_MAINNET_ENDPOINTS } from '../config/zcash-endpoints';
import { hostOf } from './destination';
import type { NetPurpose } from './purpose';

export interface TrustedDestination {
  /** hostname, plus port when non-default - the ledger key */
  host: string;
  /** one line the prompt and the settings list can show */
  label: string;
  /** the purposes this host is trusted FOR; other purposes fall back to the gate */
  purposes: NetPurpose[];
}

/**
 * zafu's own service hosts. These live as constants in the modules named in the
 * comment rather than in one importable config, and the worker must not import a
 * popup route file to read one - so they are restated here, next to the reason
 * each one is trusted.
 */
const ZAFU_SERVICE_HOSTS: readonly { url: string; label: string; purposes: NetPurpose[] }[] = [
  // routes/popup/multisig/dkg-helpers.tsx (DEFAULT_RELAY_URL) - FROST dkg relay
  { url: 'https://relay.zafu.pro', label: "zafu's multisig relay", purposes: ['relay'] },
  // state/license.ts (LICENSE_SERVER)
  { url: 'https://license.zafu.pro', label: "zafu's license server", purposes: ['license'] },
  // packages/wallet/src/networks/cosmos/chains.ts (gasSponsorUrl, injective)
  { url: 'https://sponsor.zafu.pro', label: "zafu's gas sponsor", purposes: ['chain-rpc'] },
];

/** The shipped list, computed once - it is static config, not storage. */
const shippedDestinations = (): TrustedDestination[] => {
  const out: TrustedDestination[] = [];

  for (const preset of PENUMBRA_MAINNET_ENDPOINTS) {
    const host = hostOf(preset.url);
    if (host) {
      out.push({ host, label: 'ships with zafu for Penumbra', purposes: ['chain-rpc'] });
    }
  }

  for (const preset of ZCASH_MAINNET_ENDPOINTS) {
    const host = hostOf(preset.url);
    if (host) {
      out.push({ host, label: 'ships with zafu for Zcash', purposes: ['chain-rpc'] });
    }
  }

  // Cosmos/IBC chains: every endpoint zafu ships for deposit/withdraw and the
  // burner scan rotation.
  for (const chain of Object.values(COSMOS_CHAINS)) {
    const urls = [chain.rpcEndpoint, chain.restEndpoint, ...(chain.rpcEndpoints ?? [])];
    for (const url of urls) {
      const host = hostOf(url);
      if (host) {
        out.push({ host, label: `ships with zafu for ${chain.name}`, purposes: ['chain-rpc'] });
      }
    }
  }

  const relayHost = hostOf(DEFAULT_CONTACT_DISCOVERY_RELAY);
  if (relayHost) {
    out.push({
      host: relayHost,
      label: "zafu's default contact-discovery relay",
      purposes: ['relay'],
    });
  }

  for (const service of ZAFU_SERVICE_HOSTS) {
    const host = hostOf(service.url);
    if (host) {
      out.push({ host, label: service.label, purposes: service.purposes });
    }
  }

  return out;
};

const SHIPPED: readonly TrustedDestination[] = shippedDestinations();

/** Hosts the USER configured; read per call because settings can change them. */
const configuredDestinations = async (): Promise<TrustedDestination[]> => {
  const out: TrustedDestination[] = [];
  const push = (url: unknown, label: string, purposes: NetPurpose[]): void => {
    if (typeof url !== 'string' || !url.trim()) return;
    const host = hostOf(url.trim());
    if (host) out.push({ host, label, purposes });
  };

  const [networkEndpoints, grpcEndpoint, zidDiscovery, votingOverride, customNetworks] =
    await Promise.all([
      localExtStorage.get('networkEndpoints'),
      localExtStorage.get('grpcEndpoint'),
      localExtStorage.get('zidDiscovery'),
      localExtStorage.get('votingConfigOverride'),
      readCustomNetworks(),
    ]);

  for (const [network, url] of Object.entries(networkEndpoints ?? {})) {
    push(url, `you set this endpoint for ${network}`, ['chain-rpc']);
  }
  push(grpcEndpoint, 'you set this endpoint for Penumbra', ['chain-rpc']);
  push(zidDiscovery?.relayEndpoint, 'the relay you configured', ['relay']);
  if (votingOverride?.enabled) {
    push(votingOverride.url, 'the voting config you configured', ['vote']);
  }

  // Networks the user added themselves. Trusted by construction: they typed the
  // host, so prompting for it would only ask them to approve their own choice.
  for (const network of customNetworks) {
    for (const host of customNetworkHosts(network)) {
      if (out.some(entry => entry.host === host)) continue;
      out.push({ host, label: `your network: ${network.name}`, purposes: ['chain-rpc'] });
    }
  }

  return out;
};

/**
 * The full inventory. Exported for the settings screen, which renders it as the
 * "known" list beside the ledger's pending hosts.
 */
export const trustedDestinations = async (): Promise<TrustedDestination[]> => [
  ...SHIPPED,
  ...(await configuredDestinations()),
];

/**
 * Why `host` is trusted, or undefined when it is not. Storage entries win over
 * the shipped list so the user's own label ("you set this endpoint") is the one
 * shown.
 */
export const trustedDestinationFor = async (
  host: string,
): Promise<TrustedDestination | undefined> => {
  const configured = await configuredDestinations();
  return (
    configured.find(entry => entry.host === host) ?? SHIPPED.find(entry => entry.host === host)
  );
};
