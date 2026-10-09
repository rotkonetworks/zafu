/**
 * This file is the entrypoint for the main and only background service worker.
 *
 * It is responsible for initializing:
 * - listeners for chrome runtime events
 * - Services, with endpoint config and a wallet
 * - rpc services, router, and adapter
 * - session manager for rpc entry
 */

// The egress guard patches fetch/WebSocket/EventSource before any module can
// capture them. Then the global error / unhandledrejection listeners, from a
// sync module, so MV3 sees them on the worker's initial synchronous
// evaluation. Both MUST stay above every wasm-backed import below (see the
// file's note on asyncWebAssembly deferring the entry body).
import './net/egress-install';
import './install-global-error-handlers';
import './sw-online';

// listeners
import { contentScriptConnectListener } from './message/listen/content-script-connect';
import { signRequestListener } from './message/listen/sign-request';
import { contentScriptDisconnectListener } from './message/listen/content-script-disconnect';
import { contentScriptLoadListener } from './message/listen/content-script-load';
import { internalRevokeListener } from './message/listen/internal-revoke';
import { internalServiceListener } from './message/listen/internal-services';
import { externalMessageListener } from './message/listen/external-easteregg';
import { encryptionMessageListener } from './message/listen/external-encryption';
import { contactDiscoveryListener } from './message/listen/contact-discovery';
import { startDiscoveryPresence } from './discovery-presence-port';
import {
  contactDiscoveryRequestListener,
  contactDiscoveryRequestResultListener,
} from './message/listen/contact-discovery-request';
import { destinationConsentResultListener } from './net/prompt';
import { runNetEgressMigration } from './net/egress-migrate';
import { loadStoredRegistry } from './transparent/registry-live';
import { refreshEgress } from './net/egress';
import { NET_EGRESS_INTERNAL_METHODS } from './message/listen/zafu-method-names';
import { linkListener } from './message/listen/links';
import { openWalletRoute } from './message/listen/external-easteregg';
import { omniboxDescription, omniboxUri, escapeOmniboxXml } from './links/omnibox';
import { PopupPath } from './routes/popup/paths';
import { keplrMessageListener } from './message/listen/keplr';
import { createPenumbraSendListener } from './message/listen/penumbra-send';
import { TX_OP_PREFIX, isTxOp, type TxOp } from './tx-ops';
import { sweepAndResume, defaultTrackerDeps } from './state/ibc-transfer-tracker';
import { makeIbcProbe } from './state/ibc-transfer-probes';
import { openApprovalPopup } from './utils/popup-window';
import { trackSidePanelPresence } from './side-panel-presence';
import { initSidePanelPref } from './side-panel-pref';
import { setDappSessionHooks } from './dapp-session-presence';

// all rpc implementations, local and proxy
import { getRpcImpls } from './rpc';

// adapter
import { ConnectRouter, createContextValues, Client } from '@connectrpc/connect';
import { jsonOptions } from '@penumbra-zone/protobuf';
import { CRSessionManager } from '@penumbra-zone/transport-chrome/session-manager';
import { connectChannelAdapter } from '@penumbra-zone/transport-dom/adapter';
import { validateSessionPort } from './senders/session';

// context
import { fvkCtx } from '@penumbrafi/services/ctx/full-viewing-key';
import { servicesCtx } from '@penumbrafi/services/ctx/prax';
import { getFullViewingKey } from './ctx/full-viewing-key';
import { getWalletId } from './ctx/wallet-id';
import { setCachedWallet, resetWalletCache } from './ctx/wallet-cache';

// custody context
import { authorizeCtx } from '@repo/custody-chrome/ctx';
import { getAuthorization } from './ctx/authorization';

// context clients
import { CustodyService, StakeService, ViewService } from '@penumbra-zone/protobuf';
import { custodyClientCtx } from '@penumbrafi/services/ctx/custody-client';
import { stakeClientCtx } from '@penumbrafi/services/ctx/stake-client';
import { createDirectClient } from './direct-client';
import { internalTransportOptions } from './transport-options';

// idb, querier, block processor
import { walletIdCtx } from '@penumbrafi/services/ctx/wallet-id';
import type { Services } from '@repo/context';
import {
  startWalletServices,
  penumbraGate,
  refreshPenumbraChainId,
  storedPenumbraChainId,
} from './wallet-services';
import type { StartedServices } from './wallet-services';
import type { BlockProcessor } from '@penumbra-zone/query/block-processor';
import { errText, storageFailure } from '@penumbra-zone/query/error-text';
import { getWalletFromStorage } from '@repo/storage-chrome/onboard';
import type { WalletJson } from '@repo/wallet';
import { createRebuildScheduler } from './rebuild-scheduler';
import { sameTarget, settledTarget, type PenumbraTarget } from './penumbra/start';
import { finishPendingWipe, performPendingClears } from './clear-cache-startup';

import { backOff } from 'exponential-backoff';

import { localExtStorage } from '@repo/storage-chrome/local';
import { networkAllowsBackgroundSync } from './state/privacy';
import { startUiOpenSession } from './ui-open-session';
import { startNymLifecycle } from './net/nym-lifecycle';
import { ensureOffscreenDocument } from './offscreen-document';
import { startPeopleRelay } from './people/sw';
import { penumbraTiming } from './penumbra/timing';
import { createChainCheck } from './penumbra/chain-check';
import { createStorageReopen } from './penumbra/storage-reopen';
import { requestStopAllSync } from './state/keyring/network-worker';
import { stampSeenVersion } from './state/moved-notice';
import { idleFor } from './state/idle-activity';
import { keptCaptureAccess } from './buy/capture/kept';

// performance.now() counts from the worker's start, so this is wake to here:
// the wasm-backed imports above are what the entry body waits on
penumbraTiming('sw modules and wasm loaded');

// count open side panels so approval routing can target the panel only when it
// is actually open (see popup.ts). Registered once at worker startup.
trackSidePanelPresence();

// Seed the in-memory `approvalsInSidePanel` mirror so the connect listener can
// decide to open the side panel without an awaited storage read (which would
// lose the user gesture chrome.sidePanel.open requires).
initSidePanelPref();

/** penumbra's block processor runs in this worker: pause it with the last
 *  window and resume with the next, like the zcash worker */
const penumbraSync = (act: 'pause' | 'resume') =>
  void walletServices
    ?.then(s => s.getWalletServices())
    // pause/resume live on zafu's block processor, not the shared interface
    .then(ws => (ws.blockProcessor as { pause?: () => void; resume?: () => void })[act]?.())
    .catch(() => undefined);
/** the user's "keep syncing when closed": penumbra alone may go on with every window closed */
let keepPenumbraSyncing = false;
const readKeepSyncing = () =>
  localExtStorage
    .get('privacySettings')
    .then(p => {
      keepPenumbraSyncing = p?.keepPenumbraSyncing === true;
    })
    .catch(() => undefined);
/**
 * The first read of the setting. Services are only built once it has landed
 * (see initHandler and rebuildServices): a block processor built before it
 * would take every worker start - a browser restart, MV3 recycling the worker
 * - for "keep syncing" off, and pause with every window closed.
 */
const keepSyncingRead = readKeepSyncing();
chrome.storage.onChanged.addListener(
  (c, area) => void (area === 'local' && 'privacySettings' in c && readKeepSyncing()),
);
// zafu is fully closed: the offscreen-hosted zcash worker otherwise keeps
// syncing (and polling mempool) with nobody watching. Stop network activity
// only - the offscreen document and its worker stay up for proving - and the
// next popup/page open resumes sync on its own (zcash-auto-sync.ts).
// people: group and pair rooms on the people relay. Starts nothing by
// itself; the first request is the person opening people.
const people = startPeopleRelay();

// a Peer capture grant kept "for the next buy" (webRequest + scripting, which
// reach every site) is given back once its time is up, even if the buy page is
// never opened again
void keptCaptureAccess().catch(() => undefined);

// nym: kept up while unlocked, or started on demand (net/nym-plan.ts)
const nym = startNymLifecycle();

const ui = startUiOpenSession(
  {
    resume: () => {
      penumbraSync('resume');
      runChainCheck();
      reopenPenumbraStorage.onOpen();
    },
    pause: () => {
      console.log('[sw] last UI surface closed, requesting zcash sync stop');
      nym.lastWindowClosed();
      requestStopAllSync('zcash');
      if (!keepPenumbraSyncing) {
        penumbraSync('pause');
      }
    },
  },
  people.hooks,
);

/**
 * Services start on the stored chain id, so a start never waits on the node.
 * Their sync is held until the node confirms it - asked only once a window is
 * open, since nothing may call out while every window is closed. A changed id
 * rebuilds the services, and the held sync means the old chain's database
 * never reads a block of the new one.
 */
const chainCheck = createChainCheck({
  windowOpen: () => ui.open,
  refresh: async () => {
    const t = performance.now();
    try {
      return await refreshPenumbraChainId();
    } finally {
      penumbraTiming('params refresh (node)', t);
    }
  },
  rebuild: why => void reinitializeServices(why),
  retryMs: 60_000,
});
const runChainCheck = chainCheck.run;

/** penumbra storage failures: reopen a few times, then stop and say so (penumbra/storage-reopen.ts) */
const reopenPenumbraStorage = createStorageReopen({
  reopen: () => void rebuilds.request('penumbra storage reopen', true),
  mayReopen: () => ui.open || keepPenumbraSyncing,
  kind: e => storageFailure(e),
  stopped: () =>
    void localExtStorage
      .get('penumbraSync')
      .then(cur => cur && localExtStorage.set('penumbraSync', { ...cur, stopped: 'storage' }))
      .catch(() => undefined),
  height: async () => (await localExtStorage.get('penumbraSync'))?.height,
});
chrome.storage.onChanged.addListener((c, area) => {
  const height = (c['penumbraSync']?.newValue as { height?: unknown } | undefined)?.height;
  if (area === 'local' && typeof height === 'number') {
    reopenPenumbraStorage.progressed(height);
  }
});

/** a fresh block processor, before anything can start it */
const onBlockProcessor = (bp: BlockProcessor, chain: { id: string; confirmed: boolean }) => {
  bp.onStorageFailure = reopenPenumbraStorage.failed;
  // fresh services start syncing at once; with every window closed they wait
  if (!ui.open && !keepPenumbraSyncing) {
    bp.pause();
  }
  // a stored tree is only ever wiped (self-heal) once the node confirmed the chain
  bp.chainConfirmed = chain.confirmed;
  if (chain.confirmed) {
    chainCheck.drop();
    return;
  }
  // confirmed, or the node did not answer in time: sync goes on as it would
  // have (see penumbra/chain-check.ts)
  chainCheck.arm(chain.id, bp.hold(), () => {
    bp.chainConfirmed = true;
  });
};

// The graceful network-error handler (unhandledrejection + error) is registered
// by the top-of-file './install-global-error-handlers' import - it must run on
// the worker's initial synchronous evaluation, which the entry body (deferred
// past the async wasm imports) is not. See that file for the full rationale.

// Migrations are now attached at localExtStorage construction (see
// storage-chrome/local.ts) so every realm - SW, popup, options page - has them,
// not just this worker. No explicit enableMigration call needed here.

let walletServicesResult: Promise<StartedServices>;
// Undefined until `initHandler` creates the boot services. Any awaited use must
// tolerate that: the first millisecond of a worker's life is a real, reachable
// state, not just a typing nicety (see the blockSync alarm and the internal
// service listener).
let walletServices: Promise<Services> | undefined;
let currentSyncAbort: AbortController | undefined;

/**
 * What the running penumbra services are for: which wallet, and whether they
 * are real or a stub. A rebuild is only worth doing when this changes - a full
 * rebuild restarts sync, reloads the whole state-commitment tree from IndexedDB
 * into wasm and re-fetches genesis, which on a large wallet (hundreds of LP
 * positions) takes a long time, and dapps see empty/zero state meanwhile.
 */
const desiredPenumbraTarget = async (): Promise<PenumbraTarget> => ({
  walletId: (await getWalletFromStorage())?.id,
  run: (await penumbraGate()).run,
  chainId: await storedPenumbraChainId(),
});

const settle = (
  r: { wallet?: WalletJson; reason?: string; chainId?: string },
  target: PenumbraTarget,
) => {
  rebuilds.setRunning(
    settledTarget({ ...target, chainId: r.chainId ?? target.chainId }, r.wallet?.id),
  );
  // confirm the stored chain id now if a window is open, else on the next
  // open. With "keep syncing when closed" on, now in any case: the hold would
  // otherwise keep penumbra from syncing until a window opens, which is the
  // one thing the setting promises not to do, and this is the one call to the
  // node the user opted into.
  if (ui.open || keepPenumbraSyncing) {
    runChainCheck();
  }
};

/** Tear down the current services and start fresh ones for `target`. */
const rebuildServices = async (target: PenumbraTarget, _previous: unknown, why: string) => {
  // tear down old services: stop block processor + its height publishing
  if (currentSyncAbort) {
    currentSyncAbort.abort();
  }
  // a rebuild that races the boot (or follows a failed one) has nothing to stop
  if (walletServices) {
    try {
      const oldServices = await walletServices;
      const oldWs = await oldServices.getWalletServices();
      oldWs.blockProcessor.stop(why);
      console.log(`[sync] stopped old block processor (${why})`);
    } catch {
      // old services were a stub or never initialized - nothing to stop
    }
  }

  // new RPC requests will block on getWalletReady() until the new wallet is cached
  resetWalletCache();

  currentSyncAbort = new AbortController();
  // the old services' chain check is moot: it must not ask a node for them
  chainCheck.drop();
  await keepSyncingRead;
  walletServicesResult = startWalletServices(currentSyncAbort.signal, onBlockProcessor);
  walletServices = walletServicesResult.then(r => r.services);
  const result = await walletServicesResult;
  const { services, wallet, reason } = result;
  setCachedWallet(wallet, reason);
  settle(result, target);
  try {
    const ws = await services.getWalletServices();
    // an intentional stop ends a run quietly; anything else deserves the console
    void ws.blockProcessor
      .sync()
      .catch((e: unknown) => console.error(`[sync] block processor terminated: ${errText(e)}`));
  } catch {
    // stub services (penumbra gated off): nothing to sync
  }
};

// Serialized + coalesced + skip-if-unchanged (see rebuild-scheduler.ts): no two
// rebuilds overlap, bursts fold into one, and a request that would produce what
// is already running does nothing.
const rebuilds = createRebuildScheduler<PenumbraTarget>({
  desired: desiredPenumbraTarget,
  same: sameTarget,
  rebuild: rebuildServices,
  onError: e => console.error(`[sync] rebuild failed: ${errText(e)}`),
});
const reinitializeServices = (why: string) => rebuilds.request(why);

// Keep penumbra services in step with connected dapps. When the extension UI is
// NOT on penumbra, a dapp session (or losing the last one) flips whether
// penumbra should sync, so reinit to apply the gate. When the UI IS on penumbra,
// penumbra is already active and a session change is a no-op - skip the churn
// (reinit restarts the block processor, which is not free on a large wallet).
//
// Only the FIRST session acts: it starts penumbra if the gate had it stubbed
// (a no-op when it is already running). The LAST session ending deliberately
// does NOT tear penumbra down. Dapps open a short-lived port per streaming RPC,
// so the count drops to zero between requests all the time; tearing down on
// each drop rebuilt the whole wallet (tree reload, genesis fetch, zeroed
// balances) several times per transaction - dapps then saw stale or empty
// state. Penumbra stays up until the user next switches networks, which
// re-evaluates the gate.
//
// If penumbra was stubbed, the dapp's first RPCs arrive on this very port
// before the rebuild swaps the stub out, and used to fail with "penumbra
// network not active". Hold them on `dappStart` until the real services exist.
let dappStart: Promise<void> | undefined;
setDappSessionHooks({
  onFirst: () => {
    const stubbed = rebuilds.getRunning()?.run === false;
    if (stubbed) {
      // block wallet getters now; the rebuild settles this same cache
      resetWalletCache();
    }
    const started = reinitializeServices('dapp session started');
    if (stubbed) {
      dappStart = started;
      void started.finally(async () => {
        if (dappStart === started) {
          dappStart = undefined;
        }
        // the scheduler skipped (gate still closed, e.g. penumbra disabled):
        // no rebuild settled the cache reset above, so fail it like the stub would
        if (rebuilds.getRunning()?.run === false) {
          const gate = await penumbraGate();
          setCachedWallet(undefined, gate.run ? undefined : gate.reason);
        }
      });
    }
  },
});

/** The penumbra services RPCs should use, waiting out a dapp-triggered start. */
const currentWalletServices = () =>
  dappStart ? dappStart.then(() => walletServices) : walletServices;

// Listen for wallet and network changes
localExtStorage.addListener(changes => {
  // a switch, a new wallet (prepended, so the index alone may not change) or
  // a chosen start; the scheduler skips whatever leaves the target as it is
  if (changes.activeWalletIndex || changes.penumbraWallets || changes.penumbraStarts) {
    void reinitializeServices('wallet or start changed');
  }

  // Reinitialize when first vault is created (wallets are encrypted, use vaults as signal)
  if (changes.vaults !== undefined) {
    const oldVaults = (changes.vaults.oldValue ?? []) as unknown[];
    const newVaults = (changes.vaults.newValue ?? []) as unknown[];
    if (oldVaults.length === 0 && newVaults.length > 0) {
      console.log('[sync] first vault created, initializing services...');
      void reinitializeServices('first vault');
    }
  }

  // Reinitialize when penumbra network is enabled
  if (changes.enabledNetworks !== undefined) {
    const newNetworks = changes.enabledNetworks.newValue ?? [];
    const oldNetworks = changes.enabledNetworks.oldValue ?? [];
    if (!oldNetworks.includes('penumbra') && newNetworks.includes('penumbra')) {
      console.log('[sync] penumbra network enabled, initializing services...');
      void reinitializeServices('penumbra enabled');
    }
  }

  // Active-scoped sync: when the user switches networks, restart services so
  // penumbra sync starts only when penumbra is the active network and stops
  // when they switch away (privacy - no background stream to a network you are
  // not viewing). startWalletServices enforces the active gate.
  // Skipped automatically when the gate outcome does not change (e.g.
  // penumbra <-> noble, both in the penumbra group).
  if (changes.activeNetwork !== undefined) {
    void reinitializeServices('network switch');
  }
});

const initHandler = async () => {
  // v1 egress ledger -> default deny, once (see net/egress-migrate.ts)
  await runNetEgressMigration().catch(() => undefined);

  // chains from a verified newer registry, then their egress rows (storage only)
  if ((await loadStoredRegistry().catch(() => [])).length) {
    await refreshEgress();
  }

  // run any pending IDB clears requested before the previous reload,
  // BEFORE wallet services open new connections (which would block deletion)
  await finishPendingWipe().catch(e =>
    console.warn(`[clear-startup] erase finish failed: ${errText(e)}`),
  );
  await performPendingClears();

  // record what the boot services are for, so a later request that would
  // produce the same thing is skipped instead of rebuilding
  const bootTarget = await desiredPenumbraTarget();
  rebuilds.setRunning(bootTarget);
  currentSyncAbort = new AbortController();
  // the processor decides at birth whether to pause with every window closed
  await keepSyncingRead;
  walletServicesResult = startWalletServices(currentSyncAbort.signal, onBlockProcessor);
  walletServices = walletServicesResult.then(r => r.services);
  // cache decrypted wallet as soon as it's available - unblocks RPC context getters
  void walletServicesResult.then(r => {
    setCachedWallet(r.wallet, r.reason);
    settle(r, bootTarget);
  });
  const rpcImpls = await getRpcImpls();

  let custodyClient: Client<typeof CustodyService> | undefined;
  let stakeClient: Client<typeof StakeService> | undefined;
  let handler: ReturnType<typeof connectChannelAdapter>;

  handler = connectChannelAdapter({
    jsonOptions,

    /** @see https://connectrpc.com/docs/node/implementing-services */
    routes: (router: ConnectRouter) =>
      rpcImpls.map(([serviceType, serviceImpl]) => router.service(serviceType, serviceImpl)),

    // context so impls can access storage, ui, other services, etc
    createRequestContext: req => {
      const contextValues = req.contextValues ?? createContextValues();

      // initialize or reuse context clients
      custodyClient ??= createDirectClient(CustodyService, handler, internalTransportOptions);
      stakeClient ??= createDirectClient(StakeService, handler, internalTransportOptions);
      contextValues.set(custodyClientCtx, custodyClient);
      contextValues.set(stakeClientCtx, stakeClient);

      // remaining context for all services
      contextValues.set(fvkCtx, getFullViewingKey);
      contextValues.set(servicesCtx, currentWalletServices as never);
      contextValues.set(walletIdCtx, getWalletId);

      // discriminate context available to specific services
      const { pathname } = new URL(req.url);
      if (pathname.startsWith('/penumbra.custody.v1.Custody')) {
        contextValues.set(authorizeCtx, getAuthorization);
      }

      return Promise.resolve({ ...req, contextValues });
    },
  });

  return handler;
};

// register message listeners IMMEDIATELY - before wallet services init.
// wallet services now wait for unlock (wallets encrypted at rest), but
// content scripts and dapps need the connect/disconnect/load listeners
// to be ready as soon as the service worker starts.
chrome.runtime.onMessage.addListener(contentScriptConnectListener);
chrome.runtime.onMessage.addListener(contentScriptDisconnectListener);
chrome.runtime.onMessage.addListener(contentScriptLoadListener);
chrome.runtime.onMessage.addListener(internalRevokeListener);
chrome.runtime.onMessage.addListener(linkListener);

// CRSessionManager must be initialized NOW - before wallet services are
// ready - so content scripts can establish session ports right after the
// approval popup. The deferred handler queues RPC requests until the
// real handler resolves.
type HandlerFn = (request: never, signal?: AbortSignal, timeoutMs?: number) => Promise<never>;
let resolveHandler: (h: HandlerFn) => void;
const handlerReady = new Promise<HandlerFn>(r => {
  resolveHandler = r;
});

const deferredHandler: HandlerFn = (request, signal, timeoutMs) =>
  handlerReady.then(h => h(request, signal, timeoutMs));

CRSessionManager.init(chrome.runtime.id, deferredHandler as never, validateSessionPort);

// start services in background - resolves handlerReady when done
void backOff(() => initHandler(), {
  delayFirstAttempt: false,
  startingDelay: 5_000,
  numOfAttempts: Infinity,
  maxDelay: 20_000,
  retry: (e, attemptNumber) => {
    console.log("zafu couldn't start wallet services", attemptNumber, e);
    return true;
  },
}).then(handler => resolveHandler!(handler as unknown as HandlerFn));

// Internal ViewService client for SW-driven sends. It talks to the same rpc
// handler the page would, but has no dependency on the page's MessagePort - so
// a send started from the side panel completes even after the panel reloads to
// show the approval (which tears that port down).
let internalViewClient: Client<typeof ViewService> | undefined;
const getInternalViewClient = async (): Promise<Client<typeof ViewService>> => {
  const readyHandler = await handlerReady;
  internalViewClient ??= createDirectClient(
    ViewService,
    readyHandler as never,
    internalTransportOptions,
  );
  return internalViewClient;
};
chrome.runtime.onMessage.addListener(createPenumbraSendListener(getInternalViewClient));

// IBC transfer tracker: poll destination chains for shield/unshield arrival.
// Shield-in reads the Penumbra note via the SW's INTERNAL view client (no
// dependency on any page port); unshield-out reads the cosmos burner balance.
// This runs in the background so arrival/timeout is detected even while the
// popup is closed, and resumes after SW eviction (see the alarm + startup sweep
// below). It reuses the existing balance/note query paths - no new RPC.
const ibcTransferProbe = makeIbcProbe(async account => {
  const client = await getInternalViewClient();
  return Array.fromAsync(client.balances({ accountFilter: { account } }));
});
const runIbcTransferSweep = (): Promise<void> =>
  sweepAndResume(ibcTransferProbe, defaultTrackerDeps());

// Keplr provider: cosmos dapps (Skip Go etc.) talk to us through the content-
// script bridge; this handles connect, getKey, cosmos signing, and broadcast.
chrome.runtime.onMessage.addListener(keplrMessageListener);

// On startup, a Penumbra op still pending belonged to a service worker that has
// since died (those ops run in the SW); the task cannot resume. Mark it unknown,
// not failed: it may have been broadcast before the worker died.
void (async () => {
  const all = await chrome.storage.session.get(null);
  const patch: Record<string, TxOp> = {};
  for (const [key, value] of Object.entries(all)) {
    if (
      key.startsWith(TX_OP_PREFIX) &&
      isTxOp(value) &&
      value.network === 'penumbra' &&
      value.status === 'pending'
    ) {
      patch[key] = {
        ...value,
        status: 'unknown',
        error: 'zafu restarted while this ran · please look in activity',
        updatedAt: Date.now(),
      };
    }
  }
  if (Object.keys(patch).length > 0) {
    await chrome.storage.session.set(patch);
  }
})();

// On startup, RESUME polling any pending IBC transfer (unlike penumbra sends, a
// destination poll is idempotent and fully reconstructible from the persisted
// record, so it survives SW eviction). Also prunes stale terminal records.
void runIbcTransferSweep().catch(e =>
  console.warn(`[ibc-tracker] startup sweep failed: ${errText(e)}`),
);

// listen for internal service controls. A message can arrive before
// `initHandler` created the boot services (the worker is started to deliver it),
// and every consumer here awaits this promise inside its own try/catch - so the
// pre-boot state is an explicit "still starting" rejection, not a TypeError on
// undefined.
//
// Most messages are not for this listener and never read the promise, so the
// rejection is marked handled here: an unread one surfaced as "Uncaught (in
// promise) Error: wallet services are still starting" for every message that
// woke the worker. Consumers that await it still get the rejection.
const servicesNotStarted = (): Promise<Services> => {
  const notYet = Promise.reject(new Error('wallet services are still starting'));
  notYet.catch(() => undefined);
  return notYet;
};

chrome.runtime.onMessage.addListener((req, sender, respond) =>
  internalServiceListener(walletServices ?? servicesNotStarted(), req, sender, respond),
);

// listen for identity sign requests from approved origins
chrome.runtime.onMessageExternal.addListener(signRequestListener);

// listen for external messages
chrome.runtime.onMessageExternal.addListener(externalMessageListener);

// listen for external encryption API (sealed box encrypt/decrypt, ZID pubkey)
chrome.runtime.onMessageExternal.addListener(encryptionMessageListener);

// listen for private, app-scoped contact discovery (zafu_discover_contacts).
// A no-op unless the user opted in and configured a relay.
chrome.runtime.onMessageExternal.addListener(contactDiscoveryListener);
// presence for a granted site's open page, held over its content script's
// port; nothing here runs while no granted page is open
startDiscoveryPresence();

// listen for the contact-discovery CONSENT request
// (zafu_request_contact_discovery): an app asks the user to turn the
// wallet-wide feature on. Opens the consent popup.
chrome.runtime.onMessageExternal.addListener(contactDiscoveryRequestListener);

// bridge: popup → SW result messages are sent via INTERNAL chrome.runtime.sendMessage
// (onMessage), but their handlers live in the external listeners (onMessageExternal).
const INTERNAL_RESULT_TYPES = new Set([
  'zafu_pick_contacts_result',
  'zafu_frost_result',
  'zafu_capability_result',
  'zafu_zcash_send_result',
  'zafu_passkey_result',
]);
chrome.runtime.onMessage.addListener((req, sender, sendResponse) => {
  const t = (req as { type?: unknown } | null)?.type;
  if (typeof t === 'string' && INTERNAL_RESULT_TYPES.has(t)) {
    return externalMessageListener(req, sender, sendResponse);
  }
  // passkey requests arrive from the ISOLATED content-script bridge
  // (passkey-bridge.ts) over onMessage, but their handlers live in the external
  // listener so the externally_connectable path and the injected intercept
  // share one implementation. Delegating is safe: both handlers take the origin
  // from the browser-attested sender and match the rpId against it, so a page
  // cannot act for another origin through the bridge.
  if (t === 'zafu_passkey_create' || t === 'zafu_passkey_get') {
    return externalMessageListener(req, sender, sendResponse);
  }
  if (t === 'zafu_encryption_approval_result') {
    return encryptionMessageListener(req, sender, sendResponse);
  }
  if (t === 'zafu_contact_discovery_approval_result') {
    return contactDiscoveryRequestResultListener(req, sender, sendResponse);
  }
  if (NET_EGRESS_INTERNAL_METHODS[0] === t) {
    return destinationConsentResultListener(req, sender, sendResponse);
  }
  return false;
});

// ── idle auto-lock ──
// The clock lives in chrome.storage.session (state/idle-activity.ts), written
// only by zafu's own pages on real input. Nothing here counts messages: a site
// pinging the wallet, or a content script, must not keep it unlocked, and an
// in-memory clock reset itself every time Chrome evicted this worker.

// https://developer.chrome.com/docs/extensions/reference/api/alarms
void chrome.alarms.create('blockSync', {
  periodInMinutes: 30,
  delayInMinutes: 0,
});

void chrome.alarms.create('idleCheck', {
  periodInMinutes: 1,
  delayInMinutes: 1,
});

// poll pending IBC transfers for arrival/timeout in the background
void chrome.alarms.create('ibcTransferPoll', {
  periodInMinutes: 1,
  delayInMinutes: 1,
});

chrome.alarms.onAlarm.addListener(async alarm => {
  if (alarm.name === 'ibcTransferPoll') {
    await runIbcTransferSweep().catch(e =>
      console.warn(`[ibc-tracker] poll failed: ${errText(e)}`),
    );
    return;
  }

  if (alarm.name === 'idleCheck') {
    const minutes = (await localExtStorage.get('autoLockMinutes')) ?? 15;
    if (minutes <= 0) {
      return;
    } // disabled
    if (await idleFor(minutes)) {
      // check if actually unlocked before locking
      const key = await chrome.storage.session.get('passwordKey');
      if (key?.['passwordKey']) {
        console.log(`[idle] auto-locking after ${minutes}m of inactivity`);
        // grace must never outlive the unlock; session storage survives
        // runtime.reload(), so remove it explicitly here too
        await chrome.storage.session.remove([
          'passwordKey',
          'identityKeys',
          'signGraceUntil',
          'swapUnlock',
          'retiredPasswordKey',
          'penumbraBalancesSnapshot',
        ]);
        chrome.runtime.reload();
      }
    }
    return;
  }

  if (alarm.name === 'blockSync') {
    // nothing syncs while every zafu window is closed
    if (!ui.open) {
      return;
    }
    // shielded (penumbra, zcash) networks always sync - trial decryption
    // never leaks addresses; a transparent network's sync names them, so it
    // never runs in the background
    const activeNetwork = await localExtStorage.get('activeNetwork');
    const allowed = activeNetwork ? networkAllowsBackgroundSync(activeNetwork) : true;
    if (!allowed) {
      if (globalThis.__DEV__) {
        console.info('Background sync disabled by user privacy settings');
      }
      return;
    }

    if (globalThis.__DEV__) {
      console.info('Background sync scheduled');
    }

    // The alarm fires the moment the worker wakes, and `initHandler` reaches the
    // point where it creates these only after an await on storage - so on a cold
    // wake the block below read an undefined variable, dereferenced it
    // (TypeError: reading 'getWalletServices') and this catch reported that as
    // "services not initialized". The boot path syncs on its own
    // (startWalletServices starts the block processor), so an alarm that wins
    // the race has nothing to do.
    const booting = walletServices;
    if (!booting) {
      if (globalThis.__DEV__) {
        console.info('Skipping background sync: wallet services are still starting');
      }
      return;
    }

    // trigger sync for enabled networks only
    try {
      const services = await booting;
      const ws = await services.getWalletServices();
      // an intentional stop ends a run quietly; anything else deserves the console
      void ws.blockProcessor
        .sync()
        .catch((e: unknown) => console.error(`[sync] block processor terminated: ${errText(e)}`));
    } catch (e) {
      // services not initialized or penumbra off - expected, one quiet line
      if (globalThis.__DEV__) {
        console.debug(`Skipping background sync: ${errText(e)}`);
      }
    }
  }
});

// ── zcash offscreen proving ──
// The zcash-worker requests offscreen activation before sending prove requests.
// Only the service worker can call chrome.offscreen.createDocument().
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== 'ZCASH_ENSURE_OFFSCREEN') {
    return false;
  }
  void ensureOffscreenDocument().then(
    () => sendResponse({ ok: true }),
    (e: unknown) => sendResponse({ ok: false, error: String(e) }),
  );
  return true;
});

// the toolbar icon's surface (side panel or popup) is set by initSidePanelPref

// sweep scheduled multisig deletions on service-worker wake. app-driven multisigs
// (e.g. poker tables) schedule themselves for deletion 24h after settlement; this
// pass clears any that are past-due whenever the SW spins up.
void (async () => {
  try {
    // eager: runs at SW startup, where importScripts (lazy chunk loading) is disallowed
    const { sweepScheduledDeletes } = await import(
      /* webpackMode: "eager" */ './state/keyring/scheduled-deletes'
    );
    await sweepScheduledDeletes();
  } catch (e) {
    console.warn(`[sw] sweepScheduledDeletes failed: ${errText(e)}`);
  }
})();

// on install: open onboarding page + create context menu
chrome.runtime.onInstalled.addListener(({ reason, previousVersion }) => {
  void stampSeenVersion(reason, previousVersion).catch(() => undefined);
  chrome.contextMenus.create({
    id: 'open-popup-window',
    title: 'Open Zafu in Popup Window',
    contexts: ['action'],
  });

  // open onboarding on first install
  if (reason === 'install') {
    chrome.runtime.openOptionsPage();
  }
});

chrome.contextMenus.onClicked.addListener((_info, _tab) => {
  if (_info.menuItemId === 'open-popup-window') {
    void openApprovalPopup(chrome.runtime.getURL('popup.html'));
  }
});

// `zafu <intent>` in the address bar: same router as a clicked link, landing
// on the same prefilled review. One window at a time, like every other
// wallet-initiated popup - typing enter twice never stacks windows.
// absent until the extension is reloaded with the manifest's omnibox key
// (an unpacked build picks up new code first), and in browsers without it
chrome.omnibox?.onInputChanged.addListener((text, suggest) => {
  suggest([{ content: text, description: escapeOmniboxXml(omniboxDescription(text)) }]);
});

chrome.omnibox?.onInputEntered.addListener(text => {
  const route = `${PopupPath.LINK}?uri=${encodeURIComponent(omniboxUri(text))}&via=typed`;
  void openWalletRoute('omnibox', route);
});
