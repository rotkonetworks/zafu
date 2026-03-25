import type { WalletJson } from '@repo/wallet';
import type { ChromeStorageListener } from './listener';
import { localExtStorage, type LocalStorageState } from './local';
import { sessionExtStorage } from './session';
import { Key } from '@repo/encryption/key';
import { Box, type BoxJson } from '@repo/encryption/box';

/**
 * When a user first onboards with the extension, they won't have chosen a gRPC
 * endpoint yet. So we'll wait until they've chosen one to start trying to make
 * requests against it.
 */
export const onboardGrpcEndpoint = async (): Promise<string> => {
  const grpcEndpoint = await localExtStorage.get('grpcEndpoint');
  if (grpcEndpoint) {
    return grpcEndpoint;
  }

  return new Promise(resolve => {
    const storageListener: ChromeStorageListener<LocalStorageState> = ({ grpcEndpoint }) => {
      const rpcEndpoint = grpcEndpoint?.newValue;
      if (rpcEndpoint) {
        resolve(rpcEndpoint);
        localExtStorage.removeListener(storageListener);
      }
    };
    localExtStorage.addListener(storageListener);
  });
};

/** decrypt wallets from encrypted storage */
const decryptWallets = async (raw: unknown): Promise<WalletJson[]> => {
  if (!raw) return [];
  if (typeof raw !== 'object' || !('encrypted' in (raw as Record<string, unknown>))) return [];
  const keyJson = await sessionExtStorage.get('passwordKey');
  if (!keyJson) return []; // locked — no session key
  try {
    const key = await Key.fromJson(keyJson);
    const plaintext = await key.unseal(Box.fromJson((raw as { encrypted: BoxJson }).encrypted));
    if (!plaintext) {
      console.error('[storage] decryptWallets: unseal returned null — blob may be corrupt');
      return [];
    }
    return JSON.parse(plaintext) as WalletJson[];
  } catch (e) {
    console.error('[storage] decryptWallets failed:', e);
    return [];
  }
};

export const onboardWallet = async (): Promise<WalletJson> => {
  const rawWallets = await localExtStorage.get('penumbraWallets');
  const wallets = await decryptWallets(rawWallets);
  const activeIndex = (await localExtStorage.get('activeWalletIndex')) ?? 0;
  const activeWallet = wallets[activeIndex] ?? wallets[0];

  if (activeWallet) {
    return activeWallet;
  }

  return new Promise(resolve => {
    const storageListener: ChromeStorageListener<LocalStorageState> = async changes => {
      if (!changes.penumbraWallets?.newValue) return;
      // wallets may be encrypted — decrypt before reading
      const wallets = await decryptWallets(changes.penumbraWallets.newValue);
      const initialWallet = wallets[0];
      if (initialWallet) {
        resolve({ ...initialWallet, vaultId: initialWallet.vaultId ?? '' } as WalletJson);
        localExtStorage.removeListener(storageListener);
      }
    };
    localExtStorage.addListener(storageListener);
  });
};

/**
 * Get wallet from storage without blocking.
 * Unlike onboardWallet which waits forever, this returns undefined if no wallet exists.
 * Use this for multi-network wallets where penumbra wallet may not exist yet.
 */
export const getWalletFromStorage = async (): Promise<WalletJson | undefined> => {
  const rawWallets = await localExtStorage.get('penumbraWallets');
  const wallets = await decryptWallets(rawWallets);
  const activeIndex = (await localExtStorage.get('activeWalletIndex')) ?? 0;
  const w = wallets[activeIndex] ?? wallets[0];
  return w ?? undefined;
};
