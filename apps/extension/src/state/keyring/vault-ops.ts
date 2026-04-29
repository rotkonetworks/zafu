/**
 * vault-ops — pure domain functions
 *
 * no I/O, no crypto, no storage. takes data, returns data.
 * every function here is independently testable.
 */

import type {
  KeyInfo,
  EncryptedVault,
  NetworkType,
  ZignerZafuImport,
} from './types';
import type { ZcashWalletJson } from '../wallets';
import type { BoxJson } from '@repo/encryption/box';

export const generateVaultId = (): string =>
  `vault-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

export const generateZcashWalletId = (): string =>
  `zcash-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

export const vaultsToKeyInfos = (
  vaults: EncryptedVault[],
  selectedId?: string,
): KeyInfo[] =>
  vaults.map(v => ({
    id: v.id,
    name: v.name,
    type: v.type,
    isSelected: v.id === selectedId,
    createdAt: v.createdAt,
    insensitive: v.insensitive,
  }));

export const buildMnemonicVault = (
  vaultId: string,
  name: string,
  encryptedData: string,
): EncryptedVault => ({
  id: vaultId,
  type: 'mnemonic',
  name,
  createdAt: Date.now(),
  encryptedData,
  salt: '',
  insensitive: {},
});

export const zignerSupportedNetworks = (data: ZignerZafuImport): string[] => {
  const networks: string[] = [];
  if (data.fullViewingKey) networks.push('penumbra');
  if (data.viewingKey) networks.push('zcash');
  if (data.polkadotSs58) networks.push('polkadot');
  if (data.cosmosAddresses?.length) {
    for (const addr of data.cosmosAddresses) {
      if (!networks.includes(addr.chainId)) {
        networks.push(addr.chainId);
      }
    }
  }
  return networks;
};

export const buildZignerVault = (
  vaultId: string,
  name: string,
  encryptedData: string,
  data: ZignerZafuImport,
  supportedNetworks: string[],
  opts: { airgapOnly?: boolean } = {},
): EncryptedVault => ({
  id: vaultId,
  type: 'zigner-zafu',
  name,
  createdAt: Date.now(),
  encryptedData,
  salt: '',
  insensitive: {
    deviceId: data.deviceId,
    accountIndex: data.accountIndex,
    supportedNetworks,
    ...(data.polkadotSs58 ? { polkadotSs58: data.polkadotSs58 } : {}),
    ...(data.polkadotGenesisHash ? { polkadotGenesisHash: data.polkadotGenesisHash } : {}),
    ...(data.cosmosAddresses?.length ? { cosmosAddresses: data.cosmosAddresses } : {}),
    ...(data.publicKey ? { cosmosPublicKey: data.publicKey } : {}),
    ...(opts.airgapOnly ? { airgapOnly: true } : {}),
    ...(data.zidPublicKey ? { zid: data.zidPublicKey } : {}),
  },
});

export type FrostCustody = 'self' | 'airgapSigner';

export interface FrostMultisigParams {
  label: string;
  address: string;
  /** Orchard-only UFVK (`uview1…`) — derived from the group public key
   * package + the host-broadcast `sk`. every participant computes this
   * locally and we verify agreement via echo-broadcast before persisting,
   * so this value is guaranteed to match across all N participants. */
  orchardFvk: string;
  publicKeyPackage: string;
  threshold: number;
  maxSigners: number;
  relayUrl: string;
  /** secret share location. defaults to 'self' (encrypted on zafu).
   * 'airgapSigner' = share lives on zigner only; keyPackage / ephemeralSeed must be omitted. */
  custody?: FrostCustody;
  /** required when custody === 'self'; absent for airgapSigner */
  keyPackage?: string;
  /** required when custody === 'self'; absent for airgapSigner */
  ephemeralSeed?: string;
  /** zigner-side wallet_id from frost_store_wallet (airgapSigner only). */
  zignerWalletId?: string;
}

export const buildFrostVault = (
  vaultId: string,
  params: FrostMultisigParams,
  encryptedData: string,
): EncryptedVault => ({
  id: vaultId,
  type: 'frost-multisig',
  name: params.label,
  createdAt: Date.now(),
  encryptedData,
  salt: '',
  insensitive: {
    publicKeyPackage: params.publicKeyPackage,
    threshold: params.threshold,
    maxSigners: params.maxSigners,
    relayUrl: params.relayUrl,
    address: params.address,
    supportedNetworks: ['zcash'],
    ...(params.custody === 'airgapSigner' ? { custody: 'airgapSigner' as const } : {}),
  },
});

export const buildFrostZcashWallet = (
  params: FrostMultisigParams,
  vaultId: string,
  encKeyPackage: BoxJson | string | undefined,
  encEphemeralSeed: BoxJson | string | undefined,
): ZcashWalletJson => ({
  id: generateZcashWalletId(),
  label: params.label,
  orchardFvk: params.orchardFvk,
  address: params.address,
  accountIndex: 0,
  mainnet: true,
  vaultId,
  multisig: {
    publicKeyPackage: params.publicKeyPackage,
    threshold: params.threshold,
    maxSigners: params.maxSigners,
    relayUrl: params.relayUrl,
    ...(params.custody === 'airgapSigner'
      ? {
          custody: 'airgapSigner' as const,
          ...(params.zignerWalletId ? { zignerWalletId: params.zignerWalletId } : {}),
        }
      : { keyPackage: encKeyPackage!, ephemeralSeed: encEphemeralSeed! }),
  },
});

export const mergeEnabledNetworks = (
  current: NetworkType[],
  toAdd: string[],
): NetworkType[] => {
  const set = new Set<string>(current);
  for (const n of toAdd) set.add(n);
  return [...set] as NetworkType[];
};

export const selectionAfterDelete = (
  remainingVaults: EncryptedVault[],
  deletedId: string,
  currentSelectedId: string | undefined,
): string | undefined => {
  if (currentSelectedId !== deletedId) return currentSelectedId;
  return remainingVaults[0]?.id;
};

export const keyInfoSupportsNetwork = (k: KeyInfo, network: NetworkType): boolean => {
  if (k.type === 'mnemonic') return true;
  const supported = k.insensitive['supportedNetworks'] as string[] | undefined;
  if (!supported) return true;
  return supported.includes(network);
};

export const findCompatibleVault = (
  keyInfos: KeyInfo[],
  network: NetworkType,
): KeyInfo | undefined =>
  keyInfos.find(k => keyInfoSupportsNetwork(k, network));

/** should the new zigner vault auto-select? */
export const shouldAutoSelectZigner = (
  currentSelectedId: string | undefined,
  existingVaultCount: number,
  activeNetwork: string,
  supportedNetworks: string[],
): boolean =>
  !currentSelectedId ||
  existingVaultCount === 0 ||
  !activeNetwork ||
  supportedNetworks.includes(activeNetwork);

/** sync wallet index for a given vaultId */
export const findWalletIndex = <T extends { vaultId?: string }>(
  wallets: T[],
  vaultId: string,
): number =>
  wallets.findIndex(w => w.vaultId === vaultId);
