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

export interface WalletsSlice {
  /** Wallets can be encryptedSeedPhrase or airgapSigner (watch-only) */
  all: WalletJson<'encryptedSeedPhrase' | 'airgapSigner'>[];
  /** Index of the currently active wallet */
  activeIndex: number;
  addWallet: (toAdd: { label: string; seedPhrase: string[] }) => Promise<void>;
  /** Add a watch-only wallet from airgap signer (e.g., Zigner) FVK export */
  addAirgapSignerWallet: (walletImport: ZignerWalletImport) => Promise<void>;
  /** Remove a wallet by index. Cannot remove the last remaining wallet. */
  removeWallet: (index: number) => Promise<void>;
  /** Switch to a different wallet by index */
  setActiveWallet: (index: number) => Promise<void>;
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
      activeIndex: 0,
      addWallet: async ({ label, seedPhrase }) => {
        // Dynamic import to avoid bundling WASM into initial chunks (service worker)
        const { generateSpendKey, getFullViewingKey, getWalletId } = await import(
          '@penumbra-zone/wasm/keys'
        );

        const seedPhraseStr = seedPhrase.join(' ');
        const spendKey = generateSpendKey(seedPhraseStr);
        const fullViewingKey = getFullViewingKey(spendKey);

        const passwordKey = await session.get('passwordKey');
        if (passwordKey === undefined) {
          throw new Error('Password Key not in storage');
        }

        const key = await Key.fromJson(passwordKey);
        const newWallet = new Wallet(label, getWalletId(fullViewingKey), fullViewingKey, {
          encryptedSeedPhrase: await key.seal(seedPhraseStr),
        });

        set(state => {
          state.wallets.all.unshift(newWallet.toJson());
        });

        const wallets = await local.get('wallets');
        await local.set('wallets', [newWallet.toJson(), ...wallets]);
      },

      addAirgapSignerWallet: async (walletImport) => {
        // For airgap signer (watch-only) wallets, we store metadata in a Box.
        // No password needed - we just need consistent Box format.
        // Use a static key for non-sensitive metadata.
        const metadata = JSON.stringify({
          accountIndex: walletImport.accountIndex,
          importedAt: Date.now(),
          signerType: 'zigner',
        });

        // Create a deterministic box for non-sensitive airgap metadata
        // This just wraps the metadata in the expected Box format
        const metadataBox = Box.fromPlaintext(metadata);

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

export const walletsSelector = (state: AllSlices) => state.wallets;
export const getActiveWallet = (state: AllSlices) => {
  const { all, activeIndex } = state.wallets;
  const walletJson = all[activeIndex];
  return walletJson ? Wallet.fromJson(walletJson) : undefined;
};
export const getActiveWalletJson = (state: AllSlices) => {
  const { all, activeIndex } = state.wallets;
  return all[activeIndex];
};
