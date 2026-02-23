/**
 * keyring store - keplr-style single password, multiple accounts
 */

import { AllSlices, SliceCreator } from '..';
import type { ExtensionStorage } from '@repo/storage-chrome/base';
import type { LocalStorageState } from '@repo/storage-chrome/local';
import type { SessionStorageState } from '@repo/storage-chrome/session';
import { Key } from '@repo/encryption/key';
import { KeyPrint } from '@repo/encryption/key-print';
import { Box } from '@repo/encryption/box';
import type {
  KeyInfo,
  KeyRingStatus,
  EncryptedVault,
  NetworkType,
  DerivedKey,
  ZignerZafuImport,
} from './types';
import { isIbcNetwork } from './network-types';

export * from './types';
export * from './network-loader';

export interface KeyRingSlice {
  /** current status */
  status: KeyRingStatus;
  /** all key infos (accounts) */
  keyInfos: KeyInfo[];
  /** currently selected key info */
  selectedKeyInfo: KeyInfo | undefined;
  /** currently active network */
  activeNetwork: NetworkType;
  /** enabled networks for display */
  enabledNetworks: NetworkType[];

  /** initialize keyring from storage */
  init: () => Promise<void>;
  /** set master password (first time setup) */
  setPassword: (password: string) => Promise<void>;
  /** unlock with password */
  unlock: (password: string) => Promise<boolean>;
  /** lock the keyring */
  lock: () => void;
  /** check if password is correct */
  checkPassword: (password: string) => Promise<boolean>;

  /** create new mnemonic account */
  newMnemonicKey: (mnemonic: string, name: string) => Promise<string>;
  /** import zigner zafu (watch-only, encrypted) */
  newZignerZafuKey: (data: ZignerZafuImport, name: string) => Promise<string>;
  /** import zigner zafu (watch-only, unencrypted - no password required) */
  addZignerUnencrypted: (data: ZignerZafuImport, name: string) => Promise<string>;
  /** select a different account */
  selectKeyRing: (vaultId: string) => Promise<void>;
  /** rename an account */
  renameKeyRing: (vaultId: string, newName: string) => Promise<void>;
  /** delete an account */
  deleteKeyRing: (vaultId: string) => Promise<void>;

  /** get mnemonic for a vault (requires unlock) */
  getMnemonic: (vaultId: string) => Promise<string>;
  /** derive key for a network */
  deriveKey: (vaultId: string, network: NetworkType, accountIndex?: number) => Promise<DerivedKey>;

  /** toggle network visibility */
  toggleNetwork: (network: NetworkType) => Promise<void>;
  /** set active network */
  setActiveNetwork: (network: NetworkType) => Promise<void>;
}

/** create wallet entries and enable networks for a zigner import */
async function createZignerWalletEntries(
  data: ZignerZafuImport,
  name: string,
  key: Key,
  vaultId: string,
  supportedNetworks: string[],
  existingVaultCount: number,
  local: ExtensionStorage<LocalStorageState>,
): Promise<NetworkType[]> {
  // Create penumbra wallet entry for sync (prax-compatible format)
  if (data.fullViewingKey) {
    try {
      const { FullViewingKey } = await import(
        '@penumbra-zone/protobuf/penumbra/core/keys/v1/keys_pb'
      );
      const { getWalletId } = await import('@rotko/penumbra-wasm/keys');

      const fvkBytes = Uint8Array.from(atob(data.fullViewingKey), c => c.charCodeAt(0));
      const fvk = new FullViewingKey({ inner: fvkBytes });
      const walletId = await getWalletId(fvk);

      const metadata = JSON.stringify({
        accountIndex: data.accountIndex,
        importedAt: Date.now(),
        signerType: 'zigner',
      });
      const metadataBox = await key.seal(metadata);

      const praxWallet = {
        id: walletId.toJsonString(),
        label: name,
        fullViewingKey: fvk.toJsonString(),
        custody: { airgapSigner: metadataBox.toJson() },
        vaultId,
      };

      const existingWallets = await local.get('wallets');
      await local.set('wallets', [praxWallet, ...existingWallets]);
      await local.set('activeWalletIndex', 0);
    } catch (e) {
      console.warn('[keyring] failed to create penumbra wallet entry for zigner:', e);
    }
  }

  // Create zcash wallet entry
  if (data.viewingKey) {
    try {
      const existingZcashWallets = (await local.get('zcashWallets')) ?? [];
      const zcashWallet = {
        id: `zcash-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
        label: name,
        orchardFvk: data.viewingKey,
        address: '',
        accountIndex: data.accountIndex,
        mainnet: !data.viewingKey.startsWith('uviewtest'),
      };
      await local.set('zcashWallets', [zcashWallet, ...existingZcashWallets]);
    } catch (e) {
      console.warn('[keyring] failed to create zcash wallet entry for zigner:', e);
    }
  }

  // Ensure enabled networks include the imported wallet's networks
  const currentEnabled = await local.get('enabledNetworks');
  const networkSet = new Set<string>(currentEnabled ?? ['penumbra', 'zcash']);
  for (const network of supportedNetworks) {
    networkSet.add(network);
  }
  const newEnabledNetworks = [...networkSet] as NetworkType[];
  await local.set('enabledNetworks', newEnabledNetworks);

  // Set active network on first wallet
  if (existingVaultCount === 0 && supportedNetworks.length > 0) {
    await local.set('activeNetwork', supportedNetworks[0] as NetworkType);
  }

  return newEnabledNetworks;
}

export const createKeyRingSlice = (
  session: ExtensionStorage<SessionStorageState>,
  local: ExtensionStorage<LocalStorageState>,
): SliceCreator<KeyRingSlice> => (set, get) => {
  /** decrypt vault data with session key */
  const decryptVault = async (vault: EncryptedVault): Promise<string> => {
    const keyJson = await session.get('passwordKey');
    if (!keyJson) throw new Error('keyring locked');

    const key = await Key.fromJson(keyJson);
    const box = Box.fromJson(JSON.parse(vault.encryptedData));
    const decrypted = await key.unseal(box);
    if (!decrypted) throw new Error('failed to decrypt vault');
    return decrypted;
  };

  /** encrypt data with session key */
  const encryptData = async (data: string): Promise<string> => {
    const keyJson = await session.get('passwordKey');
    if (!keyJson) throw new Error('keyring locked');

    const key = await Key.fromJson(keyJson);
    const box = await key.seal(data);
    return JSON.stringify(box.toJson());
  };

  /** generate unique vault id */
  const generateVaultId = (): string => {
    return `vault-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  };

  /** convert encrypted vaults to key infos */
  const vaultsToKeyInfos = (vaults: EncryptedVault[], selectedId?: string): KeyInfo[] => {
    return vaults.map(v => ({
      id: v.id,
      name: v.name,
      type: v.type,
      isSelected: v.id === selectedId,
      createdAt: v.createdAt,
      insensitive: v.insensitive,
    }));
  };

  return {
    status: 'not-loaded',
    keyInfos: [],
    selectedKeyInfo: undefined,
    activeNetwork: 'penumbra',
    enabledNetworks: ['penumbra', 'zcash'],

    init: async () => {
      const keyPrint = await local.get('passwordKeyPrint');
      const vaults = ((await local.get('vaults')) ?? []) as EncryptedVault[];
      const selectedId = await local.get('selectedVaultId');
      const enabledNetworks = (await local.get('enabledNetworks')) ?? ['penumbra', 'zcash'];
      const activeNetwork = (await local.get('activeNetwork')) ?? 'penumbra';
      const wallets = await local.get('wallets');

      // check if all vaults are airgap-only (use default password)
      const hasOnlyAirgap = vaults.length > 0 &&
        vaults.every(v => v.insensitive?.['airgapOnly'] === true);

      // sync penumbra wallet activeIndex to match selected vault
      let syncedWalletIndex = 0;
      if (selectedId && wallets.length > 0) {
        const matchingIndex = wallets.findIndex(
          (w: { vaultId?: string }) => w.vaultId === selectedId
        );
        if (matchingIndex >= 0) {
          syncedWalletIndex = matchingIndex;
          // persist if different from stored
          const storedIndex = await local.get('activeWalletIndex');
          if (storedIndex !== matchingIndex) {
            await local.set('activeWalletIndex', matchingIndex);
          }
        }
      }

      if (!keyPrint) {
        set(state => {
          state.keyRing.status = 'empty';
          state.keyRing.keyInfos = [];
          state.keyRing.selectedKeyInfo = undefined;
          state.keyRing.activeNetwork = activeNetwork as NetworkType;
          state.keyRing.enabledNetworks = enabledNetworks as NetworkType[];
        });
        return;
      }

      let sessionKey = await session.get('passwordKey');
      const keyInfos = vaultsToKeyInfos(vaults, selectedId as string);

      // auto-unlock if only airgap signers (use default password)
      if (!sessionKey && hasOnlyAirgap) {
        const DEFAULT_AIRGAP_PASSWORD = '';
        const key = await Key.recreate(DEFAULT_AIRGAP_PASSWORD, KeyPrint.fromJson(keyPrint));
        if (key) {
          const keyJson = await key.toJson();
          await session.set('passwordKey', keyJson);
          sessionKey = keyJson;
        }
      }

      set(state => {
        state.keyRing.status = sessionKey ? 'unlocked' : 'locked';
        state.keyRing.keyInfos = keyInfos;
        state.keyRing.selectedKeyInfo = keyInfos.find(k => k.isSelected);
        state.keyRing.activeNetwork = activeNetwork as NetworkType;
        state.keyRing.enabledNetworks = enabledNetworks as NetworkType[];
        // sync wallets.activeIndex
        state.wallets.activeIndex = syncedWalletIndex;
      });
    },

    setPassword: async (password: string) => {
      const vaults = ((await local.get('vaults')) ?? []) as EncryptedVault[];
      const existingKeyPrint = await local.get('passwordKeyPrint');

      // check if we're upgrading from airgap-only (default password) setup
      const hasAirgapOnly = vaults.some(v => v.insensitive?.['airgapOnly'] === true);

      if (hasAirgapOnly && existingKeyPrint) {
        // migrate: decrypt with old default key, re-encrypt with new password
        const DEFAULT_AIRGAP_PASSWORD = '';
        const oldKey = await Key.recreate(DEFAULT_AIRGAP_PASSWORD, KeyPrint.fromJson(existingKeyPrint));
        if (!oldKey) throw new Error('failed to decrypt existing vaults for migration');

        const { key: newKey, keyPrint: newKeyPrint } = await Key.create(password);

        // re-encrypt all vaults with new key
        const migratedVaults = await Promise.all(
          vaults.map(async vault => {
            const oldBox = Box.fromJson(JSON.parse(vault.encryptedData));
            const decrypted = await oldKey.unseal(oldBox);
            if (!decrypted) throw new Error(`failed to decrypt vault ${vault.id}`);

            const newBox = await newKey.seal(decrypted);
            const newInsensitive = { ...vault.insensitive };
            delete newInsensitive['airgapOnly']; // remove airgap marker - now password protected

            return {
              ...vault,
              encryptedData: JSON.stringify(newBox.toJson()),
              insensitive: newInsensitive,
            };
          }),
        );

        await local.set('vaults', migratedVaults);
        await local.set('passwordKeyPrint', newKeyPrint.toJson());
        await session.set('passwordKey', await newKey.toJson());

        const selectedId = await local.get('selectedVaultId');
        const keyInfos = vaultsToKeyInfos(migratedVaults, selectedId as string);
        set(state => {
          state.keyRing.status = 'unlocked';
          state.keyRing.keyInfos = keyInfos;
          state.keyRing.selectedKeyInfo = keyInfos.find(k => k.isSelected);
        });
      } else {
        // fresh setup or no migration needed
        const { key, keyPrint } = await Key.create(password);
        const keyJson = await key.toJson();

        await session.set('passwordKey', keyJson);
        await local.set('passwordKeyPrint', keyPrint.toJson());

        set(state => {
          state.keyRing.status = 'unlocked';
        });
      }
    },

    unlock: async (password: string) => {
      const keyPrintJson = await local.get('passwordKeyPrint');
      if (!keyPrintJson) return false;

      const key = await Key.recreate(password, KeyPrint.fromJson(keyPrintJson));
      if (!key) return false;

      const keyJson = await key.toJson();
      await session.set('passwordKey', keyJson);

      set(state => {
        state.keyRing.status = 'unlocked';
      });

      return true;
    },

    lock: () => {
      void session.remove('passwordKey');
      set(state => {
        state.keyRing.status = 'locked';
      });
    },

    checkPassword: async (password: string) => {
      const keyPrintJson = await local.get('passwordKeyPrint');
      if (!keyPrintJson) return false;

      const key = await Key.recreate(password, KeyPrint.fromJson(keyPrintJson));
      return Boolean(key);
    },

    newMnemonicKey: async (mnemonic: string, name: string) => {
      const vaultId = generateVaultId();
      const encryptedData = await encryptData(mnemonic);

      const vault: EncryptedVault = {
        id: vaultId,
        type: 'mnemonic',
        name,
        createdAt: Date.now(),
        encryptedData,
        salt: '', // salt is in the box
        insensitive: {},
      };

      const vaults = ((await local.get('vaults')) ?? []) as EncryptedVault[];
      const newVaults = [vault, ...vaults];
      await local.set('vaults', newVaults);
      await local.set('selectedVaultId', vaultId);

      // Also populate Prax-compatible wallets array for penumbra sync
      // This stores the FVK (view-only, safe) while mnemonic stays encrypted
      try {
        const { generateSpendKey, getFullViewingKey, getWalletId } = await import(
          '@rotko/penumbra-wasm/keys'
        );
        const spendKey = await generateSpendKey(mnemonic);
        const fullViewingKey = await getFullViewingKey(spendKey);
        const walletId = await getWalletId(fullViewingKey);

        // Get password key to encrypt seed phrase for custody
        const keyJson = await session.get('passwordKey');
        if (keyJson) {
          const key = await Key.fromJson(keyJson);
          const encryptedSeedPhrase = await key.seal(mnemonic);

          const praxWallet = {
            id: walletId.toJsonString(),
            label: name,
            fullViewingKey: fullViewingKey.toJsonString(),
            custody: { encryptedSeedPhrase: encryptedSeedPhrase.toJson() },
            vaultId,
          };

          const wallets = await local.get('wallets');
          await local.set('wallets', [praxWallet, ...wallets]);
          // set active wallet index to the new wallet (index 0 since we prepend)
          await local.set('activeWalletIndex', 0);
        }
      } catch (e) {
        // Non-fatal: penumbra sync won't work but other networks will
        console.warn('[keyring] failed to create prax-compatible wallet:', e);
      }

      const keyInfos = vaultsToKeyInfos(newVaults, vaultId);
      set(state => {
        state.keyRing.keyInfos = keyInfos;
        state.keyRing.selectedKeyInfo = keyInfos.find(k => k.isSelected);
      });

      return vaultId;
    },

    newZignerZafuKey: async (data: ZignerZafuImport, name: string) => {
      const vaultId = generateVaultId();
      const encryptedData = await encryptData(JSON.stringify(data));

      // Determine which networks this zigner wallet supports
      const supportedNetworks: string[] = [];
      if (data.fullViewingKey) supportedNetworks.push('penumbra');
      if (data.viewingKey) supportedNetworks.push('zcash');
      if (data.polkadotSs58) supportedNetworks.push('polkadot');

      // Determine cosmos networks from imported addresses
      if (data.cosmosAddresses?.length) {
        for (const addr of data.cosmosAddresses) {
          if (!supportedNetworks.includes(addr.chainId)) {
            supportedNetworks.push(addr.chainId);
          }
        }
      }

      const vault: EncryptedVault = {
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
        },
      };

      const vaults = ((await local.get('vaults')) ?? []) as EncryptedVault[];
      const newVaults = [vault, ...vaults];
      await local.set('vaults', newVaults);
      await local.set('selectedVaultId', vaultId);

      const keyJson = await session.get('passwordKey');
      const key = keyJson ? await Key.fromJson(keyJson) : undefined;
      const newEnabledNetworks = key
        ? await createZignerWalletEntries(data, name, key, vaultId, supportedNetworks, vaults.length, local)
        : await (async () => {
            const currentEnabled = await local.get('enabledNetworks');
            return [...new Set<string>([...(currentEnabled ?? ['penumbra', 'zcash']), ...supportedNetworks])] as NetworkType[];
          })();

      const keyInfos = vaultsToKeyInfos(newVaults, vaultId);
      set(state => {
        state.keyRing.keyInfos = keyInfos;
        state.keyRing.selectedKeyInfo = keyInfos.find(k => k.isSelected);
        state.keyRing.enabledNetworks = newEnabledNetworks;
        if (vaults.length === 0 && supportedNetworks.length > 0) {
          state.keyRing.activeNetwork = supportedNetworks[0] as NetworkType;
        }
      });

      return vaultId;
    },

    addZignerUnencrypted: async (data: ZignerZafuImport, name: string) => {
      const vaultId = generateVaultId();

      // check if we already have a key setup (user has existing vaults)
      const existingKeyPrint = await local.get('passwordKeyPrint');
      const existingSessionKey = await session.get('passwordKey');

      let key: Key;
      let isNewSetup = false;

      if (existingKeyPrint && existingSessionKey) {
        // already have a password setup and unlocked - use existing key
        key = await Key.fromJson(existingSessionKey);
      } else if (!existingKeyPrint) {
        // fresh install - create default key for airgap-only setup
        const DEFAULT_AIRGAP_PASSWORD = '';
        const created = await Key.create(DEFAULT_AIRGAP_PASSWORD);
        key = created.key;
        isNewSetup = true;

        // set session key and store keyprint
        const keyJson = await key.toJson();
        await session.set('passwordKey', keyJson);
        await local.set('passwordKeyPrint', created.keyPrint.toJson());
      } else {
        // keyPrint exists but not unlocked - shouldn't happen in normal flow
        throw new Error('keyring locked - unlock first or use password flow');
      }

      const encryptedBox = await key.seal(JSON.stringify(data));

      // Determine which networks this zigner wallet supports based on the data
      const supportedNetworks: string[] = [];
      if (data.fullViewingKey) supportedNetworks.push('penumbra');
      if (data.viewingKey) supportedNetworks.push('zcash');
      if (data.polkadotSs58) supportedNetworks.push('polkadot');
      if (data.cosmosAddresses?.length) {
        for (const addr of data.cosmosAddresses) {
          if (!supportedNetworks.includes(addr.chainId)) {
            supportedNetworks.push(addr.chainId);
          }
        }
      }

      const vault: EncryptedVault = {
        id: vaultId,
        type: 'zigner-zafu',
        name,
        createdAt: Date.now(),
        encryptedData: JSON.stringify(encryptedBox.toJson()),
        salt: '',
        insensitive: {
          deviceId: data.deviceId,
          accountIndex: data.accountIndex,
          supportedNetworks,
          // Store polkadot ss58 address in insensitive for watch-only display
          ...(data.polkadotSs58 ? { polkadotSs58: data.polkadotSs58 } : {}),
          ...(data.polkadotGenesisHash ? { polkadotGenesisHash: data.polkadotGenesisHash } : {}),
          // Store cosmos addresses and pubkey in insensitive for watch-only display and signing
          ...(data.cosmosAddresses?.length ? { cosmosAddresses: data.cosmosAddresses } : {}),
          ...(data.publicKey ? { cosmosPublicKey: data.publicKey } : {}),
          // only mark as airgapOnly if this is a fresh setup with default password
          // if user already has a real password, this vault uses that password too
          ...(isNewSetup ? { airgapOnly: true } : {}),
        },
      };

      const vaults = ((await local.get('vaults')) ?? []) as EncryptedVault[];
      const newVaults = [vault, ...vaults];
      await local.set('vaults', newVaults);

      // Only auto-select this vault if:
      // 1. It's the first vault (fresh install), OR
      // 2. The current active network is supported by this vault
      const currentSelectedId = await local.get('selectedVaultId');
      const activeNetwork = await local.get('activeNetwork') ?? 'penumbra';
      const shouldAutoSelect = !currentSelectedId ||
        vaults.length === 0 ||
        supportedNetworks.includes(activeNetwork);

      if (shouldAutoSelect) {
        await local.set('selectedVaultId', vaultId);
      }

      const newEnabledNetworks = await createZignerWalletEntries(
        data, name, key, vaultId, supportedNetworks, vaults.length, local,
      );

      const selectedId = shouldAutoSelect ? vaultId : (currentSelectedId as string);
      const keyInfos = vaultsToKeyInfos(newVaults, selectedId);
      set(state => {
        state.keyRing.keyInfos = keyInfos;
        state.keyRing.selectedKeyInfo = keyInfos.find(k => k.isSelected);
        state.keyRing.status = 'unlocked';
        state.keyRing.enabledNetworks = newEnabledNetworks;
        if (vaults.length === 0 && supportedNetworks.length > 0) {
          state.keyRing.activeNetwork = supportedNetworks[0] as NetworkType;
        }
      });

      return vaultId;
    },

    selectKeyRing: async (vaultId: string) => {
      await local.set('selectedVaultId', vaultId);

      // sync penumbra wallet activeIndex to match the selected vault
      const wallets = await local.get('wallets');
      const matchingWalletIndex = wallets.findIndex(
        (w: { vaultId?: string }) => w.vaultId === vaultId
      );
      if (matchingWalletIndex >= 0) {
        await local.set('activeWalletIndex', matchingWalletIndex);
      }

      set(state => {
        state.keyRing.keyInfos = state.keyRing.keyInfos.map(k => ({
          ...k,
          isSelected: k.id === vaultId,
        }));
        state.keyRing.selectedKeyInfo = state.keyRing.keyInfos.find(k => k.isSelected);
        // also update wallets.activeIndex in state
        if (matchingWalletIndex >= 0) {
          state.wallets.activeIndex = matchingWalletIndex;
        }
      });
    },

    renameKeyRing: async (vaultId: string, newName: string) => {
      const vaults = ((await local.get('vaults')) ?? []) as EncryptedVault[];
      const updatedVaults = vaults.map(v =>
        v.id === vaultId ? { ...v, name: newName } : v
      );
      await local.set('vaults', updatedVaults);

      const selectedId = await local.get('selectedVaultId');
      const keyInfos = vaultsToKeyInfos(updatedVaults, selectedId as string);
      set(state => {
        state.keyRing.keyInfos = keyInfos;
        state.keyRing.selectedKeyInfo = keyInfos.find(k => k.isSelected);
      });
    },

    deleteKeyRing: async (vaultId: string) => {
      const vaults = ((await local.get('vaults')) ?? []) as EncryptedVault[];
      if (vaults.length <= 1) {
        throw new Error('cannot delete last account');
      }

      const updatedVaults = vaults.filter(v => v.id !== vaultId);
      await local.set('vaults', updatedVaults);

      // Also remove associated penumbra wallet (linked via vaultId)
      const wallets = (await local.get('wallets')) ?? [];
      const updatedWallets = wallets.filter((w: { vaultId?: string }) => w.vaultId !== vaultId);
      if (updatedWallets.length !== wallets.length) {
        await local.set('wallets', updatedWallets);

        // Adjust activeWalletIndex if needed
        const activeWalletIndex = await local.get('activeWalletIndex') ?? 0;
        if (activeWalletIndex >= updatedWallets.length) {
          await local.set('activeWalletIndex', Math.max(0, updatedWallets.length - 1));
        }
      }

      // if deleted was selected, select first remaining
      let selectedId = await local.get('selectedVaultId');
      if (selectedId === vaultId) {
        selectedId = updatedVaults[0]?.id;
        await local.set('selectedVaultId', selectedId);
      }

      const keyInfos = vaultsToKeyInfos(updatedVaults, selectedId as string);
      set(state => {
        state.keyRing.keyInfos = keyInfos;
        state.keyRing.selectedKeyInfo = keyInfos.find(k => k.isSelected);
        // Also update wallets state
        state.wallets.all = updatedWallets;
        if (state.wallets.activeIndex >= updatedWallets.length) {
          state.wallets.activeIndex = Math.max(0, updatedWallets.length - 1);
        }
      });
    },

    getMnemonic: async (vaultId: string) => {
      const vaults = ((await local.get('vaults')) ?? []) as EncryptedVault[];
      const vault = vaults.find(v => v.id === vaultId);
      if (!vault) throw new Error('vault not found');
      if (vault.type !== 'mnemonic') throw new Error('not a mnemonic vault');

      return decryptVault(vault);
    },

    deriveKey: async (vaultId: string, network: NetworkType, accountIndex = 0) => {
      // this will be implemented per-network with lazy loading
      // for now return placeholder
      const { keyInfos } = get().keyRing;
      const keyInfo = keyInfos.find(k => k.id === vaultId);
      if (!keyInfo) throw new Error('vault not found');

      return {
        keyInfoId: vaultId,
        network,
        address: `${network}:placeholder`,
        derivationPath: `m/44'/${network}'/0'/0/${accountIndex}`,
        accountIndex,
      };
    },

    toggleNetwork: async (network: NetworkType) => {
      const { enabledNetworks } = get().keyRing;
      const newNetworks = enabledNetworks.includes(network)
        ? enabledNetworks.filter(n => n !== network)
        : [...enabledNetworks, network];

      await local.set('enabledNetworks', newNetworks);
      set(state => {
        state.keyRing.enabledNetworks = newNetworks;
      });
    },

    setActiveNetwork: async (network: NetworkType) => {
      await local.set('activeNetwork', network);

      // Cosmos/IBC chains need transparent balance fetching — auto-enable
      if (isIbcNetwork(network) && !get().privacy.settings.enableTransparentBalances) {
        await get().privacy.setSetting('enableTransparentBalances', true);
      }

      // Check if current selected vault supports the new network
      const { keyInfos, selectedKeyInfo } = get().keyRing;
      const currentSupportsNetwork = selectedKeyInfo
        ? (
            selectedKeyInfo.type === 'mnemonic' ||
            !(selectedKeyInfo.insensitive['supportedNetworks'] as string[] | undefined) ||
            (selectedKeyInfo.insensitive['supportedNetworks'] as string[]).includes(network)
          )
        : false;

      // If current vault doesn't support new network, auto-select one that does
      if (!currentSupportsNetwork) {
        const compatibleVault = keyInfos.find(k =>
          k.type === 'mnemonic' ||
          !(k.insensitive['supportedNetworks'] as string[] | undefined) ||
          (k.insensitive['supportedNetworks'] as string[]).includes(network)
        );

        if (compatibleVault) {
          await local.set('selectedVaultId', compatibleVault.id);

          // sync penumbra wallet if applicable
          if (network === 'penumbra') {
            const wallets = await local.get('wallets');
            const matchingIdx = wallets.findIndex(
              (w: { vaultId?: string }) => w.vaultId === compatibleVault.id
            );
            if (matchingIdx >= 0) {
              await local.set('activeWalletIndex', matchingIdx);
            }
          }

          set(state => {
            state.keyRing.activeNetwork = network;
            state.keyRing.keyInfos = state.keyRing.keyInfos.map(k => ({
              ...k,
              isSelected: k.id === compatibleVault.id,
            }));
            state.keyRing.selectedKeyInfo = state.keyRing.keyInfos.find(k => k.isSelected);
          });
          return;
        }
      }

      set(state => {
        state.keyRing.activeNetwork = network;
      });
    },
  };
};

/** coarse selector - use sparingly, causes re-render on any keyring change */
export const keyRingSelector = (state: AllSlices) => state.keyRing;

/**
 * fine-grained atomic selectors - solidjs style
 * each selector only triggers re-render when its specific value changes
 */
export const selectActiveNetwork = (state: AllSlices) => state.keyRing.activeNetwork;
export const selectEnabledNetworks = (state: AllSlices) => state.keyRing.enabledNetworks;
export const selectSetActiveNetwork = (state: AllSlices) => state.keyRing.setActiveNetwork;
export const selectSelectedKeyInfo = (state: AllSlices) => state.keyRing.selectedKeyInfo;
export const selectKeyInfos = (state: AllSlices) => state.keyRing.keyInfos;
export const selectStatus = (state: AllSlices) => state.keyRing.status;
export const selectLock = (state: AllSlices) => state.keyRing.lock;
export const selectUnlock = (state: AllSlices) => state.keyRing.unlock;
export const selectSelectKeyRing = (state: AllSlices) => state.keyRing.selectKeyRing;

/** Helper to check if a keyInfo supports a given network */
const keyInfoSupportsNetwork = (k: KeyInfo, network: NetworkType): boolean => {
  // mnemonic wallets support all networks
  if (k.type === 'mnemonic') return true;
  // zigner wallets check supportedNetworks
  const supported = k.insensitive['supportedNetworks'] as string[] | undefined;
  // if no supportedNetworks defined, assume all networks (legacy)
  if (!supported) return true;
  return supported.includes(network);
};

/**
 * Returns keyInfos filtered to only those that support the current active network.
 * - Mnemonic wallets support all networks
 * - Zigner wallets only support networks specified in insensitive.supportedNetworks
 */
export const selectKeyInfosForActiveNetwork = (state: AllSlices) => {
  const { keyInfos, activeNetwork } = state.keyRing;
  return keyInfos.filter(k => keyInfoSupportsNetwork(k, activeNetwork));
};

/**
 * Returns the effective selected keyInfo for the current network.
 * If the globally selected keyInfo doesn't support the current network,
 * returns the first keyInfo that does.
 */
export const selectEffectiveKeyInfo = (state: AllSlices) => {
  const { keyInfos, selectedKeyInfo, activeNetwork } = state.keyRing;

  // If selected supports current network, use it
  if (selectedKeyInfo && keyInfoSupportsNetwork(selectedKeyInfo, activeNetwork)) {
    return selectedKeyInfo;
  }

  // Otherwise find first that supports the network
  return keyInfos.find(k => keyInfoSupportsNetwork(k, activeNetwork));
};
