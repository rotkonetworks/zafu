import { storedList } from '@repo/storage-chrome/stored-list';
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
import { WalletServices } from '@penumbrafi/types/services';
import { getRootNetwork } from './config/networks';
import { resolvePenumbraEndpoint } from './config/penumbra-endpoints';
import { hasLiveDappSession } from './dapp-session-presence';
import { AssetId } from '@penumbra-zone/protobuf/penumbra/core/asset/v1/asset_pb';
import { ChainRegistryClient } from '@penumbrafi/registry';
import { SENTINEL_U64_MAX } from './utils/sentinel';
import { base64ToUint8Array } from '@penumbrafi/types/base64';
import { USDC_INJ_ID } from './penumbra/quotes';
import {
  adoptLegacyStart,
  isResolved,
  resolveStart,
  startsOf,
  type PenumbraStart,
} from './penumbra/start';
import { penumbraTiming } from './penumbra/timing';
import { walletsWithStoredView } from './penumbra/stored-views';
import type { BlockProcessor } from '@penumbra-zone/query/block-processor';

/**
 * check if penumbra network is enabled
 * privacy-first: don't make network connections unless user has opted in
 */
export const isPenumbraEnabled = async (): Promise<boolean> => {
  const enabledNetworks = await localExtStorage.get('enabledNetworks');
  // if no networks configured yet, check vaults (wallets are encrypted at rest)
  if (!Array.isArray(enabledNetworks)) {
    return storedList(await localExtStorage.get('vaults')).length > 0;
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
  if (activeNetwork && getRootNetwork(activeNetwork) !== 'penumbra' && !hasLiveDappSession()) {
    return { run: false, reason: 'penumbra network not active' };
  }
  return { run: true };
};

export interface StartedServices {
  services: Services;
  wallet: WalletJson;
  reason?: string;
  /** the chain the services read (real services only) */
  chainId?: string;
}

export const startWalletServices = async (
  signal?: AbortSignal,
  /**
   * Sees the block processor before anything can start it. `chain.confirmed`
   * is false when the chain id came from storage, so the caller holds sync
   * until the node confirms it (see refreshPenumbraChainId).
   */
  onBlockProcessor?: (
    blockProcessor: BlockProcessor,
    chain: { id: string; confirmed: boolean },
  ) => void,
): Promise<StartedServices> => {
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
    const locked = performance.now();
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
    penumbraTiming('waited for unlock', locked);
  }

  await adoptLegacy();
  // chosen as penumbra turns on; a wallet that came another way reads the whole chain
  let asked = startsOf(await localExtStorage.get('penumbraStarts'))?.[wallet.id];
  // "sync from now" written for a wallet that already holds part of the
  // chain (an older build asked for every wallet at once) would skip every
  // block between its stored height and now: it reads on instead
  if (!asked || (asked === 'tip' && (await walletsWithStoredView([wallet.id])).has(wallet.id))) {
    asked = { since: 0 };
    await setStart(wallet.id, asked);
  }

  const grpcEndpoint = await resolvePenumbraEndpoint();
  let t = performance.now();
  const { chainId, confirmed } = await startChainId(paramsAt(grpcEndpoint));
  penumbraTiming(`params (${confirmed ? 'node, first run' : 'stored'})`, t);
  const numeraires = await numerairesFor(chainId);
  t = performance.now();
  // a known start is read at once; only a start still to resolve asks the node
  const start = isResolved(asked) ? asked : await resolveAt(wallet.id, asked, grpcEndpoint, signal);
  penumbraTiming(`start (${isResolved(asked) ? 'known' : 'node'})`, t);
  console.log(`[sync] starting from ${grpcEndpoint}, decrypting from ${start.creation}`);

  const services = new Services({
    grpcEndpoint,
    chainId,
    walletId: WalletId.fromJsonString(wallet.id),
    fullViewingKey: FullViewingKey.fromJsonString(wallet.fullViewingKey),
    numeraires: numeraires.map(n => AssetId.fromJsonString(n)),
    walletCreationBlockHeight: start.creation,
    compactFrontierBlockHeight: start.frontier,
    onBlockProcessor: bp => onBlockProcessor?.(bp, { id: chainId, confirmed }),
    onPhase: penumbraTiming,
  });

  const walletServices = await services.getWalletServices();
  // the frontier is good only while nothing is read yet: once the database
  // holds a height (the snapshot, or a genesis read after a failed one), a
  // lost database must be read again, since a snapshot at a later tip would
  // hide what arrived in between
  const read = knownHeight(await walletServices.indexedDb.getFullSyncHeight());
  if (start.frontier !== undefined && read !== undefined) {
    await setStart(wallet.id, { creation: start.creation });
  }
  void publishSyncHeight(wallet.id, walletServices, signal);
  // `@` is wake to ready: performance.now() in a worker counts from its start
  penumbraTiming('services ready');

  return { services, wallet, chainId };
};

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

const setStart = async (walletId: string, start: PenumbraStart) =>
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

interface ParamsSource {
  stored: () => Promise<AppParameters | undefined>;
  fetch: () => Promise<AppParameters | undefined>;
  save: (params: AppParameters) => Promise<void>;
}

const storedParams = () =>
  localExtStorage
    .get('params')
    .then(json => (json ? AppParameters.fromJsonString(json) : undefined));

const paramsAt = (baseUrl: string, timeoutMs?: number): ParamsSource => ({
  stored: storedParams,
  fetch: () =>
    createClient(AppService, createGrpcWebTransport({ baseUrl }))
      .appParameters({}, { timeoutMs })
      .then(({ appParameters }) => appParameters),
  save: params => localExtStorage.set('params', params.toJsonString()),
});

/**
 * The chain id the services start on. Stored params come first, so a start
 * never waits on the node; only a first run, with nothing stored, asks it.
 * A stored id is unconfirmed: the caller holds sync until
 * refreshPenumbraChainId has asked the node, and rebuilds if it changed.
 *
 * It's possible that the remote endpoint may suddenly serve a new chainId.
 * @see https://github.com/prax-wallet/prax/pull/65
 */
export const startChainId = async (
  source: ParamsSource,
): Promise<{ chainId: string; confirmed: boolean }> => {
  const stored = await source.stored();
  if (stored?.chainId) {
    return { chainId: stored.chainId, confirmed: false };
  }
  const fetched = await source.fetch().catch(() => undefined);
  if (!fetched?.chainId) {
    throw new Error('No chainId available');
  }
  await source.save(fetched);
  return { chainId: fetched.chainId, confirmed: true };
};

/**
 * How long the chain-id check waits for the node. A node that takes the
 * connection and never answers would otherwise keep sync held for the life of
 * the worker.
 */
export const CHAIN_CHECK_TIMEOUT_MS = 15_000;

/**
 * Ask the node for its params after the services are up, and store them when
 * they changed. The node's chain id, or undefined when it did not answer in
 * time.
 */
export const refreshChainId = async (
  source: ParamsSource,
  timeoutMs = CHAIN_CHECK_TIMEOUT_MS,
): Promise<string | undefined> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<undefined>(resolve => {
    timer = setTimeout(() => resolve(undefined), timeoutMs);
  });
  const fetched = await Promise.race([source.fetch().catch(() => undefined), late]).finally(() =>
    clearTimeout(timer),
  );
  if (!fetched?.chainId) {
    return undefined;
  }
  const stored = await source.stored();
  if (!stored?.equals(fetched)) {
    await source.save(fetched);
  }
  return fetched.chainId;
};

export const refreshPenumbraChainId = async () =>
  refreshChainId(paramsAt(await resolvePenumbraEndpoint(), CHAIN_CHECK_TIMEOUT_MS));

/** the chain id of the stored params, without asking anyone */
export const storedPenumbraChainId = async () =>
  (await storedParams().catch(() => undefined))?.chainId || undefined;

const knownHeight = (h: bigint | undefined) =>
  h == null || h === SENTINEL_U64_MAX ? undefined : Number(h);

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
  const from = knownHeight(await indexedDb.getFullSyncHeight()) ?? 0;
  const publish = (height: number) =>
    signal?.aborted ? undefined : localExtStorage.set('penumbraSync', { walletId, height, from });
  await publish(from);
  for await (const { value } of indexedDb.subscribe('FULL_SYNC_HEIGHT')) {
    if (signal?.aborted) {
      break;
    }
    const height = knownHeight(value);
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
  // a cache of asset ids: anything but a list is rebuilt from the registry
  const stored = storedList<string>(await localExtStorage.get('numeraires'));
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
