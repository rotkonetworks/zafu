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

      // check if all vaults are airgap-only (use default password)
      const hasOnlyAirgap = vaults.length > 0 &&
        vaults.every(v => v.insensitive?.['airgapOnly'] === true);

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
        },
      };

      const vaults = ((await local.get('vaults')) ?? []) as EncryptedVault[];
      const newVaults = [vault, ...vaults];
      await local.set('vaults', newVaults);
      await local.set('selectedVaultId', vaultId);

      const keyInfos = vaultsToKeyInfos(newVaults, vaultId);
      set(state => {
        state.keyRing.keyInfos = keyInfos;
        state.keyRing.selectedKeyInfo = keyInfos.find(k => k.isSelected);
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
          // only mark as airgapOnly if this is a fresh setup with default password
          // if user already has a real password, this vault uses that password too
          ...(isNewSetup ? { airgapOnly: true } : {}),
        },
      };

      const vaults = ((await local.get('vaults')) ?? []) as EncryptedVault[];
      const newVaults = [vault, ...vaults];
      await local.set('vaults', newVaults);
      await local.set('selectedVaultId', vaultId);

      const keyInfos = vaultsToKeyInfos(newVaults, vaultId);
      set(state => {
        state.keyRing.keyInfos = keyInfos;
        state.keyRing.selectedKeyInfo = keyInfos.find(k => k.isSelected);
        state.keyRing.status = 'unlocked';
      });

      return vaultId;
    },

    selectKeyRing: async (vaultId: string) => {
      await local.set('selectedVaultId', vaultId);

      set(state => {
        state.keyRing.keyInfos = state.keyRing.keyInfos.map(k => ({
          ...k,
          isSelected: k.id === vaultId,
        }));
        state.keyRing.selectedKeyInfo = state.keyRing.keyInfos.find(k => k.isSelected);
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
