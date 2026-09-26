import { AppParameters } from '@penumbra-zone/protobuf/penumbra/core/app/v1/app_pb';
import { AppService } from '@penumbra-zone/protobuf';
import { createGrpcWebTransport } from '@connectrpc/connect-web';
import { createClient } from '@connectrpc/connect';
import { FullViewingKey, WalletId } from '@penumbra-zone/protobuf/penumbra/core/keys/v1/keys_pb';
import { localExtStorage } from '@repo/storage-chrome/local';
import { getWalletFromStorage } from '@repo/storage-chrome/onboard';
import type { WalletJson } from '@repo/wallet';
import { Services } from '@repo/context';
import { WalletServices } from '@rotko/penumbra-types/services';
import { getRootNetwork } from './config/networks';
import { resolvePenumbraEndpoint } from './config/penumbra-endpoints';
import type { NetworkType } from './state/keyring';
import { hasLiveDappSession } from './dapp-session-presence';
import { AssetId } from '@penumbra-zone/protobuf/penumbra/core/asset/v1/asset_pb';
import { SENTINEL_U64_MAX } from './utils/sentinel';

/**
 * check if penumbra network is enabled
 * privacy-first: don't make network connections unless user has opted in
 */
export const isPenumbraEnabled = async (): Promise<boolean> => {
  const enabledNetworks = await localExtStorage.get('enabledNetworks');
  // if no networks configured yet, check vaults (wallets are encrypted at rest)
  if (!enabledNetworks) {
    const vaults = await localExtStorage.get('vaults');
    return !!vaults && vaults.length > 0;
  }
  return enabledNetworks.includes('penumbra');
};

/**
 * Whether penumbra services should run right now. The single source of truth
 * for both startWalletServices (build real vs stub services) and the service
 * worker's decision to rebuild them - if the two disagreed, the worker would
 * rebuild for nothing, or keep stale services around.
 *
 * - privacy gate: the network must be enabled.
 * - active-scoped gate: only while the extension UI is on the penumbra group
 *   (a cosmos subnetwork like Noble roots to penumbra; unset = pre-selection),
 *   so no gRPC stream stays open to a network the user switched away from...
 * - ...unless a penumbra dapp (e.g. Veil) is connected: its session needs
 *   penumbra services regardless of which network the UI is viewing.
 */
export const penumbraGate = async (): Promise<{ run: true } | { run: false; reason: string }> => {
  if (!(await isPenumbraEnabled())) {
    return { run: false, reason: 'penumbra network not enabled' };
  }
  const activeNetwork = await localExtStorage.get('activeNetwork');
  if (
    activeNetwork &&
    getRootNetwork(activeNetwork as NetworkType) !== 'penumbra' &&
    !hasLiveDappSession()
  ) {
    return { run: false, reason: 'penumbra network not active' };
  }
  return { run: true };
};

export const startWalletServices = async (
  signal?: AbortSignal,
): Promise<{ services: Services; wallet: WalletJson; reason?: string }> => {
  // Stub services object that throws on access - returned whenever penumbra
  // must not sync.
  const stubServices = (reason: string) => ({
    services: {
      getWalletServices: () => Promise.reject(new Error(reason)),
    } as Services,
    wallet: undefined as unknown as WalletJson,
    reason,
  });

  // privacy + active-scoped gates (see penumbraGate). A stub is expected
  // whenever the user is on zcash with no penumbra dapp connected - not an
  // error, so stay silent.
  const gate = await penumbraGate();
  if (!gate.run) {
    return stubServices(gate.reason);
  }

  console.log('[sync] starting wallet services...');

  // Try to load wallet — may be encrypted and locked.
  // If locked, wait for unlock (session key appears in storage).
  let wallet = await getWalletFromStorage();
  if (!wallet) {
    console.log('[sync] wallet locked or missing, waiting for unlock...');
    wallet = await new Promise<WalletJson>(resolve => {
      // listen for session key (unlock) or wallet creation
      const sessionListener = () => void check();
      const check = async () => {
        const w = await getWalletFromStorage();
        if (w) {
          localExtStorage.removeListener(listener);
          chrome.storage.session.onChanged.removeListener(sessionListener);
          resolve(w);
        }
      };
      const listener = (changes: Record<string, unknown>) => {
        // wallet writes (encrypted blob) or vault creation
        if ('penumbraWallets' in changes || 'vaults' in changes) {
          void check();
        }
      };
      localExtStorage.addListener(listener as never);
      // also check when session key appears (user unlocked)
      chrome.storage.session.onChanged.addListener(sessionListener);
    });
  }
  console.log('[sync] wallet loaded:', wallet.id.slice(0, 20) + '...');

  const grpcEndpoint = await resolvePenumbraEndpoint();
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

  void syncLastBlockToStorage(walletServices, signal);

  return { services, wallet };
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
 *
 * Later used in Zustand store. Returns an abort function to stop the subscription.
 */
const syncLastBlockToStorage = async (
  { indexedDb }: Pick<WalletServices, 'indexedDb'>,
  signal?: AbortSignal,
) => {
  const dbHeight = await indexedDb.getFullSyncHeight();
  console.log('[sync] initial dbHeight from indexedDb:', dbHeight);

  if (dbHeight != null && dbHeight !== SENTINEL_U64_MAX) {
    await localExtStorage.set('fullSyncHeight', Number(dbHeight));
    console.log('[sync] saved initial fullSyncHeight:', Number(dbHeight));
  }

  console.log('[sync] subscribing to FULL_SYNC_HEIGHT updates...');
  const sub = indexedDb.subscribe('FULL_SYNC_HEIGHT');
  for await (const { value } of sub) {
    if (signal?.aborted) {
      break;
    }
    if (value !== SENTINEL_U64_MAX) {
      await localExtStorage.set('fullSyncHeight', Number(value));
      console.log('[sync] fullSyncHeight updated:', Number(value));
    }
  }
};
