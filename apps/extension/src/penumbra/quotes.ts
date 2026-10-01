import { ChainRegistryClient } from '@penumbrafi/registry';
import { getDisplayDenomExponent } from '@penumbra-zone/getters/metadata';
import type { Metadata } from '@penumbra-zone/protobuf/penumbra/core/asset/v1/asset_pb';
import { uint8ArrayToBase64 } from '@rotko/penumbra-types/base64';
import type { Quotes, Unit } from './price';

const client = new ChainRegistryClient();
const registry = client.bundled.get('penumbra-1');

const unitOf = (m: Metadata): Unit => ({
  id: uint8ArrayToBase64(m.penumbraAssetId!.inner),
  exponent: getDisplayDenomExponent.optional(m) ?? 0,
});

export const UM_ID = uint8ArrayToBase64(client.bundled.globals().stakingAssetId.inner);
/** USDC bridged from Injective (transfer/channel-18/erc20:0xa00C...235a), what "usd" is computed in */
export const USDC_INJ_ID = '16ztCNRCyQZYu3cNN7DNMevUt0v2pERpUBflNfwP+wc=';

const all = registry.getAllAssets();
const byId = (id: string) => unitOf(all.find(m => unitOf(m).id === id)!);
const UM = byId(UM_ID);
const USDC = byId(USDC_INJ_ID);

/** the quote each "total in" choice reads, and the hub it routes through */
export const QUOTES: Quotes<'usd' | 'um'> = {
  usd: { quote: USDC, hub: UM },
  um: { quote: UM, hub: USDC },
};

const activeChannels = new Set(
  registry.ibcConnections.filter(c => c.status === 'active').map(c => c.channelId),
);
const channelOf = (base: string) => /^transfer\/(channel-\d+)\//.exec(base)?.[1];

/**
 * The fixed pass's assets: the registry's live fungible set, the rule
 * scripts/gen-registry-icons.mjs bundles icons for (assets on an 'active'
 * ibc connection, native ones, priority-scored majors on expired channels),
 * without the delegation tokens, which are not home rows.
 */
export const UNIVERSE: Unit[] = all
  .filter(m => !m.base.startsWith('udelegation_'))
  .filter(m => {
    const ch = channelOf(m.base);
    return !ch || activeChannels.has(ch) || m.priorityScore > 0n;
  })
  .map(unitOf);
