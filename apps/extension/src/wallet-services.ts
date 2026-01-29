import { AppParameters } from '@penumbra-zone/protobuf/penumbra/core/app/v1/app_pb';
import { AppService } from '@penumbra-zone/protobuf';
import { createGrpcWebTransport } from '@connectrpc/connect-web';
import { createClient } from '@connectrpc/connect';
import { FullViewingKey, WalletId } from '@penumbra-zone/protobuf/penumbra/core/keys/v1/keys_pb';
import { localExtStorage } from '@repo/storage-chrome/local';
import { getWalletFromStorage } from '@repo/storage-chrome/onboard';
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

// Default Penumbra gRPC endpoint
const DEFAULT_PENUMBRA_ENDPOINT = 'https://penumbra.rotko.net';

/**
 * Get the Penumbra gRPC endpoint from storage or use default
 */
const getPenumbraEndpoint = async (): Promise<string> => {
  // First try the new networkEndpoints object (from Network Endpoints UI)
  const networkEndpoints = await localExtStorage.get('networkEndpoints');
  if (networkEndpoints?.penumbra) {
    return networkEndpoints.penumbra;
  }

  // Then try the legacy grpcEndpoint field (for backwards compat)
  const legacyEndpoint = await localExtStorage.get('grpcEndpoint');
  if (legacyEndpoint) {
    return legacyEndpoint;
  }

  // Fall back to default
  return DEFAULT_PENUMBRA_ENDPOINT;
};

export const startWalletServices = async () => {
  // privacy gate: check if penumbra is enabled before making network connections
  const enabled = await isPenumbraEnabled();
  console.log('[sync] isPenumbraEnabled:', enabled);
  if (!enabled) {
    console.log('[sync] penumbra not enabled, skipping wallet services initialization');
    // return a stub services object that throws on access
    return {
      getWalletServices: () => Promise.reject(new Error('penumbra network not enabled')),
    } as Services;
  }

  console.log('[sync] starting wallet services...');

  // Non-blocking wallet check (unlike onboardWallet which waits forever)
  const wallet = await getWalletFromStorage();
  if (!wallet) {
    console.log('[sync] no penumbra wallet found in storage, sync will start when wallet is created');
    // Return stub - sync will be triggered when wallet is created via keyring
    return {
      getWalletServices: () => Promise.reject(new Error('no penumbra wallet configured')),
    } as Services;
  }
  console.log('[sync] wallet loaded:', wallet.id.slice(0, 20) + '...');

  const grpcEndpoint = await getPenumbraEndpoint();
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
  console.log('[sync] initial dbHeight from indexedDb:', dbHeight);

  if (dbHeight != null && dbHeight !== SENTINEL_U64_MAX) {
    await localExtStorage.set('fullSyncHeight', Number(dbHeight));
    console.log('[sync] saved initial fullSyncHeight:', Number(dbHeight));
  }

  console.log('[sync] subscribing to FULL_SYNC_HEIGHT updates...');
  const sub = indexedDb.subscribe('FULL_SYNC_HEIGHT');
  for await (const { value } of sub) {
    if (value !== SENTINEL_U64_MAX) {
      await localExtStorage.set('fullSyncHeight', Number(value));
      console.log('[sync] fullSyncHeight updated:', Number(value));
    }
  }
};
