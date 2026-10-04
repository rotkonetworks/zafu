/**
 * vault-ops - pure domain functions
 *
 * no I/O, no crypto, no storage. takes data, returns data.
 * every function here is independently testable.
 */

import type { KeyInfo, EncryptedVault, NetworkType, ZignerZafuImport, LedgerImport } from './types';
import type { ZcashWalletJson } from '../wallets';
import type { BoxJson } from '@repo/encryption/box';

export const generateVaultId = (): string =>
  `vault-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

export const generateZcashWalletId = (): string =>
  `zcash-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

export const vaultsToKeyInfos = (vaults: EncryptedVault[], selectedId?: string): KeyInfo[] =>
  vaults.map(v => ({
    id: v.id,
    name: v.name,
    type: v.type,
    isSelected: v.id === selectedId,
    createdAt: v.createdAt,
    insensitive: v.insensitive,
  }));

/** A 12-word phrase is penumbra-only: zcash won't work on 12 words. */
export const penumbraOnlyPhrase = (mnemonic: string) => mnemonic.trim().split(/\s+/).length === 12;

export const buildMnemonicVault = (
  vaultId: string,
  name: string,
  encryptedData: string,
  mnemonic: string,
): EncryptedVault => ({
  id: vaultId,
  type: 'mnemonic',
  name,
  createdAt: Date.now(),
  encryptedData,
  salt: '',
  // no field means every network, as for every vault made before this
  insensitive: penumbraOnlyPhrase(mnemonic) ? { supportedNetworks: ['penumbra'] } : {},
});

export const zignerSupportedNetworks = (data: ZignerZafuImport): string[] => {
  const networks: string[] = [];
  if (data.fullViewingKey) {
    networks.push('penumbra');
  }
  if (data.viewingKey) {
    networks.push('zcash');
  }
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
    ...(data.cosmosAddresses?.length ? { cosmosAddresses: data.cosmosAddresses } : {}),
    ...(data.publicKey ? { cosmosPublicKey: data.publicKey } : {}),
    ...(opts.airgapOnly ? { airgapOnly: true } : {}),
    ...(data.zidPublicKey ? { zid: data.zidPublicKey } : {}),
    // the send screen reads the signer kind from here: a 'viewing-key' vault
    // has no signer and must never be offered a send
    ...(data.coldSignerType ? { coldSignerType: data.coldSignerType } : {}),
  },
});

/**
 * build a Ledger cold-signer vault (clone of buildZignerVault).
 *
 * matches the Keystone precedent: the vault `type` stays `'zigner-zafu'` so it
 * reuses all existing zigner vault plumbing (unlock, select, delete, wallet
 * linkage). the discriminator lives in `insensitive.coldSignerType` and on the
 * mirrored zcash wallet record. zcash-only for now - no penumbra/cosmos
 * capabilities, so `supportedNetworks` is always `['zcash']`. no seed is stored;
 * `encryptedData` is the sealed watch-only import payload.
 */
export const buildLedgerVault = (
  vaultId: string,
  name: string,
  encryptedData: string,
  data: LedgerImport,
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
    supportedNetworks: ['zcash'],
    coldSignerType: 'ledger',
    // `vaults` is not encrypted at rest: a shielded account's UFVK and unified
    // address live only in the sealed payload and the encrypted zcashWallets
    ...(data.custody
      ? {
          custody: data.custody,
          seedFingerprint: data.seedFingerprint,
          appVersion: data.appVersion,
          deviceLabel: data.deviceLabel,
        }
      : { address: data.address }),
    ...(data.transparentAddress ? { transparentAddress: data.transparentAddress } : {}),
    ...(opts.airgapOnly ? { airgapOnly: true } : {}),
  },
});

/** the Ledger vault this import already is: same device and account, or for
 *  a shielded import the same account fingerprint and account (same keys) */
export const findLedgerDuplicate = (
  vaults: EncryptedVault[],
  data: LedgerImport,
): EncryptedVault | undefined =>
  vaults.find(
    v =>
      v.type === 'zigner-zafu' &&
      v.insensitive['coldSignerType'] === 'ledger' &&
      v.insensitive['accountIndex'] === data.accountIndex &&
      (v.insensitive['deviceId'] === data.deviceId ||
        (!!data.seedFingerprint &&
          typeof v.insensitive['seedFingerprint'] === 'string' &&
          v.insensitive['seedFingerprint'].toLowerCase() === data.seedFingerprint.toLowerCase())),
  );

export type FrostCustody = 'self' | 'airgapSigner';

export interface FrostMultisigParams {
  label: string;
  address: string;
  /** Orchard-only UFVK (`uview1…`) - derived from the group public key
   * package + the host-broadcast `sk`. every participant computes this
   * locally and we verify agreement via echo-broadcast before persisting,
   * so this value is guaranteed to match across all N participants. */
  orchardFvk: string;
  publicKeyPackage: string;
  threshold: number;
  maxSigners: number;
  relayUrl: string;
  /**
   * The other signers' frostd relay public keys, hex.
   *
   * Transport identities, not FROST ones. Required to open a session at all:
   * frostd lists a session's participants at creation and admits nobody else.
   * Optional so wallets created before the frostd migration still load.
   */
  relayPeerKeys?: string[];
  /**
   * This device's relay-identity pointer (the `frostRelayIdentities` key
   * used at DKG). Persisted so signing rebuilds the SAME transport identity
   * the co-signers whitelisted; without it a fresh wallet keys signing off
   * `publicKeyPackage`, a different keypair, and the relay rejects it.
   */
  relayCeremonyId?: string;
  /** secret share location. defaults to 'self' (encrypted on zafu).
   * 'airgapSigner' = share lives on zigner only; keyPackage / ephemeralSeed must be omitted. */
  custody?: FrostCustody;
  /** required when custody === 'self'; absent for airgapSigner */
  keyPackage?: string;
  /** required when custody === 'self'; absent for airgapSigner */
  ephemeralSeed?: string;
  /** zigner-side wallet_id from frost_store_wallet (airgapSigner only). */
  zignerWalletId?: string;
  /** hide from main wallet UI (app-driven multisigs e.g. poker); sign-time lookup still works */
  hidden?: boolean;
  /**
   * The room this seat was made in (a group, or a deal's pair room): its
   * rounds run there, not on frostd, and it never takes the active-wallet slot.
   */
  room?: SeatRoom;
  /**
   * Origin of the dapp that created the vault via the external API
   * (zafu_dkg_join / zafu_frost_create). Used by destructive external
   * operations (zafu_delete_multisig) to enforce same-origin scope - * a malicious site can't target vaults owned by another origin via
   * a guessed label prefix. Absent for vaults created via the wallet
   * UI directly (e.g. zigner-multisig flow).
   */
  createdByOrigin?: string;
}

/** where a shared wallet lives in people: its room, and the ceremony that made it */
export interface SeatRoom {
  walletId: string;
  roomId: string;
  ceremony: string;
  /** the members' room keys: who may propose and seal payments in that room */
  members: string[];
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
    ...(params.relayPeerKeys ? { relayPeerKeys: params.relayPeerKeys } : {}),
    ...(params.relayCeremonyId ? { relayCeremonyId: params.relayCeremonyId } : {}),
    ...(params.custody === 'airgapSigner' ? { custody: 'airgapSigner' as const } : {}),
    ...(params.hidden ? { hidden: true as const } : {}),
    ...(params.room ? { room: params.room } : {}),
    ...(params.createdByOrigin ? { createdByOrigin: params.createdByOrigin } : {}),
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
    ...(params.relayPeerKeys ? { relayPeerKeys: params.relayPeerKeys } : {}),
    ...(params.relayCeremonyId ? { relayCeremonyId: params.relayCeremonyId } : {}),
    ...(params.custody === 'airgapSigner'
      ? {
          custody: 'airgapSigner' as const,
          ...(params.zignerWalletId ? { zignerWalletId: params.zignerWalletId } : {}),
        }
      : { keyPackage: encKeyPackage!, ephemeralSeed: encEphemeralSeed! }),
    ...(params.hidden ? { hidden: true as const } : {}),
    ...(params.room ? { room: params.room } : {}),
  },
});

export const mergeEnabledNetworks = (current: NetworkType[], toAdd: string[]): NetworkType[] => {
  const set = new Set<string>(current);
  for (const n of toAdd) {
    set.add(n);
  }
  return [...set] as NetworkType[];
};

export const selectionAfterDelete = (
  remainingVaults: EncryptedVault[],
  deletedId: string,
  currentSelectedId: string | undefined,
): string | undefined => {
  if (currentSelectedId !== deletedId) {
    return currentSelectedId;
  }
  return remainingVaults[0]?.id;
};

export const keyInfoSupportsNetwork = (k: KeyInfo, network: NetworkType): boolean => {
  const supported = k.insensitive['supportedNetworks'] as string[] | undefined;
  if (!supported) {
    return true;
  }
  return supported.includes(network);
};

export const findCompatibleVault = (
  keyInfos: KeyInfo[],
  network: NetworkType,
): KeyInfo | undefined => keyInfos.find(k => keyInfoSupportsNetwork(k, network));

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
): number => wallets.findIndex(w => w.vaultId === vaultId);
