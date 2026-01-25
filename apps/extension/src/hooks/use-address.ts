/**
 * hook to get active wallet address for current network
 *
 * supports two vault types:
 * - mnemonic: derive addresses on demand for any network
 * - zigner-zafu: use stored viewing keys/addresses (watch-only)
 */

import { useState, useEffect } from 'react';
import { useStore } from '../state';
import { selectActiveNetwork, selectSelectedKeyInfo, keyRingSelector } from '../state/keyring';
import { getActiveWalletJson, selectActiveZcashWallet } from '../state/wallets';
import { NETWORK_CONFIGS, type IbcNetwork, isIbcNetwork } from '../state/keyring/network-types';

/** get penumbra address from FVK */
async function getPenumbraAddress(fvkBytes: Uint8Array, index = 0): Promise<string> {
  const { getAddressByIndex } = await import('@penumbra-zone/wasm/keys');
  const { bech32mAddress } = await import('@penumbra-zone/bech32m/penumbra');
  const { FullViewingKey } = await import('@penumbra-zone/protobuf/penumbra/core/keys/v1/keys_pb');

  const fvk = new FullViewingKey({ inner: fvkBytes });
  const address = getAddressByIndex(fvk, index);
  return bech32mAddress(address);
}

/** derive cosmos/ibc address from mnemonic */
async function deriveCosmosAddress(mnemonic: string, prefix: string): Promise<string> {
  const { deriveCosmosWallet } = await import('@repo/wallet/networks/cosmos/signer');
  const wallet = await deriveCosmosWallet(mnemonic, 0, prefix);
  return wallet.address;
}

/** derive polkadot/kusama ed25519 address from mnemonic */
async function derivePolkadotAddress(
  mnemonic: string,
  network: 'polkadot' | 'kusama'
): Promise<string> {
  const { derivePolkadotAddress: derive } = await import('@repo/wallet/networks/polkadot/derive');
  return derive(mnemonic, network, 0);
}

/** derive penumbra address from mnemonic */
async function derivePenumbraAddress(mnemonic: string, index = 0): Promise<string> {
  const { generateSpendKey, getFullViewingKey, getAddressByIndex } = await import('@penumbra-zone/wasm/keys');
  const { bech32mAddress } = await import('@penumbra-zone/bech32m/penumbra');

  const spendKey = generateSpendKey(mnemonic);
  const fvk = getFullViewingKey(spendKey);
  const address = getAddressByIndex(fvk, index);
  return bech32mAddress(address);
}

/** derive zcash orchard address from mnemonic */
async function deriveZcashAddress(mnemonic: string, account = 0, mainnet = true): Promise<string> {
  const zcashWasm = await import('@repo/zcash-wasm');
  await zcashWasm.default();
  return zcashWasm.derive_zcash_address(mnemonic, account, mainnet);
}

export function useActiveAddress() {
  const activeNetwork = useStore(selectActiveNetwork);
  const selectedKeyInfo = useStore(selectSelectedKeyInfo);
  const keyRing = useStore(keyRingSelector);
  const penumbraWallet = useStore(getActiveWalletJson);
  const zcashWallet = useStore(selectActiveZcashWallet);

  const [address, setAddress] = useState<string>('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    const deriveAddress = async () => {
      setLoading(true);

      try {
        // mnemonic vault - derive addresses from seed for all networks
        if (selectedKeyInfo?.type === 'mnemonic') {
          try {
            const mnemonic = await keyRing.getMnemonic(selectedKeyInfo.id);

            // penumbra - derive from seed
            if (activeNetwork === 'penumbra') {
              const addr = await derivePenumbraAddress(mnemonic, 0);
              if (!cancelled) setAddress(addr);
              if (!cancelled) setLoading(false);
              return;
            }

            // zcash - derive orchard address from seed
            if (activeNetwork === 'zcash') {
              const addr = await deriveZcashAddress(mnemonic, 0, true);
              if (!cancelled) setAddress(addr);
              if (!cancelled) setLoading(false);
              return;
            }

            // cosmos/ibc chains
            if (isIbcNetwork(activeNetwork)) {
              const config = NETWORK_CONFIGS[activeNetwork as IbcNetwork];
              const addr = await deriveCosmosAddress(mnemonic, config.bech32Prefix!);
              if (!cancelled) setAddress(addr);
              if (!cancelled) setLoading(false);
              return;
            }

            // polkadot/kusama - use ed25519 derivation (ledger compatible)
            if (activeNetwork === 'polkadot' || activeNetwork === 'kusama') {
              const addr = await derivePolkadotAddress(mnemonic, activeNetwork);
              if (!cancelled) setAddress(addr);
              if (!cancelled) setLoading(false);
              return;
            }

            // ethereum - need ethers or viem (not available)
            if (activeNetwork === 'ethereum') {
              if (!cancelled) setAddress('');
              if (!cancelled) setLoading(false);
              return;
            }

            // bitcoin - need bitcoinjs-lib (not available)
            if (activeNetwork === 'bitcoin') {
              if (!cancelled) setAddress('');
              if (!cancelled) setLoading(false);
              return;
            }
          } catch (err) {
            console.error('failed to derive from mnemonic:', err);
          }
        }

        // zigner-zafu vault or fallback - use stored viewing keys
        if (activeNetwork === 'penumbra' && penumbraWallet?.fullViewingKey) {
          const fvkHex = penumbraWallet.fullViewingKey;
          const fvkBytes = new Uint8Array(
            fvkHex.match(/.{1,2}/g)?.map(byte => parseInt(byte, 16)) ?? []
          );
          const addr = await getPenumbraAddress(fvkBytes, 0);
          if (!cancelled) setAddress(addr);
          if (!cancelled) setLoading(false);
          return;
        }

        if (activeNetwork === 'zcash' && zcashWallet?.address) {
          if (!cancelled) setAddress(zcashWallet.address);
          if (!cancelled) setLoading(false);
          return;
        }

        // zigner-zafu vault - check insensitive data for stored keys
        if (selectedKeyInfo?.type === 'zigner-zafu') {
          const insensitive = selectedKeyInfo.insensitive ?? {};

          // check for stored polkadot key
          if ((activeNetwork === 'polkadot' || activeNetwork === 'kusama') && insensitive['polkadotSs58']) {
            if (!cancelled) setAddress(insensitive['polkadotSs58'] as string);
            if (!cancelled) setLoading(false);
            return;
          }
        }

        // fallback - no address available
        if (!cancelled) setAddress('');
      } catch (err) {
        console.error('failed to derive address:', err);
        if (!cancelled) setAddress('');
      }

      if (!cancelled) setLoading(false);
    };

    void deriveAddress();
    return () => { cancelled = true; };
  }, [activeNetwork, selectedKeyInfo?.id, selectedKeyInfo?.type, penumbraWallet?.fullViewingKey, zcashWallet?.address, keyRing]);

  return { address, loading };
}
