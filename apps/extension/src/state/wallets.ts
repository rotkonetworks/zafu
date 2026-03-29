import { Key } from '@repo/encryption/key';
import { Box, type BoxJson } from '@repo/encryption/box';
import { Wallet, type WalletJson } from '@repo/wallet';
// Dynamic import to avoid bundling WASM into initial chunks
// import { generateSpendKey, getFullViewingKey, getWalletId } from '@rotko/penumbra-wasm/keys';
import type { ExtensionStorage } from '@repo/storage-chrome/base';
import type { LocalStorageState } from '@repo/storage-chrome/local';
import type { SessionStorageState } from '@repo/storage-chrome/session';
import { AllSlices, SliceCreator } from '.';

/** Zcash wallet stored in extension */
export interface ZcashWalletJson {
  id: string;
  label: string;
  orchardFvk: string;
  address: string;
  accountIndex: number;
  mainnet: boolean;
  ufvk?: string;
  /** vault ID this wallet belongs to */
  vaultId: string;
  /** FROST multisig fields — present only for multisig wallets */
  multisig?: {
    /** FROST key package — encrypted BoxJson when password is set, raw hex string otherwise */
    keyPackage: BoxJson | string;
    /** hex-encoded FROST public key package (shared, non-sensitive) */
    publicKeyPackage: string;
    /** ephemeral seed — encrypted BoxJson when password is set, raw hex string otherwise */
    ephemeralSeed: BoxJson | string;
    /** signing threshold */
    threshold: number;
    /** total signers */
    maxSigners: number;
    /** relay server URL used for signing sessions */
    relayUrl: string;
  };
}

export interface WalletsSlice {
  /** Penumbra wallets - can be encryptedSeedPhrase or airgapSigner (watch-only) */
  all: WalletJson<'encryptedSeedPhrase' | 'airgapSigner'>[];
  /** Zcash wallets - watch-only orchard FVK wallets */
  zcashWallets: ZcashWalletJson[];
  /** Index of the currently active Penumbra wallet */
  activeIndex: number;
  /** Index of the currently active Zcash wallet */
  activeZcashIndex: number;
  addWallet: (toAdd: { label: string; seedPhrase: string[] }) => Promise<void>;
  /** Update a multisig wallet's mutable fields (label, relayUrl) */
  updateMultisigWallet: (id: string, updates: { label?: string; relayUrl?: string }) => Promise<void>;
  /** Remove a wallet by index. Cannot remove the last remaining wallet. */
  removeWallet: (index: number) => Promise<void>;
  /** Remove a Zcash wallet by index */
  removeZcashWallet: (index: number) => Promise<void>;
  /** Switch to a different wallet by index */
  setActiveWallet: (index: number) => Promise<void>;
  /** Switch to a different Zcash wallet by index */
  setActiveZcashWallet: (index: number) => Promise<void>;
  getSeedPhrase: () => Promise<string[]>;
}

export const createWalletsSlice =
  (
    session: ExtensionStorage<SessionStorageState>,
    local: ExtensionStorage<LocalStorageState>,
  ): SliceCreator<WalletsSlice> =>
  (set, get) => {
    return {
      all: [],
      zcashWallets: [],
      activeIndex: 0,
      activeZcashIndex: 0,
      addWallet: async ({ label, seedPhrase }) => {
        // Dynamic import to avoid bundling WASM into initial chunks (service worker)
        const { generateSpendKey, getFullViewingKey, getWalletId } = await import(
          '@rotko/penumbra-wasm/keys'
        );

        const seedPhraseStr = seedPhrase.join(' ');
        const spendKey = await generateSpendKey(seedPhraseStr);
        const fullViewingKey = await getFullViewingKey(spendKey);

        const passwordKey = await session.get('passwordKey');
        if (passwordKey === undefined) {
          throw new Error('Password Key not in storage');
        }

        const key = await Key.fromJson(passwordKey);
        const walletId = await getWalletId(fullViewingKey);
        const newWallet = new Wallet(label, walletId, fullViewingKey, {
          encryptedSeedPhrase: await key.seal(seedPhraseStr),
        });

        set(state => {
          if (!Array.isArray(state.wallets.all)) state.wallets.all = [];
          state.wallets.all.unshift(newWallet.toJson());
        });

        const wallets = (await local.get('penumbraWallets')) ?? [];
        await local.set('penumbraWallets', [newWallet.toJson(), ...(Array.isArray(wallets) ? wallets : [])]);
      },

      updateMultisigWallet: async (id, updates) => {
        const { zcashWallets } = get().wallets;
        const idx = zcashWallets.findIndex(w => w.id === id);
        if (idx === -1 || !zcashWallets[idx]!.multisig) {
          throw new Error('multisig wallet not found');
        }

        set(state => {
          const w = state.wallets.zcashWallets[idx]!;
          if (updates.label !== undefined) w.label = updates.label;
          if (updates.relayUrl !== undefined && w.multisig) w.multisig.relayUrl = updates.relayUrl;
        });

        await local.set('zcashWallets', get().wallets.zcashWallets);
      },

      removeZcashWallet: async (index: number) => {
        const { zcashWallets, activeZcashIndex } = get().wallets;

        if (index < 0 || index >= zcashWallets.length) {
          throw new Error(`invalid zcash wallet index: ${index}`);
        }

        const newWallets = zcashWallets.filter((_, i) => i !== index);

        let newActiveIndex = activeZcashIndex;
        if (index < activeZcashIndex) {
          newActiveIndex = activeZcashIndex - 1;
        } else if (index === activeZcashIndex) {
          newActiveIndex = Math.max(0, activeZcashIndex - 1);
        }

        set(state => {
          state.wallets.zcashWallets = newWallets;
          state.wallets.activeZcashIndex = newActiveIndex;
        });

        await local.set('zcashWallets', newWallets);
      },

      setActiveZcashWallet: async (index: number) => {
        const { zcashWallets } = get().wallets;
        if (index < 0 || index >= zcashWallets.length) {
          throw new Error(`invalid zcash wallet index: ${index}`);
        }

        set(state => {
          state.wallets.activeZcashIndex = index;
        });

        await local.set('activeZcashIndex', index);
      },

      removeWallet: async (index: number) => {
        const { all, activeIndex } = get().wallets;

        if (all.length <= 1) {
          throw new Error('Cannot remove the last wallet');
        }

        if (index < 0 || index >= all.length) {
          throw new Error(`Invalid wallet index: ${index}`);
        }

        // Remove wallet from state
        const newWallets = all.filter((_, i) => i !== index);

        // Adjust active index if needed
        let newActiveIndex = activeIndex;
        if (index < activeIndex) {
          // Removed wallet was before active, shift index down
          newActiveIndex = activeIndex - 1;
        } else if (index === activeIndex) {
          // Removed the active wallet, select previous or first
          newActiveIndex = Math.max(0, activeIndex - 1);
        }

        set(state => {
          state.wallets.all = newWallets;
          state.wallets.activeIndex = newActiveIndex;
        });

        // Persist to storage
        await Promise.all([
          local.set('penumbraWallets', newWallets),
          local.set('activeWalletIndex', newActiveIndex),
        ]);
      },

      setActiveWallet: async (index: number) => {
        const { all } = get().wallets;
        if (index < 0 || index >= all.length) {
          throw new Error(`Invalid wallet index: ${index}`);
        }

        set(state => {
          state.wallets.activeIndex = index;
        });

        await local.set('activeWalletIndex', index);
      },

      /** @deprecated */
      getSeedPhrase: async () => {
        const passwordKey = await session.get('passwordKey');
        if (!passwordKey) {
          throw new Error('no password set');
        }

        const key = await Key.fromJson(passwordKey);
        const activeWallet = getActiveWallet(get());
        if (!activeWallet) {
          throw new Error('no wallet set');
        }

        const custody = activeWallet.toJson().custody;
        if (!('encryptedSeedPhrase' in custody)) {
          throw new Error('Active wallet is not a seed phrase wallet');
        }

        const phraseBox = Box.fromJson(custody.encryptedSeedPhrase);

        const phrase = await key.unseal(phraseBox);
        if (!phrase) {
          throw new Error('Unable to decrypt seed phrase with password');
        }

        return phrase.split(' ');
      },
    };
  };

/** coarse selector - use sparingly */
export const walletsSelector = (state: AllSlices) => state.wallets;

/**
 * fine-grained atomic selectors - solidjs style
 */
export const selectZcashWallets = (state: AllSlices) => Array.isArray(state.wallets.zcashWallets) ? state.wallets.zcashWallets : [];
export const selectActiveZcashIndex = (state: AllSlices) => state.wallets.activeZcashIndex;
export const selectActiveZcashWallet = (state: AllSlices) => {
  const { zcashWallets, activeZcashIndex } = state.wallets;
  return zcashWallets[activeZcashIndex];
};
export const selectPenumbraWallets = (state: AllSlices) => Array.isArray(state.wallets.all) ? state.wallets.all : [];
export const selectActivePenumbraIndex = (state: AllSlices) => state.wallets.activeIndex;

export const getActiveWallet = (state: AllSlices) => {
  const { all, activeIndex } = state.wallets;
  const walletJson = all[activeIndex];
  return walletJson ? Wallet.fromJson(walletJson) : undefined;
};
export const getActiveWalletJson = (state: AllSlices) => {
  const { all, activeIndex } = state.wallets;
  return all[activeIndex];
};
