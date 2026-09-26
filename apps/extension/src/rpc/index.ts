import { MethodKind, type ServiceType } from '@bufbuild/protobuf';
import type { CallOptions, Client, ServiceImpl } from '@connectrpc/connect';
import { createClient } from '@connectrpc/connect';
import { createGrpcWebTransport } from '@connectrpc/connect-web';
import {
  AppService,
  CompactBlockService,
  CustodyService,
  DexService,
  GovernanceService,
  IbcChannelService,
  IbcClientService,
  IbcConnectionService,
  SctService,
  ShieldedPoolService,
  SimulationService,
  StakeService,
  TendermintProxyService,
  ViewService,
  FeeService,
} from '@penumbra-zone/protobuf';

import { custodyImpl } from '@repo/custody-chrome';

import { sctImpl } from '@rotko/penumbra-services/sct-service';
import { stakeImpl } from '@rotko/penumbra-services/stake-service';
import { viewImpl } from '@rotko/penumbra-services/view-service';
import { createProxyImpl, noContextHandler } from '@penumbra-zone/transport-dom/proxy';
import { resolvePenumbraEndpoint } from '../config/penumbra-endpoints';
import { rethrowImplErrors } from './rethrow-impl-errors';

type RpcImplTuple<T extends ServiceType> = [T, Partial<ServiceImpl<T>>];

/** A Connect client method at its loosest: request in, response out. */
type ClientMethod = (input: unknown, options?: CallOptions) => Promise<unknown>;

/**
 * One client per (service, endpoint), built on demand.
 *
 * The transport used to be created ONCE at worker startup from
 * `onboardGrpcEndpoint()` - the legacy `grpcEndpoint` key, behind a promise that
 * only settles once onboarding writes it. Both halves of that were wrong for the
 * wallet:
 *
 * - A node picked in Settings > Networks writes `networkEndpoints.penumbra`, so
 *   every proxied RPC kept talking to the old node until the worker restarted.
 * - With the legacy key unset, the promise never settled, so the router was
 *   never built and EVERY wallet RPC - including the worker-driven send that
 *   needs `handlerReady` - hung forever with no error while the block processor
 *   (which resolves its endpoint separately, with a default) synced on.
 *
 * Resolving per request, through the same resolver the block processor uses,
 * makes a picked node take effect on the next request and cannot hang.
 */
const proxyClients = new Map<string, Client<ServiceType>>();

const proxiedClient = async <T extends ServiceType>(serviceType: T): Promise<Client<T>> => {
  const baseUrl = await resolvePenumbraEndpoint();
  const key = `${serviceType.typeName}|${baseUrl}`;
  const cached = proxyClients.get(key);
  if (cached) {
    return cached as Client<T>;
  }
  const client = createClient(serviceType, createGrpcWebTransport({ baseUrl }));
  proxyClients.set(key, client as Client<ServiceType>);
  return client;
};

/**
 * A client-shaped object whose methods go through {@link proxiedClient} at call
 * time. `createProxyImpl` binds each method off the client once, when the router
 * is built, so the indirection has to live in the method itself - that is what
 * keeps the endpoint fresh for the life of the worker.
 */
const lazyProxyClient = <T extends ServiceType>(serviceType: T): Client<T> =>
  new Proxy({} as Client<T>, {
    get: (_target, method) => {
      if (typeof method !== 'string') {
        return undefined;
      }
      // library shape: the router hands the method the request message the
      // client expects, but TS cannot relate the two generics.
      const callOn = (client: Client<T>) =>
        client[method as keyof Client<T>] as unknown as ClientMethod;

      // A server-streaming method must return an async iterable synchronously.
      // Wrapping it in `.then` handed the router a Promise instead, and every
      // proxied stream (DexService.liquidityPositionsById,
      // CompactBlockService.compactBlockRange, ...) failed with "... is not
      // async iterable".
      if (serviceType.methods[method]?.kind === MethodKind.ServerStreaming) {
        return async function* (input: unknown, options?: CallOptions) {
          const client = await proxiedClient(serviceType);
          yield* callOn(client)(input, options) as unknown as AsyncIterable<unknown>;
        };
      }
      return (input: unknown, options?: CallOptions) =>
        proxiedClient(serviceType).then(client => callOn(client)(input, options));
    },
  });

export const getRpcImpls = async () => {
  const penumbraProxies: RpcImplTuple<ServiceType>[] = [
    AppService,
    CompactBlockService,
    DexService,
    GovernanceService,
    IbcChannelService,
    IbcClientService,
    IbcConnectionService,
    ShieldedPoolService,
    SimulationService,
    FeeService,
  ].map(
    serviceType =>
      [
        serviceType,
        createProxyImpl(serviceType, lazyProxyClient(serviceType), noContextHandler),
      ] as const,
  );

  const rpcImpls: RpcImplTuple<ServiceType>[] = [
    // rpc local implementations
    [CustodyService, rethrowImplErrors(CustodyService, custodyImpl)],
    [SctService, rethrowImplErrors(SctService, sctImpl)],
    [StakeService, rethrowImplErrors(StakeService, stakeImpl)],
    [ViewService, rethrowImplErrors(ViewService, viewImpl)],
    // customized proxy
    [
      TendermintProxyService,
      rethrowImplErrors(
        TendermintProxyService,
        createProxyImpl(
          TendermintProxyService,
          lazyProxyClient(TendermintProxyService),
          noContextHandler,
        ),
      ),
    ],
    // simple proxies
    ...penumbraProxies.map(
      ([serviceType, impl]) =>
        [serviceType, rethrowImplErrors(serviceType, impl)] as [typeof serviceType, typeof impl],
    ),
  ] as const;

  return rpcImpls;
};
