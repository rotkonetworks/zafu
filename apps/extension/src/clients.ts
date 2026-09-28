import {
  ViewService,
  StakeService,
  SimulationService,
  DexService,
  SctService,
  GovernanceService,
} from '@penumbra-zone/protobuf';
import { createClient } from '@connectrpc/connect';
import { createChannelTransport } from '@penumbra-zone/transport-dom/create';
import { CRSessionClient } from '@penumbra-zone/transport-chrome/session-client';
import { internalTransportOptions } from './transport-options';
import { isContextInvalidated, noteContextInvalidated } from './utils/reload-notice';

// Initialize session client - this creates a MessageChannel and connects to the service worker
let sessionPort: MessagePort | undefined;
// A failed init is permanent for this document: once the extension context is
// gone (extension reloaded or auto-updated under an open page)
// `chrome.runtime.connect` throws forever, so a retry can only fail again.
// Cache the failure so the transport stops re-attempting it on every request,
// and raise the reload notice here - a rejection swallowed by a query layer
// would otherwise leave the wallet silently dead with no signal to the user.
let portFailure: { error: unknown } | undefined;

export const getOrCreatePort = async (): Promise<MessagePort> => {
  if (sessionPort) {
    return sessionPort;
  }
  if (portFailure) {
    throw portFailure.error;
  }
  try {
    return (sessionPort = CRSessionClient.init(chrome.runtime.id));
  } catch (error) {
    portFailure = { error };
    if (isContextInvalidated(error)) {
      noteContextInvalidated();
    }
    throw error;
  }
};

// A document that still holds this port when it enters the back/forward cache
// makes Chromium report an unchecked runtime.lastError ("the page keeping the
// extension port is moved into back/forward cache, so the message channel is
// closed"). The session is dead the moment the document is hidden-and-kept, so
// drop it here; a restored document re-inits lazily through getOrCreatePort.
//
// The guard is load-bearing: the service worker bundle reaches this module too,
// where there is no `window` - an unguarded listener here throws
// "ReferenceError: window is not defined" while the worker evaluates the module
// and takes the whole worker boot with it. The worker has no document, so it
// has no port to reap either.
if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => {
    if (!sessionPort) {
      return;
    }
    sessionPort = undefined;
    CRSessionClient.end(chrome.runtime.id);
  });
}

const extensionPageTransport = createChannelTransport({
  ...internalTransportOptions,
  getPort: getOrCreatePort,
});

export const viewClient = createClient(ViewService, extensionPageTransport);
export const stakeClient = createClient(StakeService, extensionPageTransport);
export const simulationClient = createClient(SimulationService, extensionPageTransport);
export const dexClient = createClient(DexService, extensionPageTransport);
export const sctClient = createClient(SctService, extensionPageTransport);
export const governanceClient = createClient(GovernanceService, extensionPageTransport);
