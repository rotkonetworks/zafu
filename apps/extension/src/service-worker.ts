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
import { contentScriptDisconnectListener } from './message/listen/content-script-disconnect';
import { contentScriptLoadListener } from './message/listen/content-script-load';
import { internalRevokeListener } from './message/listen/internal-revoke';
import { internalServiceListener } from './message/listen/internal-services';
import { externalEasterEggListener } from './message/listen/external-easteregg';

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

// Reinitialize services when active wallet changes
const reinitializeServices = async () => {
  walletServices = startWalletServices();
  // Ensure services start syncing
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

  // Reinitialize when wallets are created (first wallet triggers sync)
  if (changes.wallets !== undefined) {
    const oldWallets = changes.wallets.oldValue ?? [];
    const newWallets = changes.wallets.newValue ?? [];
    if (oldWallets.length === 0 && newWallets.length > 0) {
      console.log('[sync] first wallet created, initializing services...');
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
  walletServices = startWalletServices();
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
      contextValues.set(servicesCtx, () => walletServices);
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
    console.log("zigner couldn't start wallet services", attemptNumber, e);
    return true;
  },
});

// In dev mode, use runtime ID (Chrome assigns dynamic ID for unpacked extensions)
CRSessionManager.init(globalThis.__DEV__ ? chrome.runtime.id : ZIGNER, handler, validateSessionPort);

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

// listen for external messages
chrome.runtime.onMessageExternal.addListener(externalEasterEggListener);

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

// side panel setup
// allow opening side panel from popup or context menu
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => {
  // side panel not supported in this browser version
});

// context menu to open side panel
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'open-side-panel',
    title: 'Open Zafu in Side Panel',
    contexts: ['action'],
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'open-side-panel' && tab?.windowId) {
    void chrome.sidePanel.open({ windowId: tab.windowId });
  }
});
