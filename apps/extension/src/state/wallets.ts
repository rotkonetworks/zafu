import { Key } from '@repo/encryption/key';
import { Box } from '@repo/encryption/box';
import { Wallet, type WalletJson } from '@repo/wallet';
// Dynamic import to avoid bundling WASM into initial chunks
// import { generateSpendKey, getFullViewingKey, getWalletId } from '@penumbra-zone/wasm/keys';
import type { ExtensionStorage } from '@repo/storage-chrome/base';
import type { LocalStorageState } from '@repo/storage-chrome/local';
import type { SessionStorageState } from '@repo/storage-chrome/session';
import { AllSlices, SliceCreator } from '.';
import type { ZignerWalletImport } from '@repo/wallet/zigner-signer';
import type { ZcashWalletImport } from '@repo/wallet/zcash-zigner';

/** Zcash wallet stored in extension */
export interface ZcashWalletJson {
  id: string;
  label: string;
  orchardFvk: string;
  address: string;
  accountIndex: number;
  mainnet: boolean;
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
  /** Add a watch-only wallet from airgap signer (e.g., Zigner) FVK export */
  addAirgapSignerWallet: (walletImport: ZignerWalletImport) => Promise<void>;
  /** Add a Zcash watch-only wallet from Zigner FVK export */
  addZcashWallet: (walletImport: ZcashWalletImport) => Promise<void>;
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
          '@penumbra-zone/wasm/keys'
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
          state.wallets.all.unshift(newWallet.toJson());
        });

        const wallets = await local.get('wallets');
        await local.set('wallets', [newWallet.toJson(), ...wallets]);
      },

      addAirgapSignerWallet: async (walletImport) => {
        // airgap signer metadata - encrypted with password key for consistency
        // the password is required to access custody() for any wallet type
        const metadata = JSON.stringify({
          accountIndex: walletImport.accountIndex,
          importedAt: Date.now(),
          signerType: 'zigner',
        });

        const passwordKey = await session.get('passwordKey');
        if (passwordKey === undefined) {
          throw new Error('password key not in storage');
        }

        const key = await Key.fromJson(passwordKey);
        const metadataBox = await key.seal(metadata);

        const newWallet = new Wallet(
          walletImport.label,
          walletImport.walletId,
          walletImport.fullViewingKey,
          {
            airgapSigner: metadataBox,
          },
        );

        set(state => {
          state.wallets.all.unshift(newWallet.toJson());
        });

        const wallets = await local.get('wallets');
        await local.set('wallets', [newWallet.toJson(), ...wallets]);
      },

      addZcashWallet: async (walletImport: ZcashWalletImport) => {
        const existingZcashWallets = (await local.get('zcashWallets')) ?? [];

        // generate unique ID with collision check (defense in depth)
        let id: string;
        let attempts = 0;
        do {
          id = crypto.randomUUID();
          attempts++;
          if (attempts > 10) {
            throw new Error('failed to generate unique wallet id');
          }
        } while (existingZcashWallets.some((w: ZcashWalletJson) => w.id === id));

        // convert FVK bytes to base64 for storage (more efficient than hex)
        const orchardFvkBase64 = walletImport.orchardFvk
          ? btoa(String.fromCharCode(...walletImport.orchardFvk))
          : '';

        // use address from QR if available
        const address = walletImport.address ?? '';

        const newZcashWallet: ZcashWalletJson = {
          id,
          label: walletImport.label,
          orchardFvk: orchardFvkBase64,
          address,
          accountIndex: walletImport.accountIndex,
          mainnet: walletImport.mainnet,
        };

        set(state => {
          state.wallets.zcashWallets.unshift(newZcashWallet);
        });

        await local.set('zcashWallets', [newZcashWallet, ...existingZcashWallets]);
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
          local.set('wallets', newWallets),
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
export const selectZcashWallets = (state: AllSlices) => state.wallets.zcashWallets;
export const selectActiveZcashIndex = (state: AllSlices) => state.wallets.activeZcashIndex;
export const selectActiveZcashWallet = (state: AllSlices) => {
  const { zcashWallets, activeZcashIndex } = state.wallets;
  return zcashWallets[activeZcashIndex];
};
export const selectPenumbraWallets = (state: AllSlices) => state.wallets.all;
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
