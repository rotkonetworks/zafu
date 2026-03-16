/**
 * keyring store — thin zustand adapter
 *
 * follows "your server as a function" (eriksen):
 * each method is a pipeline of read → compute → write → commit.
 * domain logic lives in vault-ops (pure), crypto in crypto-ops,
 * storage effects in wallet-entries.
 */

import { AllSlices, SliceCreator } from '..';
import type { ExtensionStorage } from '@repo/storage-chrome/base';
import type { LocalStorageState } from '@repo/storage-chrome/local';
import type { SessionStorageState } from '@repo/storage-chrome/session';
import { Key } from '@repo/encryption/key';
import type {
  KeyInfo,
  KeyRingStatus,
  EncryptedVault,
  NetworkType,
  DerivedKey,
  ZignerZafuImport,
} from './types';
import type { ZcashWalletJson } from '../wallets';

// pure domain functions
import {
  generateVaultId,
  vaultsToKeyInfos,
  buildMnemonicVault,
  buildZignerVault,
  buildFrostVault,
  buildFrostZcashWallet,
  zignerSupportedNetworks,
  mergeEnabledNetworks,
  selectionAfterDelete,
  keyInfoSupportsNetwork,
  findCompatibleVault,
  shouldAutoSelectZigner,
  findWalletIndex,
} from './vault-ops';
import type { FrostMultisigParams } from './vault-ops';

// crypto operations
import type { CryptoCtx } from './crypto-ops';
import {
  requireKey,
  encrypt,
  decryptVault,
  createMasterKey,
  recreateMasterKey,
  reencryptVault,
  decryptMultisigSecrets,
  encryptFrostSecrets,
} from './crypto-ops';

// storage effects
import {
  createPenumbraWalletForMnemonic,
  createZignerWalletEntries,
  removeLinkedWallets,
  cleanupZcashData,
  nukeAllWalletData,
} from './wallet-entries';

// migration
import { migrateOrphanedMultisigs, hasOrphanedMultisigs } from './migration';

export * from './types';
export * from './network-loader';

export interface KeyRingSlice {
  status: KeyRingStatus;
  keyInfos: KeyInfo[];
  selectedKeyInfo: KeyInfo | undefined;
  activeNetwork: NetworkType;
  enabledNetworks: NetworkType[];

  init: () => Promise<void>;
  setPassword: (password: string) => Promise<void>;
  unlock: (password: string) => Promise<boolean>;
  lock: () => void;
  checkPassword: (password: string) => Promise<boolean>;

  newMnemonicKey: (mnemonic: string, name: string) => Promise<string>;
  newZignerZafuKey: (data: ZignerZafuImport, name: string) => Promise<string>;
  addZignerUnencrypted: (data: ZignerZafuImport, name: string) => Promise<string>;
  newFrostMultisigKey: (params: FrostMultisigParams) => Promise<string>;
  selectKeyRing: (vaultId: string) => Promise<void>;
  renameKeyRing: (vaultId: string, newName: string) => Promise<void>;
  deleteKeyRing: (vaultId: string) => Promise<void>;

  getMnemonic: (vaultId: string) => Promise<string>;
  getMultisigSecrets: (vaultId: string) => Promise<{ keyPackage: string; ephemeralSeed: string } | null>;
  deriveKey: (vaultId: string, network: NetworkType, accountIndex?: number) => Promise<DerivedKey>;

  toggleNetwork: (network: NetworkType) => Promise<void>;
  setActiveNetwork: (network: NetworkType) => Promise<void>;

  penumbraAccount: number;
  setPenumbraAccount: (account: number) => void;
}

export const createKeyRingSlice = (
  session: ExtensionStorage<SessionStorageState>,
  local: ExtensionStorage<LocalStorageState>,
): SliceCreator<KeyRingSlice> => (set, get) => {
  const ctx: CryptoCtx = { session };

  return {
    status: 'not-loaded',
    keyInfos: [],
    selectedKeyInfo: undefined,
    activeNetwork: '' as NetworkType,
    enabledNetworks: [],
    penumbraAccount: 0,
    setPenumbraAccount: (account: number) => set(state => { state.keyRing.penumbraAccount = account; }),

    // ── init ──

    init: async () => {
      const keyPrint = await local.get('passwordKeyPrint');
      const rawVaults = ((await local.get('vaults')) ?? []) as EncryptedVault[];
      const selectedId = await local.get('selectedVaultId');
      const enabledNetworks = (await local.get('enabledNetworks')) ?? [];
      const activeNetwork = (await local.get('activeNetwork')) ?? (enabledNetworks[0] ?? '');
      const wallets = await local.get('wallets');
      const zcashWallets = ((await local.get('zcashWallets')) ?? []) as ZcashWalletJson[];

      // migration
      let vaults = rawVaults;
      if (hasOrphanedMultisigs(zcashWallets)) {
        const sessionKey = await session.get('passwordKey');
        const migrated = await migrateOrphanedMultisigs(rawVaults, zcashWallets, sessionKey, local);
        vaults = migrated.vaults;
      }

      // auto-unlock for airgap-only setups
      const hasOnlyAirgap = vaults.length > 0 && vaults.every(v => v.insensitive?.['airgapOnly'] === true);

      // sync penumbra wallet index
      let syncedWalletIndex = 0;
      if (selectedId && wallets.length > 0) {
        const idx = findWalletIndex(wallets as { vaultId?: string }[], selectedId as string);
        if (idx >= 0) {
          syncedWalletIndex = idx;
          const storedIndex = await local.get('activeWalletIndex');
          if (storedIndex !== idx) await local.set('activeWalletIndex', idx);
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

      if (!sessionKey && hasOnlyAirgap) {
        const result = await recreateMasterKey('', keyPrint);
        if (result) {
          await session.set('passwordKey', result.keyJson);
          sessionKey = result.keyJson;
        }
      }

      set(state => {
        state.keyRing.status = sessionKey ? 'unlocked' : 'locked';
        state.keyRing.keyInfos = keyInfos;
        state.keyRing.selectedKeyInfo = keyInfos.find(k => k.isSelected);
        state.keyRing.activeNetwork = activeNetwork as NetworkType;
        state.keyRing.enabledNetworks = enabledNetworks as NetworkType[];
        state.wallets.activeIndex = syncedWalletIndex;
      });
    },

    // ── password / unlock / lock ──

    setPassword: async (password: string) => {
      const vaults = ((await local.get('vaults')) ?? []) as EncryptedVault[];
      const existingKeyPrint = await local.get('passwordKeyPrint');
      const hasAirgapOnly = vaults.some(v => v.insensitive?.['airgapOnly'] === true);

      if (hasAirgapOnly && existingKeyPrint) {
        const oldResult = await recreateMasterKey('', existingKeyPrint);
        if (!oldResult) throw new Error('failed to decrypt existing vaults for migration');

        const { key: newKey, keyPrint: newKeyPrint, keyJson: newKeyJson } = await createMasterKey(password);
        const migratedVaults = await Promise.all(
          vaults.map(v => reencryptVault(v, oldResult.key, newKey)),
        );

        await local.set('vaults', migratedVaults);
        await local.set('passwordKeyPrint', newKeyPrint.toJson());
        await session.set('passwordKey', newKeyJson);

        const selectedId = await local.get('selectedVaultId');
        const keyInfos = vaultsToKeyInfos(migratedVaults, selectedId as string);
        set(state => {
          state.keyRing.status = 'unlocked';
          state.keyRing.keyInfos = keyInfos;
          state.keyRing.selectedKeyInfo = keyInfos.find(k => k.isSelected);
        });
      } else {
        const { keyJson, keyPrint } = await createMasterKey(password);
        await session.set('passwordKey', keyJson);
        await local.set('passwordKeyPrint', keyPrint.toJson());
        set(state => { state.keyRing.status = 'unlocked'; });
      }
    },

    unlock: async (password: string) => {
      const keyPrintJson = await local.get('passwordKeyPrint');
      if (!keyPrintJson) return false;

      const result = await recreateMasterKey(password, keyPrintJson);
      if (!result) return false;

      await session.set('passwordKey', result.keyJson);
      set(state => { state.keyRing.status = 'unlocked'; });
      return true;
    },

    lock: () => {
      void session.remove('passwordKey');
      set(state => { state.keyRing.status = 'locked'; });
    },

    checkPassword: async (password: string) => {
      const keyPrintJson = await local.get('passwordKeyPrint');
      if (!keyPrintJson) return false;
      return (await recreateMasterKey(password, keyPrintJson)) !== null;
    },

    // ── vault creation ──

    newMnemonicKey: async (mnemonic: string, name: string) => {
      const vaultId = generateVaultId();
      const encryptedData = await encrypt(ctx, mnemonic);
      const vault = buildMnemonicVault(vaultId, name, encryptedData);

      const vaults = ((await local.get('vaults')) ?? []) as EncryptedVault[];
      const newVaults = [vault, ...vaults];
      await local.set('vaults', newVaults);
      await local.set('selectedVaultId', vaultId);

      // penumbra wallet entry (non-fatal)
      const key = await requireKey(ctx).catch(() => undefined);
      if (key) {
        await createPenumbraWalletForMnemonic(mnemonic, name, vaultId, key, local)
          .catch(e => console.warn('[keyring] failed to create prax-compatible wallet:', e));
      }

      const keyInfos = vaultsToKeyInfos(newVaults, vaultId);
      const enabledNetworks = (await local.get('enabledNetworks')) ?? [];
      if (vaults.length === 0 && enabledNetworks.length > 0) {
        await local.set('activeNetwork', enabledNetworks[0]);
      }

      set(state => {
        state.keyRing.keyInfos = keyInfos;
        state.keyRing.selectedKeyInfo = keyInfos.find(k => k.isSelected);
        if (vaults.length === 0 && enabledNetworks.length > 0) {
          state.keyRing.activeNetwork = enabledNetworks[0] as NetworkType;
        }
      });

      return vaultId;
    },

    newZignerZafuKey: async (data: ZignerZafuImport, name: string) => {
      const vaultId = generateVaultId();
      const encryptedData = await encrypt(ctx, JSON.stringify(data));
      const supportedNetworks = zignerSupportedNetworks(data);
      const vault = buildZignerVault(vaultId, name, encryptedData, data, supportedNetworks);

      const vaults = ((await local.get('vaults')) ?? []) as EncryptedVault[];
      const newVaults = [vault, ...vaults];
      await local.set('vaults', newVaults);
      await local.set('selectedVaultId', vaultId);

      const key = await requireKey(ctx).catch(() => undefined);
      const newEnabledNetworks = key
        ? await createZignerWalletEntries(data, name, key, vaultId, supportedNetworks, vaults.length, local)
        : mergeEnabledNetworks((await local.get('enabledNetworks')) ?? [] as NetworkType[], supportedNetworks);

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
      // dedup: check if a vault with the same viewing key already exists
      const existingVaults = ((await local.get('vaults')) ?? []) as EncryptedVault[];
      for (const v of existingVaults) {
        if (v.type !== 'zigner-zafu') continue;
        // match by deviceId + accountIndex (same device, same account = same keys)
        if (
          v.insensitive['deviceId'] === data.deviceId &&
          v.insensitive['accountIndex'] === data.accountIndex
        ) {
          throw new Error('this zigner wallet is already imported');
        }
      }
      // also check zcash wallets for matching FVK (catches cross-device duplicates)
      if (data.viewingKey) {
        const existingZcash = ((await local.get('zcashWallets')) ?? []) as ZcashWalletJson[];
        if (existingZcash.some(w => w.orchardFvk === data.viewingKey)) {
          throw new Error('a wallet with this zcash viewing key already exists');
        }
      }
      // check penumbra wallets for matching FVK
      if (data.fullViewingKey) {
        const existingPenumbra = (await local.get('wallets')) ?? [];
        const fvkB64 = data.fullViewingKey;
        // penumbra wallets store FVK as JSON string — compare via base64 of inner bytes
        for (const w of existingPenumbra) {
          try {
            const { FullViewingKey } = await import('@penumbra-zone/protobuf/penumbra/core/keys/v1/keys_pb');
            const existing = FullViewingKey.fromJsonString(w.fullViewingKey);
            const existingB64 = btoa(String.fromCharCode(...existing.inner));
            if (existingB64 === fvkB64) {
              throw new Error('a wallet with this penumbra viewing key already exists');
            }
          } catch (e) {
            if (e instanceof Error && e.message.includes('already exists')) throw e;
            // parse error — skip this wallet
          }
        }
      }

      const vaultId = generateVaultId();
      const existingKeyPrint = await local.get('passwordKeyPrint');
      const existingSessionKey = await session.get('passwordKey');

      let key: Key;
      let isNewSetup = false;

      if (existingKeyPrint && existingSessionKey) {
        key = await Key.fromJson(existingSessionKey);
      } else if (!existingKeyPrint) {
        const created = await createMasterKey('');
        key = created.key;
        isNewSetup = true;
        await session.set('passwordKey', created.keyJson);
        await local.set('passwordKeyPrint', created.keyPrint.toJson());
      } else {
        throw new Error('keyring locked - unlock first or use password flow');
      }

      const encryptedBox = await key.seal(JSON.stringify(data));
      const supportedNetworks = zignerSupportedNetworks(data);
      const vault = buildZignerVault(
        vaultId, name, JSON.stringify(encryptedBox.toJson()),
        data, supportedNetworks, { airgapOnly: isNewSetup },
      );

      const vaults = ((await local.get('vaults')) ?? []) as EncryptedVault[];
      const newVaults = [vault, ...vaults];
      await local.set('vaults', newVaults);

      const currentSelectedId = await local.get('selectedVaultId');
      const activeNetwork = await local.get('activeNetwork') ?? '';
      const autoSelect = shouldAutoSelectZigner(
        currentSelectedId as string, vaults.length, activeNetwork, supportedNetworks,
      );
      if (autoSelect) await local.set('selectedVaultId', vaultId);

      const newEnabledNetworks = await createZignerWalletEntries(
        data, name, key, vaultId, supportedNetworks, vaults.length, local,
      );

      const selectedId = autoSelect ? vaultId : (currentSelectedId as string);
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

    newFrostMultisigKey: async (params) => {
      const vaultId = generateVaultId();
      const encryptedData = await encrypt(
        ctx, JSON.stringify({ keyPackage: params.keyPackage, ephemeralSeed: params.ephemeralSeed }),
      );
      const vault = buildFrostVault(vaultId, params, encryptedData);

      const vaults = ((await local.get('vaults')) ?? []) as EncryptedVault[];
      const newVaults = [vault, ...vaults];
      await local.set('vaults', newVaults);
      await local.set('selectedVaultId', vaultId);

      // create linked zcash wallet
      const { encKeyPackage, encEphemeralSeed } = await encryptFrostSecrets(ctx, params.keyPackage, params.ephemeralSeed);
      const zcashWallet = buildFrostZcashWallet(params, vaultId, encKeyPackage, encEphemeralSeed);
      const existingZcash = ((await local.get('zcashWallets')) ?? []) as ZcashWalletJson[];
      await local.set('zcashWallets', [zcashWallet, ...existingZcash]);
      await local.set('activeZcashIndex', 0);

      const newEnabledNetworks = mergeEnabledNetworks(
        (await local.get('enabledNetworks')) ?? [] as NetworkType[], ['zcash'],
      );
      await local.set('enabledNetworks', newEnabledNetworks);

      const keyInfos = vaultsToKeyInfos(newVaults, vaultId);
      set(state => {
        state.keyRing.keyInfos = keyInfos;
        state.keyRing.selectedKeyInfo = keyInfos.find(k => k.isSelected);
        state.keyRing.enabledNetworks = newEnabledNetworks;
        state.wallets.zcashWallets = [zcashWallet, ...existingZcash];
        state.wallets.activeZcashIndex = 0;
        if (vaults.length === 0) {
          state.keyRing.activeNetwork = 'zcash' as NetworkType;
        }
      });

      return vaultId;
    },

    // ── vault management ──

    selectKeyRing: async (vaultId: string) => {
      await local.set('selectedVaultId', vaultId);

      // sync penumbra wallet index
      const wallets = await local.get('wallets');
      const walletIdx = findWalletIndex(wallets as { vaultId?: string }[], vaultId);
      if (walletIdx >= 0) await local.set('activeWalletIndex', walletIdx);

      // sync zcash wallet index — -1 means no zcash wallet record (mnemonic derives on-the-fly)
      const zcashWallets = (await local.get('zcashWallets')) ?? [];
      const zcashIdx = findWalletIndex(zcashWallets as { vaultId?: string }[], vaultId);
      // only persist a valid index; -1 means "use vault mnemonic, not a zcash wallet record"
      if (zcashIdx >= 0) {
        await local.set('activeZcashIndex', zcashIdx);
      }

      set(state => {
        state.keyRing.keyInfos = state.keyRing.keyInfos.map(k => ({
          ...k, isSelected: k.id === vaultId,
        }));
        state.keyRing.selectedKeyInfo = state.keyRing.keyInfos.find(k => k.isSelected);
        if (walletIdx >= 0) state.wallets.activeIndex = walletIdx;
        if (zcashIdx >= 0) state.wallets.activeZcashIndex = zcashIdx;
      });
    },

    renameKeyRing: async (vaultId: string, newName: string) => {
      const vaults = ((await local.get('vaults')) ?? []) as EncryptedVault[];
      const updatedVaults = vaults.map(v => v.id === vaultId ? { ...v, name: newName } : v);
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
      const updatedVaults = vaults.filter(v => v.id !== vaultId);
      await local.set('vaults', updatedVaults);

      const { removedZcashIds } = await removeLinkedWallets(vaultId, local);
      await cleanupZcashData(vaultId, removedZcashIds);

      // last vault — nuke everything
      if (updatedVaults.length === 0) {
        await nukeAllWalletData(session, local);
        set(state => {
          state.keyRing.keyInfos = [];
          state.keyRing.selectedKeyInfo = undefined;
          state.keyRing.status = 'empty';
          state.wallets.all = [];
          state.wallets.activeIndex = 0;
          state.wallets.zcashWallets = [];
          state.wallets.activeZcashIndex = 0;
        });
        return;
      }

      // re-select if needed
      const currentSelectedId = await local.get('selectedVaultId');
      const selectedId = selectionAfterDelete(updatedVaults, vaultId, currentSelectedId as string);
      if (selectedId !== currentSelectedId) await local.set('selectedVaultId', selectedId);

      const keyInfos = vaultsToKeyInfos(updatedVaults, selectedId);
      const updatedWallets = (await local.get('wallets')) ?? [];
      set(state => {
        state.keyRing.keyInfos = keyInfos;
        state.keyRing.selectedKeyInfo = keyInfos.find(k => k.isSelected);
        state.wallets.all = updatedWallets.map(
          (w: { vaultId?: string }) => ({ ...w, vaultId: w.vaultId ?? '' }),
        ) as typeof state.wallets.all;
        if (state.wallets.activeIndex >= updatedWallets.length) {
          state.wallets.activeIndex = Math.max(0, updatedWallets.length - 1);
        }
      });
    },

    // ── secrets ──

    getMnemonic: async (vaultId: string) => {
      const vaults = ((await local.get('vaults')) ?? []) as EncryptedVault[];
      const vault = vaults.find(v => v.id === vaultId);
      if (!vault) throw new Error('vault not found');
      if (vault.type !== 'mnemonic') throw new Error('not a mnemonic vault');
      return decryptVault(ctx, vault);
    },

    getMultisigSecrets: async (vaultId: string) => {
      const vaults = ((await local.get('vaults')) ?? []) as EncryptedVault[];
      const vault = vaults.find(v => v.id === vaultId);

      if (vault?.type === 'frost-multisig') {
        const decrypted = await decryptVault(ctx, vault);
        try {
          const parsed = JSON.parse(decrypted);
          return { keyPackage: parsed.keyPackage as string, ephemeralSeed: parsed.ephemeralSeed as string };
        } catch {
          return null;
        }
      }

      // fallback: legacy zcash wallet records
      const zcashWallets = ((await local.get('zcashWallets')) ?? []) as ZcashWalletJson[];
      const wallet = zcashWallets.find(w => w.vaultId === vaultId);
      if (!wallet?.multisig) return null;
      return decryptMultisigSecrets(ctx, wallet.multisig.keyPackage, wallet.multisig.ephemeralSeed);
    },

    deriveKey: async (vaultId: string, network: NetworkType, accountIndex = 0) => {
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

    // ── network management ──

    toggleNetwork: async (network: NetworkType) => {
      const { enabledNetworks, activeNetwork } = get().keyRing;
      const disabling = enabledNetworks.includes(network);
      const newNetworks = disabling
        ? enabledNetworks.filter(n => n !== network)
        : [...enabledNetworks, network];

      await local.set('enabledNetworks', newNetworks);
      set(state => { state.keyRing.enabledNetworks = newNetworks; });

      if (disabling && activeNetwork === network && newNetworks.length > 0) {
        await get().keyRing.setActiveNetwork(newNetworks[0]!);
      }
    },

    setActiveNetwork: async (network: NetworkType) => {
      await local.set('activeNetwork', network);

      const { keyInfos, selectedKeyInfo } = get().keyRing;
      const currentSupports = selectedKeyInfo
        ? keyInfoSupportsNetwork(selectedKeyInfo, network)
        : false;

      if (!currentSupports) {
        const compatible = findCompatibleVault(keyInfos, network);
        if (compatible) {
          await local.set('selectedVaultId', compatible.id);

          if (network === 'penumbra') {
            const wallets = await local.get('wallets');
            const idx = findWalletIndex(wallets as { vaultId?: string }[], compatible.id);
            if (idx >= 0) await local.set('activeWalletIndex', idx);
          }

          set(state => {
            state.keyRing.activeNetwork = network;
            state.keyRing.keyInfos = state.keyRing.keyInfos.map(k => ({
              ...k, isSelected: k.id === compatible.id,
            }));
            state.keyRing.selectedKeyInfo = state.keyRing.keyInfos.find(k => k.isSelected);
          });
          return;
        }
      }

      set(state => { state.keyRing.activeNetwork = network; });
    },
  };
};

// ── selectors ──

export const keyRingSelector = (state: AllSlices) => state.keyRing;

export const selectActiveNetwork = (state: AllSlices) => state.keyRing.activeNetwork;
export const selectEnabledNetworks = (state: AllSlices) => state.keyRing.enabledNetworks;
export const selectSetActiveNetwork = (state: AllSlices) => state.keyRing.setActiveNetwork;
export const selectSelectedKeyInfo = (state: AllSlices) => state.keyRing.selectedKeyInfo;
export const selectKeyInfos = (state: AllSlices) => state.keyRing.keyInfos;
export const selectStatus = (state: AllSlices) => state.keyRing.status;
export const selectLock = (state: AllSlices) => state.keyRing.lock;
export const selectUnlock = (state: AllSlices) => state.keyRing.unlock;
export const selectSelectKeyRing = (state: AllSlices) => state.keyRing.selectKeyRing;
export const selectPenumbraAccount = (state: AllSlices) => state.keyRing.penumbraAccount;
export const selectSetPenumbraAccount = (state: AllSlices) => state.keyRing.setPenumbraAccount;
export const selectGetMnemonic = (state: AllSlices) => state.keyRing.getMnemonic;
export const selectDeriveKey = (state: AllSlices) => state.keyRing.deriveKey;
export const selectToggleNetwork = (state: AllSlices) => state.keyRing.toggleNetwork;
export const selectDeleteKeyRing = (state: AllSlices) => state.keyRing.deleteKeyRing;
export const selectRenameKeyRing = (state: AllSlices) => state.keyRing.renameKeyRing;

export const selectKeyInfosForActiveNetwork = (state: AllSlices) => {
  const { keyInfos, activeNetwork } = state.keyRing;
  return keyInfos.filter(k => keyInfoSupportsNetwork(k, activeNetwork));
};

export const selectEffectiveKeyInfo = (state: AllSlices) => {
  const { keyInfos, selectedKeyInfo, activeNetwork } = state.keyRing;
  if (selectedKeyInfo && keyInfoSupportsNetwork(selectedKeyInfo, activeNetwork)) {
    return selectedKeyInfo;
  }
  return keyInfos.find(k => keyInfoSupportsNetwork(k, activeNetwork));
};
