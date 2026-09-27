/**
 * Chain config from the cosmos chain registry (the `chain-registry` npm
 * package, pinned and bundled at build time - no runtime fetch).
 *
 * Takes what the registry is the authority on: name, chain id, bech32 prefix,
 * SLIP-44 coin type, native asset and its decimals, the average gas price. RPC
 * and REST endpoints are the registry's, kept to a few operators whose public
 * nodes have proven reliable for us, so the per-address rotation doesn't land
 * on a dead or hostile node.
 *
 * What the registry is NOT the authority on is the Penumbra IBC route: its
 * `_IBC` data still marks expired channels as preferred. Channels come from
 * the caller (the penumbrafi registry's verified pins, then live discovery).
 */

import type { Chain, AssetList } from '@chain-registry/types';
import type { CosmosChainConfig, CosmosChainId } from './chains';

/** operators whose public endpoints the rotation pool draws from */
const TRUSTED_PROVIDERS =
  /(^|\.)(polkachu\.com|publicnode\.com|cosmos\.directory|keplr\.app)(:\d+)?(\/|$)/;

const hostOf = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
};

const endpoints = (list: { address: string }[] | undefined): string[] => {
  const all = (list ?? []).map(e => e.address.replace(/\/+$/, ''));
  const trusted = all.filter(u => u.startsWith('https://') && TRUSTED_PROVIDERS.test(hostOf(u)));
  return trusted.length ? trusted : all.slice(0, 1);
};

export function chainFromRegistry(
  id: CosmosChainId,
  chain: Chain,
  assets: AssetList,
  route: { penumbraChannel: string; penumbraSourceChannel: string },
): CosmosChainConfig {
  // this builder only makes standard secp256k1 chains; an Ethermint key needs
  // its own derivation and signer (see networks/injective)
  if (chain.keyAlgos?.some(k => k !== 'secp256k1')) {
    throw new Error(
      `${chain.chainName} uses ${chain.keyAlgos.join(',')}; not a plain secp256k1 chain`,
    );
  }
  const fee = chain.fees?.feeTokens[0];
  if (!fee) {
    throw new Error(`chain-registry has no fee token for ${chain.chainName}`);
  }
  const native = assets.assets.find(a => a.base === fee.denom);
  const exponent = native?.denomUnits.find(u => u.denom === native.display)?.exponent;
  if (!native || exponent === undefined) {
    throw new Error(`chain-registry has no metadata for ${chain.chainName}'s ${fee.denom}`);
  }
  const rpcs = endpoints(chain.apis?.rpc);
  const rests = endpoints(chain.apis?.rest);
  if (!rpcs[0] || !rests[0] || !chain.bech32Prefix || !chain.chainId) {
    throw new Error(`chain-registry entry for ${chain.chainName} is missing endpoints or ids`);
  }
  return {
    id,
    name: chain.prettyName ?? chain.chainName,
    chainId: chain.chainId,
    bech32Prefix: chain.bech32Prefix,
    symbol: native.symbol,
    denom: fee.denom,
    decimals: exponent,
    rpcEndpoint: rpcs[0],
    rpcEndpoints: rpcs,
    restEndpoint: rests[0],
    gasPrice: `${fee.averageGasPrice ?? fee.lowGasPrice ?? fee.fixedMinGasPrice ?? 0}${fee.denom}`,
    // standard secp256k1 cosmos key; the coin type decides the HD path and so
    // the address (Kava is 459, the same default Keplr uses)
    coinType: chain.slip44 ?? 118,
    ...route,
  };
}
