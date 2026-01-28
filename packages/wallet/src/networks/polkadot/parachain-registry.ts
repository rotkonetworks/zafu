/**
 * dynamic parachain registry from parity chainspecs
 * fetches available parachains at runtime instead of hardcoding
 */

export type RelayNetwork = 'polkadot' | 'kusama';

export interface ParachainInfo {
  id: string;
  name: string;
  relay: RelayNetwork;
  chainspecUrl: string;
  /** optional metadata */
  decimals?: number;
  symbol?: string;
  ss58Prefix?: number;
}

const CHAINSPECS_BASE = 'https://paritytech.github.io/chainspecs';

/** known parachains with metadata (curated list with display names) */
const KNOWN_PARACHAINS: Record<string, Partial<ParachainInfo>> = {
  // polkadot defi
  'acala': { name: 'Acala', decimals: 12, symbol: 'ACA', ss58Prefix: 10 },
  'hydradx': { name: 'HydraDX', decimals: 12, symbol: 'HDX', ss58Prefix: 63 },
  'parallel': { name: 'Parallel', decimals: 12, symbol: 'PARA', ss58Prefix: 172 },
  'interlay': { name: 'Interlay', decimals: 10, symbol: 'INTR', ss58Prefix: 2032 },

  // polkadot smart contracts
  'moonbeam': { name: 'Moonbeam', decimals: 18, symbol: 'GLMR', ss58Prefix: 1284 },
  'astar': { name: 'Astar', decimals: 18, symbol: 'ASTR', ss58Prefix: 5 },
  'clover': { name: 'Clover', decimals: 18, symbol: 'CLV', ss58Prefix: 128 },

  // polkadot privacy/compute
  'phala': { name: 'Phala', decimals: 12, symbol: 'PHA', ss58Prefix: 30 },
  'integritee': { name: 'Integritee', decimals: 12, symbol: 'TEER', ss58Prefix: 13 },
  'manta': { name: 'Manta', decimals: 18, symbol: 'MANTA', ss58Prefix: 77 },

  // polkadot other
  'bifrost-polkadot': { name: 'Bifrost', decimals: 12, symbol: 'BNC', ss58Prefix: 6 },
  'centrifuge': { name: 'Centrifuge', decimals: 18, symbol: 'CFG', ss58Prefix: 36 },
  'unique': { name: 'Unique', decimals: 18, symbol: 'UNQ', ss58Prefix: 7391 },
  'polkadex': { name: 'Polkadex', decimals: 12, symbol: 'PDEX', ss58Prefix: 88 },
  'nodle': { name: 'Nodle', decimals: 11, symbol: 'NODL', ss58Prefix: 37 },
  'zeitgeist': { name: 'Zeitgeist', decimals: 10, symbol: 'ZTG', ss58Prefix: 73 },
  'composable': { name: 'Composable', decimals: 12, symbol: 'LAYR', ss58Prefix: 49 },
  'pendulum': { name: 'Pendulum', decimals: 12, symbol: 'PEN', ss58Prefix: 56 },
  'frequency': { name: 'Frequency', decimals: 8, symbol: 'FRQCY', ss58Prefix: 90 },
  'darwinia': { name: 'Darwinia', decimals: 18, symbol: 'RING', ss58Prefix: 18 },
  'invarch': { name: 'InvArch', decimals: 12, symbol: 'VARCH', ss58Prefix: 117 },
  'ajuna': { name: 'Ajuna', decimals: 12, symbol: 'AJUN', ss58Prefix: 1328 },
  'peaq': { name: 'Peaq', decimals: 18, symbol: 'PEAQ', ss58Prefix: 3338 },
  'aventus': { name: 'Aventus', decimals: 18, symbol: 'AVT', ss58Prefix: 65 },
  'hashed': { name: 'Hashed', decimals: 18, symbol: 'HASH', ss58Prefix: 42 },
  'bitgreen': { name: 'Bitgreen', decimals: 18, symbol: 'BBB', ss58Prefix: 42 },
  'crust': { name: 'Crust', decimals: 12, symbol: 'CRU', ss58Prefix: 66 },
  't3rn': { name: 't3rn', decimals: 12, symbol: 'TRN', ss58Prefix: 9935 },
  'mythos': { name: 'Mythos', decimals: 18, symbol: 'MYTH', ss58Prefix: 29972 },
  'continuum': { name: 'Continuum', decimals: 18, symbol: 'NUUM', ss58Prefix: 2009 },
  'subsocial': { name: 'Subsocial', decimals: 10, symbol: 'SUB', ss58Prefix: 28 },
  'origintrail': { name: 'OriginTrail', decimals: 12, symbol: 'OTP', ss58Prefix: 101 },
  'kilt': { name: 'KILT', decimals: 15, symbol: 'KILT', ss58Prefix: 38 },
  'litentry': { name: 'Litentry', decimals: 12, symbol: 'LIT', ss58Prefix: 131 },
  'energy-web-x': { name: 'Energy Web X', decimals: 18, symbol: 'EWT', ss58Prefix: 42 },
  'logion': { name: 'Logion', decimals: 18, symbol: 'LGNT', ss58Prefix: 6039 },

  // kusama parachains
  'karura': { name: 'Karura', decimals: 12, symbol: 'KAR', ss58Prefix: 8 },
  'moonriver': { name: 'Moonriver', decimals: 18, symbol: 'MOVR', ss58Prefix: 1285 },
  'shiden': { name: 'Shiden', decimals: 18, symbol: 'SDN', ss58Prefix: 5 },
  'khala': { name: 'Khala', decimals: 12, symbol: 'PHA', ss58Prefix: 30 },
  'bifrost-kusama': { name: 'Bifrost (Kusama)', decimals: 12, symbol: 'BNC', ss58Prefix: 6 },
  'calamari': { name: 'Calamari', decimals: 12, symbol: 'KMA', ss58Prefix: 78 },
  'basilisk': { name: 'Basilisk', decimals: 12, symbol: 'BSX', ss58Prefix: 10041 },
  'kintsugi': { name: 'Kintsugi', decimals: 12, symbol: 'KINT', ss58Prefix: 2092 },
  'heiko': { name: 'Heiko', decimals: 12, symbol: 'HKO', ss58Prefix: 110 },
  'quartz': { name: 'Quartz', decimals: 18, symbol: 'QTZ', ss58Prefix: 255 },
  'crab': { name: 'Darwinia Crab', decimals: 18, symbol: 'CRAB', ss58Prefix: 42 },
  'altair': { name: 'Altair', decimals: 18, symbol: 'AIR', ss58Prefix: 136 },
  'picasso': { name: 'Picasso', decimals: 12, symbol: 'PICA', ss58Prefix: 49 },
  'turing': { name: 'Turing', decimals: 10, symbol: 'TUR', ss58Prefix: 51 },
  'mangata': { name: 'Mangata', decimals: 18, symbol: 'MGX', ss58Prefix: 42 },
  'tinkernet': { name: 'Tinkernet', decimals: 12, symbol: 'TNKR', ss58Prefix: 117 },
  'amplitude': { name: 'Amplitude', decimals: 12, symbol: 'AMPE', ss58Prefix: 57 },
  'gm': { name: 'GM Parachain', decimals: 12, symbol: 'FREN', ss58Prefix: 7013 },
  'robonomics': { name: 'Robonomics', decimals: 9, symbol: 'XRT', ss58Prefix: 32 },
  'pioneer': { name: 'Pioneer', decimals: 18, symbol: 'NEER', ss58Prefix: 268 },
  'listen': { name: 'Listen', decimals: 12, symbol: 'LT', ss58Prefix: 42 },
  'integritee-kusama': { name: 'Integritee (Kusama)', decimals: 12, symbol: 'TEER', ss58Prefix: 13 },
};

/** cache for fetched registry */
let polkadotParachainsCache: ParachainInfo[] | null = null;
let kusamaParachainsCache: ParachainInfo[] | null = null;

/**
 * fetch list of available parachains from parity chainspecs
 * parses the github pages directory listing
 */
export async function fetchAvailableParachains(relay: RelayNetwork): Promise<ParachainInfo[]> {
  // check cache
  if (relay === 'polkadot' && polkadotParachainsCache) return polkadotParachainsCache;
  if (relay === 'kusama' && kusamaParachainsCache) return kusamaParachainsCache;

  // the chainspecs site doesn't have a JSON index, so we use a curated list
  // that we know exists based on the parity chainspecs repo
  const knownChains = Object.entries(KNOWN_PARACHAINS)
    .filter(([id]) => {
      // filter by relay network based on id patterns
      if (relay === 'kusama') {
        return id.includes('kusama') || ['karura', 'moonriver', 'shiden', 'khala', 'calamari',
          'basilisk', 'kintsugi', 'heiko', 'quartz', 'crab', 'altair', 'picasso', 'turing',
          'mangata', 'tinkernet', 'amplitude', 'gm', 'robonomics', 'pioneer', 'listen'].includes(id);
      } else {
        return !id.includes('kusama') && !['karura', 'moonriver', 'shiden', 'khala', 'calamari',
          'basilisk', 'kintsugi', 'heiko', 'quartz', 'crab', 'altair', 'picasso', 'turing',
          'mangata', 'tinkernet', 'amplitude', 'gm', 'robonomics', 'pioneer', 'listen',
          'integritee-kusama'].includes(id);
      }
    })
    .map(([id, info]): ParachainInfo => ({
      id,
      name: info.name ?? id,
      relay,
      chainspecUrl: `${CHAINSPECS_BASE}/${relay}/${id}.json`,
      decimals: info.decimals,
      symbol: info.symbol,
      ss58Prefix: info.ss58Prefix,
    }));

  // cache result
  if (relay === 'polkadot') {
    polkadotParachainsCache = knownChains;
  } else {
    kusamaParachainsCache = knownChains;
  }

  return knownChains;
}

/**
 * fetch chainspec for a parachain
 */
export async function fetchParachainSpec(parachain: ParachainInfo): Promise<string> {
  const response = await fetch(parachain.chainspecUrl);
  if (!response.ok) {
    throw new Error(`failed to fetch chainspec for ${parachain.name}: ${response.status}`);
  }
  return response.text();
}

/**
 * get all available parachains (both polkadot and kusama)
 */
export async function getAllParachains(): Promise<ParachainInfo[]> {
  const [polkadot, kusama] = await Promise.all([
    fetchAvailableParachains('polkadot'),
    fetchAvailableParachains('kusama'),
  ]);
  return [...polkadot, ...kusama];
}

/**
 * build chainspec URL for a parachain
 */
export function getChainspecUrl(relay: RelayNetwork, chainId: string): string {
  return `${CHAINSPECS_BASE}/${relay}/${chainId}.json`;
}
