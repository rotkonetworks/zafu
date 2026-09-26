import { createClient as createPromiseClient, Client, Transport } from '@connectrpc/connect';
import { createGrpcWebTransport } from '@connectrpc/connect-web';
import { ServiceType } from '@bufbuild/protobuf';

/**
 * `transport` overrides the default gRPC-Web one - dependency injection for
 * unit tests (an in-memory router transport), the same seam
 * `apps/extension/src/hooks/latest-block-height.ts` exposes for the same reason.
 */
export const createClient = <T extends ServiceType>(
  grpcEndpoint: string,
  serviceType: T,
  transport: Transport = createGrpcWebTransport({ baseUrl: grpcEndpoint }),
): Client<T> => createPromiseClient(serviceType, transport);
