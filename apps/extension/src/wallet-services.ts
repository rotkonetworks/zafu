import { AppParameters } from '@penumbra-zone/protobuf/penumbra/core/app/v1/app_pb';
import { AppService, TendermintProxyService } from '@penumbra-zone/protobuf';
import { createGrpcWebTransport } from '@connectrpc/connect-web';
import { createClient } from '@connectrpc/connect';
import { backOff } from 'exponential-backoff';
import { FullViewingKey, WalletId } from '@penumbra-zone/protobuf/penumbra/core/keys/v1/keys_pb';
import { localExtStorage } from '@repo/storage-chrome/local';
import { getWalletFromStorage, getWalletsFromStorage } from '@repo/storage-chrome/onboard';
import type { WalletJson } from '@repo/wallet';
import { Services } from '@repo/context';
import { WalletServices } from '@rotko/penumbra-types/services';
import { getRootNetwork } from './config/networks';
import { resolvePenumbraEndpoint } from './config/penumbra-endpoints';
import type { NetworkType } from './state/keyring';
import { hasLiveDappSession } from './dapp-session-presence';
import { AssetId } from '@penumbra-zone/protobuf/penumbra/core/asset/v1/asset_pb';
import { ChainRegistryClient } from '@penumbrafi/registry';
import { SENTINEL_U64_MAX } from './utils/sentinel';
import { base64ToUint8Array } from '@rotko/penumbra-types/base64';
import { USDC_INJ_ID } from './penumbra/quotes';
import {
  adoptLegacyStart,
  isResolved,
  resolveStart,
  startsOf,
  type PenumbraStart,
  type ResolvedStart,
} from './penumbra/start';

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

  // Try to load wallet - may be encrypted and locked.
  // If locked, wait for unlock (session key appears in storage).
  let wallet = await getWalletFromStorage();
  if (!wallet) {
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

  await adoptLegacy();
  const asked = startsOf(await localExtStorage.get('penumbraStarts'))?.[wallet.id];
  if (!asked) {
    // nothing is read (or asked of the node) until the home asks once where
    // this wallet starts; its addresses still work from the viewing key
    if (!signal?.aborted) {
      await localExtStorage.set('penumbraSync', { walletId: wallet.id, ask: true });
    }
    return { ...stubServices(PENUMBRA_START_NEEDED), wallet };
  }

  const grpcEndpoint = await resolvePenumbraEndpoint();
  const chainId = await getChainId(grpcEndpoint);
  const numeraires = await numerairesFor(chainId);
  const start = isResolved(asked) ? asked : await resolveAt(wallet.id, asked, grpcEndpoint, signal);
  console.log(`[sync] starting from ${grpcEndpoint}, decrypting from ${start.creation}`);

  const services = new Services({
    grpcEndpoint,
    chainId,
    walletId: WalletId.fromJsonString(wallet.id),
    fullViewingKey: FullViewingKey.fromJsonString(wallet.fullViewingKey),
    numeraires: numeraires.map(n => AssetId.fromJsonString(n)),
    walletCreationBlockHeight: start.creation,
    compactFrontierBlockHeight: start.frontier,
  });

  const walletServices = await services.getWalletServices();
  if (start.frontier !== undefined) {
    // the snapshot is taken; were this database ever lost, a second one at a
    // later tip would hide what arrived in between, so the chain is read instead
    await setStart(wallet.id, { creation: start.creation });
  }
  void publishSyncHeight(wallet.id, walletServices, signal);

  return { services, wallet };
};

/** why the services are a stub while the wallet's start is not chosen */
export const PENUMBRA_START_NEEDED = 'penumbra start not chosen yet';

/**
 * A start the ui asked for (the tip, a date), resolved against the node's tip
 * once and stored, so every later start reads the same height. The wait is
 * the block processor's own for its first height: a node that is down delays
 * the start, it never guesses one.
 */
const resolveAt = async (
  walletId: string,
  asked: PenumbraStart,
  grpcEndpoint: string,
  signal?: AbortSignal,
) => {
  const tip = await backOff(() => chainTip(grpcEndpoint), {
    startingDelay: 5_000,
    maxDelay: 20_000,
    numOfAttempts: Infinity,
    retry: () => !signal?.aborted,
  });
  const resolved = resolveStart(asked, tip, Date.now());
  await setStart(walletId, resolved);
  return resolved;
};

const setStart = async (walletId: string, start: ResolvedStart) =>
  localExtStorage.set('penumbraStarts', {
    ...startsOf(await localExtStorage.get('penumbraStarts')),
    [walletId]: start,
  });

/** the global birthday older builds kept, moved onto its wallet once (see adoptLegacyStart) */
const adoptLegacy = async () => {
  const creation = await localExtStorage.get('walletCreationBlockHeight');
  const frontier = await localExtStorage.get('compactFrontierBlockHeight');
  if (creation === undefined && frontier === undefined) {
    return;
  }
  const ids = (await getWalletsFromStorage()).map(w => w.id);
  if (!ids.length) {
    return;
  }
  const next = adoptLegacyStart(
    ids,
    { creation, frontier },
    await localExtStorage.get('penumbraStarts'),
  );
  if (next) {
    await localExtStorage.set('penumbraStarts', next);
  }
  await localExtStorage.remove('walletCreationBlockHeight');
  await localExtStorage.remove('compactFrontierBlockHeight');
  await localExtStorage.remove('fullSyncHeight');
};

const chainTip = async (baseUrl: string) => {
  const { syncInfo } = await createClient(
    TendermintProxyService,
    createGrpcWebTransport({ baseUrl }),
  ).getStatus({});
  const tip = Number(syncInfo?.latestBlockHeight ?? 0);
  if (!tip) {
    throw new Error('the penumbra node did not say its height');
  }
  return tip;
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
 * Publish this wallet's synced height for the home, with the height the run
 * started from. Every write names the wallet and none follows a stop, so a
 * home never shows one wallet's height under another.
 */
export const publishSyncHeight = async (
  walletId: string,
  { indexedDb }: Pick<WalletServices, 'indexedDb'>,
  signal?: AbortSignal,
) => {
  const known = (h: bigint | undefined) =>
    h == null || h === SENTINEL_U64_MAX ? undefined : Number(h);
  const from = known(await indexedDb.getFullSyncHeight()) ?? 0;
  const publish = (height: number) =>
    signal?.aborted ? undefined : localExtStorage.set('penumbraSync', { walletId, height, from });
  await publish(from);
  for await (const { value } of indexedDb.subscribe('FULL_SYNC_HEIGHT')) {
    if (signal?.aborted) {
      break;
    }
    const height = known(value);
    if (height !== undefined) {
      await publish(height);
    }
  }
};

/**
 * The assets the view service records prices against, from the batch swaps in
 * the blocks it syncs: the stored or bundled registry numeraires, always with
 * UM and USDC.inj, which the penumbra home values in. A wallet onboarded with
 * an older set gets the two added once (no network).
 */
const numerairesFor = async (chainId: string): Promise<string[]> => {
  const stored = await localExtStorage.get('numeraires');
  try {
    const bundled = new ChainRegistryClient().bundled;
    const ids = [
      ...(stored.length ? stored : bundled.get(chainId).numeraires.map(n => n.toJsonString())),
      bundled.globals().stakingAssetId.toJsonString(),
      new AssetId({ inner: base64ToUint8Array(USDC_INJ_ID) }).toJsonString(),
    ];
    const next = [...new Set(ids.map(n => AssetId.fromJsonString(n).toJsonString()))];
    if (next.length !== stored.length) {
      await localExtStorage.set('numeraires', next);
    }
    return next;
  } catch {
    return stored;
  }
};
