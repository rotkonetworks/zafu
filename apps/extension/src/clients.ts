import { ViewService, StakeService, SimulationService, DexService } from '@penumbra-zone/protobuf';
import { createClient } from '@connectrpc/connect';
import { createChannelTransport } from '@penumbra-zone/transport-dom/create';
import { CRSessionClient } from '@penumbra-zone/transport-chrome/session-client';
import { internalTransportOptions } from './transport-options';

const port = CRSessionClient.init(ZIGNER);

const extensionPageTransport = createChannelTransport({
  ...internalTransportOptions,
  getPort: () => Promise.resolve(port),
});

export const viewClient = createClient(ViewService, extensionPageTransport);
export const stakeClient = createClient(StakeService, extensionPageTransport);
export const simulationClient = createClient(SimulationService, extensionPageTransport);
export const dexClient = createClient(DexService, extensionPageTransport);
