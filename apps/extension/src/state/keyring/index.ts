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
  /** import zigner zafu (watch-only) */
  newZignerZafuKey: (data: ZignerZafuImport, name: string) => Promise<string>;
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
    return JSON.stringify(box);
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
    enabledNetworks: ['penumbra', 'zcash', 'polkadot'],

    init: async () => {
      const keyPrint = await local.get('passwordKeyPrint');
      const vaults = (await local.get('vaults')) ?? [];
      const selectedId = await local.get('selectedVaultId');
      const enabledNetworks = (await local.get('enabledNetworks')) ?? ['penumbra', 'zcash', 'polkadot'];

      if (!keyPrint) {
        set(state => {
          state.keyRing.status = 'empty';
          state.keyRing.keyInfos = [];
          state.keyRing.selectedKeyInfo = undefined;
          state.keyRing.enabledNetworks = enabledNetworks as NetworkType[];
        });
        return;
      }

      const sessionKey = await session.get('passwordKey');
      const keyInfos = vaultsToKeyInfos(vaults as EncryptedVault[], selectedId as string);

      set(state => {
        state.keyRing.status = sessionKey ? 'unlocked' : 'locked';
        state.keyRing.keyInfos = keyInfos;
        state.keyRing.selectedKeyInfo = keyInfos.find(k => k.isSelected);
        state.keyRing.enabledNetworks = enabledNetworks as NetworkType[];
      });
    },

    setPassword: async (password: string) => {
      const { key, keyPrint } = await Key.create(password);
      const keyJson = await key.toJson();

      await session.set('passwordKey', keyJson);
      await local.set('passwordKeyPrint', keyPrint.toJson());

      set(state => {
        state.keyRing.status = 'unlocked';
      });
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
  };
};

export const keyRingSelector = (state: AllSlices) => state.keyRing;
