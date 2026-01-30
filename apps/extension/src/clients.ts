import { ViewService, StakeService, SimulationService, DexService, SctService } from '@penumbra-zone/protobuf';
import { createClient } from '@connectrpc/connect';
import { createChannelTransport } from '@penumbra-zone/transport-dom/create';
import { CRSessionClient } from '@penumbra-zone/transport-chrome/session-client';
import { internalTransportOptions } from './transport-options';

// Initialize session client - this creates a MessageChannel and connects to the service worker
let sessionPort: MessagePort | undefined;

const getOrCreatePort = (): Promise<MessagePort> => {
  if (!sessionPort) {
    // In dev mode, use runtime ID (Chrome assigns dynamic ID for unpacked extensions)
    const extensionId = globalThis.__DEV__ ? chrome.runtime.id : ZIGNER;
    sessionPort = CRSessionClient.init(extensionId);
  }
  return Promise.resolve(sessionPort);
};

const extensionPageTransport = createChannelTransport({
  ...internalTransportOptions,
  getPort: getOrCreatePort,
});

export const viewClient = createClient(ViewService, extensionPageTransport);
export const stakeClient = createClient(StakeService, extensionPageTransport);
export const simulationClient = createClient(SimulationService, extensionPageTransport);
export const dexClient = createClient(DexService, extensionPageTransport);
export const sctClient = createClient(SctService, extensionPageTransport);
