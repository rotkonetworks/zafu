import type { WalletJson } from '@repo/wallet';
import type { ChromeStorageListener } from './listener';
import { localExtStorage, type LocalStorageState } from './local';

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

/** coerce storage wallet (vaultId optional) to runtime WalletJson (vaultId required) */
const coerceWallet = (w: { vaultId?: string } & Record<string, unknown>): WalletJson =>
  ({ ...w, vaultId: w.vaultId ?? '' }) as unknown as WalletJson;

export const onboardWallet = async (): Promise<WalletJson> => {
  const wallets = await localExtStorage.get('wallets');
  const activeIndex = (await localExtStorage.get('activeWalletIndex')) ?? 0;
  const activeWallet = wallets[activeIndex] ?? wallets[0];

  if (activeWallet) {
    return coerceWallet(activeWallet);
  }

  return new Promise(resolve => {
    const storageListener: ChromeStorageListener<LocalStorageState> = changes => {
      const wallets = changes.wallets?.newValue;
      const initialWallet = wallets?.[0];
      if (initialWallet) {
        resolve(coerceWallet(initialWallet));
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
  const wallets = await localExtStorage.get('wallets');
  const activeIndex = (await localExtStorage.get('activeWalletIndex')) ?? 0;
  const w = wallets[activeIndex] ?? wallets[0];
  return w ? coerceWallet(w) : undefined;
};
