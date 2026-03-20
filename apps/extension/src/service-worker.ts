/**
 * This file is the entrypoint for the main and only background service worker.
 *
 * It is responsible for initializing:
 * - listeners for chrome runtime events
 * - Services, with endpoint config and a wallet
 * - rpc services, router, and adapter
 * - session manager for rpc entry
 */

// listeners
import { contentScriptConnectListener } from './message/listen/content-script-connect';
import { signRequestListener } from './message/listen/sign-request';
import { contentScriptDisconnectListener } from './message/listen/content-script-disconnect';
import { contentScriptLoadListener } from './message/listen/content-script-load';
import { internalRevokeListener } from './message/listen/internal-revoke';
import { internalServiceListener } from './message/listen/internal-services';
import { externalMessageListener } from './message/listen/external-easteregg';

// all rpc implementations, local and proxy
import { getRpcImpls } from './rpc';

// adapter
import { ConnectRouter, createContextValues, Client } from '@connectrpc/connect';
import { jsonOptions } from '@penumbra-zone/protobuf';
import { CRSessionManager } from '@penumbra-zone/transport-chrome/session-manager';
import { connectChannelAdapter } from '@penumbra-zone/transport-dom/adapter';
import { validateSessionPort } from './senders/session';

// context
import { fvkCtx } from '@rotko/penumbra-services/ctx/full-viewing-key';
import { servicesCtx } from '@rotko/penumbra-services/ctx/prax';
import { getFullViewingKey } from './ctx/full-viewing-key';
import { getWalletId } from './ctx/wallet-id';

// custody context
import { authorizeCtx } from '@repo/custody-chrome/ctx';
import { getAuthorization } from './ctx/authorization';

// context clients
import { CustodyService, StakeService } from '@penumbra-zone/protobuf';
import { custodyClientCtx } from '@rotko/penumbra-services/ctx/custody-client';
import { stakeClientCtx } from '@rotko/penumbra-services/ctx/stake-client';
import { createDirectClient } from '@penumbra-zone/transport-dom/direct';
import { internalTransportOptions } from './transport-options';

// idb, querier, block processor
import { walletIdCtx } from '@rotko/penumbra-services/ctx/wallet-id';
import type { Services } from '@repo/context';
import { startWalletServices } from './wallet-services';

import { backOff } from 'exponential-backoff';

import { localExtStorage } from '@repo/storage-chrome/local';
import { localMigrations } from '@repo/storage-chrome/migrations';

// polkadot custom chainspec support
import {
  registerCustomChainspec,
  unregisterCustomChainspec,
  getCustomChainspecs,
  type RelayChain,
} from '@repo/wallet/networks/polkadot';

localExtStorage.enableMigration(localMigrations);

/**
 * load custom chainspecs from storage and register with polkadot light client
 *
 * called on startup and when chainspecs change in storage.
 */
async function loadCustomChainspecs(): Promise<void> {
  const specs = await localExtStorage.get('customChainspecs') ?? [];
  const registered = getCustomChainspecs();

  // register new chainspecs
  for (const spec of specs) {
    if (!registered.has(spec.id)) {
      // map 'standalone' to null relay, others to RelayChain
      const relay = spec.relay === 'standalone' ? 'standalone' : spec.relay as RelayChain;
      registerCustomChainspec(
        spec.id,
        spec.chainspec,
        relay,
        spec.name,
        spec.symbol,
        spec.decimals
      );
    }
  }

  // unregister removed chainspecs
  const specIds = new Set(specs.map(s => s.id));
  for (const [id] of registered) {
    if (!specIds.has(id)) {
      unregisterCustomChainspec(id);
    }
  }

  console.log(`[polkadot] loaded ${specs.length} custom chainspecs`);
}

// load custom chainspecs on startup
void loadCustomChainspecs();

let walletServices: Promise<Services>;
let currentWalletIndex: number | undefined;
let currentSyncAbort: AbortController | undefined;

// Reinitialize services when active wallet changes
const reinitializeServices = async () => {
  // tear down old services: stop block processor + cancel fullSyncHeight subscription
  if (currentSyncAbort) {
    currentSyncAbort.abort();
  }
  try {
    const oldServices = await walletServices;
    const oldWs = await oldServices.getWalletServices();
    oldWs.blockProcessor.stop('wallet switch');
    console.log('[sync] stopped old block processor');
  } catch {
    // old services may not have initialized — that's fine
  }

  // clear stale fullSyncHeight so UI doesn't show old wallet's height
  await localExtStorage.set('fullSyncHeight', 0);

  // start fresh services for the new wallet
  currentSyncAbort = new AbortController();
  walletServices = startWalletServices(currentSyncAbort.signal);
  const services = await walletServices;
  const ws = await services.getWalletServices();
  void ws.blockProcessor.sync();
};

// Listen for wallet and network changes
localExtStorage.addListener(changes => {
  // Reinitialize when active wallet changes
  if (changes.activeWalletIndex !== undefined) {
    const newIndex = changes.activeWalletIndex.newValue ?? 0;
    if (currentWalletIndex !== undefined && currentWalletIndex !== newIndex) {
      console.log(`Switching wallet from ${currentWalletIndex} to ${newIndex}`);
      currentWalletIndex = newIndex;
      void reinitializeServices();
    } else {
      currentWalletIndex = newIndex;
    }
  }

  // Reinitialize when first vault is created (wallets are encrypted, use vaults as signal)
  if (changes.vaults !== undefined) {
    const oldVaults = (changes.vaults.oldValue ?? []) as unknown[];
    const newVaults = (changes.vaults.newValue ?? []) as unknown[];
    if (oldVaults.length === 0 && newVaults.length > 0) {
      console.log('[sync] first vault created, initializing services...');
      void reinitializeServices();
    }
  }

  // Reinitialize when penumbra network is enabled
  if (changes.enabledNetworks !== undefined) {
    const newNetworks = changes.enabledNetworks.newValue ?? [];
    const oldNetworks = changes.enabledNetworks.oldValue ?? [];
    if (!oldNetworks.includes('penumbra') && newNetworks.includes('penumbra')) {
      console.log('[sync] penumbra network enabled, initializing services...');
      void reinitializeServices();
    }
  }

  // sync custom chainspecs when they change
  if (changes.customChainspecs !== undefined) {
    void loadCustomChainspecs();
  }
});

const initHandler = async () => {
  // Track initial wallet index
  currentWalletIndex = (await localExtStorage.get('activeWalletIndex')) ?? 0;
  currentSyncAbort = new AbortController();
  walletServices = startWalletServices(currentSyncAbort.signal);
  const rpcImpls = await getRpcImpls();

  let custodyClient: Client<typeof CustodyService> | undefined;
  let stakeClient: Client<typeof StakeService> | undefined;

  return connectChannelAdapter({
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
      contextValues.set(servicesCtx, (() => walletServices) as never);
      contextValues.set(walletIdCtx, getWalletId);

      // discriminate context available to specific services
      const { pathname } = new URL(req.url);
      if (pathname.startsWith('/penumbra.custody.v1.Custody')) {
        contextValues.set(authorizeCtx, getAuthorization);
      }

      return Promise.resolve({ ...req, contextValues });
    },
  });
};

const handler = await backOff(() => initHandler(), {
  delayFirstAttempt: false,
  startingDelay: 5_000, // 5 seconds
  numOfAttempts: Infinity,
  maxDelay: 20_000, // 20 seconds
  retry: (e, attemptNumber) => {
    console.log("zafu couldn't start wallet services", attemptNumber, e);
    return true;
  },
});

// In dev mode, use runtime ID (Chrome assigns dynamic ID for unpacked extensions)
CRSessionManager.init(globalThis.__DEV__ ? chrome.runtime.id : ZAFU, handler, validateSessionPort);

// listen for content script activity
chrome.runtime.onMessage.addListener(contentScriptConnectListener);
chrome.runtime.onMessage.addListener(contentScriptDisconnectListener);
chrome.runtime.onMessage.addListener(contentScriptLoadListener);

// listen for internal revoke controls
chrome.runtime.onMessage.addListener(internalRevokeListener);

// listen for internal service controls
chrome.runtime.onMessage.addListener((req, sender, respond) =>
  internalServiceListener(walletServices, req, sender, respond),
);

// listen for identity sign requests from approved origins
chrome.runtime.onMessageExternal.addListener(signRequestListener);

// listen for external messages
chrome.runtime.onMessageExternal.addListener(externalMessageListener);

// https://developer.chrome.com/docs/extensions/reference/api/alarms
void chrome.alarms.create('blockSync', {
  periodInMinutes: 30,
  delayInMinutes: 0,
});

chrome.alarms.onAlarm.addListener(async alarm => {
  if (alarm.name === 'blockSync') {
    // privacy check: only run background sync if user has enabled it
    const privacySettings = await localExtStorage.get('privacySettings');
    if (privacySettings?.enableBackgroundSync === false) {
      if (globalThis.__DEV__) {
        console.info('Background sync disabled by user privacy settings');
      }
      return;
    }

    if (globalThis.__DEV__) {
      console.info('Background sync scheduled');
    }

    // trigger sync for enabled networks only
    try {
      const services = await walletServices;
      const ws = await services.getWalletServices();
      void ws.blockProcessor.sync();
    } catch (e) {
      // services not initialized or network not enabled - this is expected
      if (globalThis.__DEV__) {
        console.info('Skipping background sync:', e);
      }
    }
  }
});

// ── zcash offscreen proving ──
// The zcash-worker requests offscreen activation before sending prove requests.
// Only the service worker can call chrome.offscreen.createDocument().
const OFFSCREEN_PATH = '/offscreen.html';

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== 'ZCASH_ENSURE_OFFSCREEN') return false;
  void (async () => {
    try {
      const contexts = await chrome.runtime.getContexts({
        contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
      });
      if (!contexts.length) {
        await chrome.offscreen.createDocument({
          url: chrome.runtime.getURL(OFFSCREEN_PATH),
          reasons: [chrome.offscreen.Reason.WORKERS],
          justification: 'Zcash Halo 2 parallel proving via rayon thread pool',
        }).catch(() => { /* already exists */ });
      }
      sendResponse({ ok: true });
    } catch (e) {
      sendResponse({ ok: false, error: String(e) });
    }
  })();
  return true;
});

// default to side panel when clicking the extension icon
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {
  // side panel not supported in this browser version
});

// context menu to open in popup window (for users who prefer it)
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'open-popup-window',
    title: 'Open Zafu in Popup Window',
    contexts: ['action'],
  });
});

chrome.contextMenus.onClicked.addListener((_info, _tab) => {
  if (_info.menuItemId === 'open-popup-window') {
    void chrome.windows.create({
      url: chrome.runtime.getURL('popup.html'),
      type: 'popup',
      width: 400,
      height: 628,
    });
  }
});
