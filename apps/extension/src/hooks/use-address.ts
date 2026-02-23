/**
 * hook to get active wallet address for current network
 *
 * supports two vault types:
 * - mnemonic: derive addresses on demand for any network
 * - zigner-zafu: use stored viewing keys/addresses (watch-only)
 */

import { useState, useEffect } from 'react';
import { useStore } from '../state';
import { selectActiveNetwork, selectEffectiveKeyInfo, keyRingSelector } from '../state/keyring';
import { getActiveWalletJson, selectActiveZcashWallet } from '../state/wallets';
import { NETWORK_CONFIGS, type IbcNetwork, isIbcNetwork } from '../state/keyring/network-types';
import type { CosmosChainId } from '@repo/wallet/networks/cosmos/chains';

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
  const { generateSpendKey, getFullViewingKey, getAddressByIndex } = await import('@rotko/penumbra-wasm/keys');
  const { bech32mAddress } = await import('@penumbra-zone/bech32m/penumbra');

  const spendKey = await generateSpendKey(mnemonic);
  const fvk = await getFullViewingKey(spendKey);
  const address = await getAddressByIndex(fvk, index);
  return bech32mAddress(address);
}

/** derive a random ephemeral penumbra address from mnemonic (each call returns a different address) */
async function derivePenumbraEphemeralFromMnemonic(mnemonic: string, index = 0): Promise<string> {
  const { generateSpendKey, getFullViewingKey, getEphemeralByIndex } = await import('@rotko/penumbra-wasm/keys');
  const { bech32mAddress } = await import('@penumbra-zone/bech32m/penumbra');

  const spendKey = await generateSpendKey(mnemonic);
  const fvk = await getFullViewingKey(spendKey);
  const address = await getEphemeralByIndex(fvk, index);
  return bech32mAddress(address);
}

/** derive a random ephemeral penumbra address from stored FVK JSON */
async function derivePenumbraEphemeralFromFvk(fvkJson: string, index = 0): Promise<string> {
  const { FullViewingKey } = await import('@penumbra-zone/protobuf/penumbra/core/keys/v1/keys_pb');
  const { getEphemeralByIndex } = await import('@rotko/penumbra-wasm/keys');
  const { bech32mAddress } = await import('@penumbra-zone/bech32m/penumbra');

  const fvk = FullViewingKey.fromJsonString(fvkJson);
  const address = await getEphemeralByIndex(fvk, index);
  return bech32mAddress(address);
}

export { derivePenumbraEphemeralFromMnemonic, derivePenumbraEphemeralFromFvk };

/** load zcash wasm module from extension root (cached after first init) */
let zcashWasmCache: unknown;
async function loadZcashWasm() {
  if (zcashWasmCache) return zcashWasmCache;
  const wasmJsUrl = chrome.runtime.getURL('zafu-wasm/zafu_wasm.js');
  const wasmBinaryUrl = chrome.runtime.getURL('zafu-wasm/zafu_wasm_bg.wasm');
  const zcashWasm = await import(/* webpackIgnore: true */ wasmJsUrl);
  await zcashWasm.default(wasmBinaryUrl);
  zcashWasmCache = zcashWasm;
  return zcashWasm;
}

/** derive zcash orchard address from mnemonic (requires 24-word seed) */
async function deriveZcashAddress(mnemonic: string, account = 0, mainnet = true): Promise<string> {
  const zcashWasm = await loadZcashWasm();
  return zcashWasm.derive_zcash_address(mnemonic, account, mainnet);
}

/** derive zcash address from UFVK string (for watch-only wallets) */
async function deriveZcashAddressFromUfvk(ufvk: string): Promise<string> {
  const zcashWasm = await loadZcashWasm();
  return zcashWasm.address_from_ufvk(ufvk);
}

export function useActiveAddress() {
  const activeNetwork = useStore(selectActiveNetwork);
  const selectedKeyInfo = useStore(selectEffectiveKeyInfo);
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
          const { FullViewingKey } = await import('@penumbra-zone/protobuf/penumbra/core/keys/v1/keys_pb');
          const { getAddressByIndex } = await import('@rotko/penumbra-wasm/keys');
          const { bech32mAddress } = await import('@penumbra-zone/bech32m/penumbra');

          // fullViewingKey is stored as JSON string: {"inner":"base64..."}
          const fvk = FullViewingKey.fromJsonString(penumbraWallet.fullViewingKey);
          const address = await getAddressByIndex(fvk, 0);
          const addr = bech32mAddress(address);
          if (!cancelled) setAddress(addr);
          if (!cancelled) setLoading(false);
          return;
        }

        if (activeNetwork === 'zcash' && zcashWallet) {
          // use stored address if available
          if (zcashWallet.address) {
            if (!cancelled) setAddress(zcashWallet.address);
            if (!cancelled) setLoading(false);
            return;
          }
          // derive from UFVK if orchardFvk is a ufvk string (uview1.../uviewtest1...)
          if (zcashWallet.orchardFvk?.startsWith('uview')) {
            try {
              const addr = await deriveZcashAddressFromUfvk(zcashWallet.orchardFvk);
              if (!cancelled) setAddress(addr);
              if (!cancelled) setLoading(false);
              return;
            } catch (err) {
              console.error('failed to derive address from ufvk:', err);
            }
          }
        }

        // zigner-zafu vault - check insensitive data for stored keys
        if (selectedKeyInfo?.type === 'zigner-zafu') {
          const insensitive = selectedKeyInfo.insensitive ?? {};

          // check for stored cosmos/ibc address
          if (isIbcNetwork(activeNetwork)) {
            const addrs = insensitive['cosmosAddresses'] as
              { chainId: string; address: string; prefix: string }[] | undefined;
            if (addrs) {
              const match = addrs.find(a => a.chainId === activeNetwork);
              if (match) {
                if (!cancelled) setAddress(match.address);
                if (!cancelled) setLoading(false);
                return;
              }
              // derive from any stored address using bech32 prefix conversion
              if (addrs.length > 0) {
                try {
                  const { deriveChainAddress } = await import('@repo/wallet/networks/cosmos/signer');
                  const addr = deriveChainAddress(addrs[0]!.address, activeNetwork as CosmosChainId);
                  if (!cancelled) setAddress(addr);
                  if (!cancelled) setLoading(false);
                  return;
                } catch (err) {
                  console.error('failed to derive cosmos address:', err);
                }
              }
            }
          }

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
  }, [activeNetwork, selectedKeyInfo?.id, selectedKeyInfo?.type, penumbraWallet?.fullViewingKey, zcashWallet?.address, zcashWallet?.orchardFvk, keyRing]);

  return { address, loading };
}
