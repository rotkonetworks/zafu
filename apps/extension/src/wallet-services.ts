import { AppParameters } from '@penumbra-zone/protobuf/penumbra/core/app/v1/app_pb';
import { AppService } from '@penumbra-zone/protobuf';
import { createGrpcWebTransport } from '@connectrpc/connect-web';
import { createClient } from '@connectrpc/connect';
import { FullViewingKey, WalletId } from '@penumbra-zone/protobuf/penumbra/core/keys/v1/keys_pb';
import { localExtStorage } from '@repo/storage-chrome/local';
import { onboardGrpcEndpoint, onboardWallet } from '@repo/storage-chrome/onboard';
import { Services } from '@repo/context';
import { WalletServices } from '@rotko/penumbra-types/services';
import { AssetId } from '@penumbra-zone/protobuf/penumbra/core/asset/v1/asset_pb';
import { SENTINEL_U64_MAX } from './utils/sentinel';

/**
 * check if penumbra network is enabled
 * privacy-first: don't make network connections unless user has opted in
 */
export const isPenumbraEnabled = async (): Promise<boolean> => {
  const enabledNetworks = await localExtStorage.get('enabledNetworks');
  // if no networks configured yet, check if we have wallets (backwards compat)
  if (!enabledNetworks) {
    const wallets = await localExtStorage.get('wallets');
    return wallets && wallets.length > 0;
  }
  return enabledNetworks.includes('penumbra');
};

export const startWalletServices = async () => {
  // privacy gate: check if penumbra is enabled before making network connections
  const enabled = await isPenumbraEnabled();
  if (!enabled) {
    console.log('[sync] penumbra not enabled, skipping wallet services initialization');
    // return a stub services object that throws on access
    return {
      getWalletServices: () => Promise.reject(new Error('penumbra network not enabled')),
    } as Services;
  }

  console.log('[sync] starting wallet services...');

  const wallet = await onboardWallet();
  console.log('[sync] wallet loaded:', wallet.id.slice(0, 20) + '...');

  const grpcEndpoint = await onboardGrpcEndpoint();
  console.log('[sync] grpc endpoint:', grpcEndpoint);

  const numeraires = await localExtStorage.get('numeraires');
  console.log('[sync] getting chainId from endpoint...');
  const chainId = await getChainId(grpcEndpoint);
  console.log('[sync] chainId:', chainId);

  const walletCreationBlockHeight = await localExtStorage.get('walletCreationBlockHeight');
  const compactFrontierBlockHeight = await localExtStorage.get('compactFrontierBlockHeight');
  console.log('[sync] walletCreationBlockHeight:', walletCreationBlockHeight);
  console.log('[sync] compactFrontierBlockHeight:', compactFrontierBlockHeight);

  console.log('[sync] creating Services instance...');
  const services = new Services({
    grpcEndpoint,
    chainId,
    walletId: WalletId.fromJsonString(wallet.id),
    fullViewingKey: FullViewingKey.fromJsonString(wallet.fullViewingKey),
    numeraires: numeraires.map(n => AssetId.fromJsonString(n)),
    walletCreationBlockHeight,
    compactFrontierBlockHeight,
  });

  console.log('[sync] getting wallet services (this starts syncing)...');
  const walletServices = await services.getWalletServices();
  console.log('[sync] wallet services ready, starting block sync subscription...');

  void syncLastBlockToStorage(walletServices);

  return services;
};

/**
 * Get chainId from the rpc endpoint, or fall back to chainId from storage.
 *
 * It's possible that the remote endpoint may suddenly serve a new chainId.
 * @see https://github.com/prax-wallet/prax/pull/65
 */
const getChainId = async (baseUrl: string) => {
  const serviceClient = createClient(AppService, createGrpcWebTransport({ baseUrl }));
  const params =
    (await serviceClient.appParameters({}).then(
      ({ appParameters }) => appParameters,
      () => undefined,
    )) ??
    (await localExtStorage
      .get('params')
      .then(jsonParams => (jsonParams ? AppParameters.fromJsonString(jsonParams) : undefined)));

  if (params?.chainId) {
    void localExtStorage.set('params', params.toJsonString());
  } else {
    throw new Error('No chainId available');
  }

  return params.chainId;
};

/**
 * Sync the last block known by indexedDb with `chrome.storage.local`

 * Later used in Zustand store
 */
const syncLastBlockToStorage = async ({ indexedDb }: Pick<WalletServices, 'indexedDb'>) => {
  const dbHeight = await indexedDb.getFullSyncHeight();

  if (dbHeight != null && dbHeight !== SENTINEL_U64_MAX) {
    await localExtStorage.set('fullSyncHeight', Number(dbHeight));
  }

  const sub = indexedDb.subscribe('FULL_SYNC_HEIGHT');
  for await (const { value } of sub) {
    if (value !== SENTINEL_U64_MAX) {
      await localExtStorage.set('fullSyncHeight', Number(value));
    }
  }
};
