/**
 * A connect client for services hosted in this same script (the service
 * worker's custody, stake and internal view clients), over a MessageChannel.
 *
 * Replaces `@penumbra-zone/transport-dom/direct`, whose port logged
 * "Unknown message event [object MessageEvent]" for every message that was
 * not a request. The common one is benign: the channel transport posts
 * `{ requestId, abort: true }` when a caller's signal aborts (a sync stop, a
 * closed view, a timeout); it now aborts the running call through the
 * entry's signal, quietly. Anything else is logged once per kind, by what it
 * is, never as an object.
 */

import type { ServiceType } from '@bufbuild/protobuf';
import { ConnectError, createClient, type Client } from '@connectrpc/connect';
import { errorToJson } from '@connectrpc/connect/protocol-connect';
import type { ChannelHandlerFn } from '@penumbra-zone/transport-dom/adapter';
import {
  createChannelTransport,
  type ChannelTransportOptions,
} from '@penumbra-zone/transport-dom/create';
import {
  isTransportAbort,
  isTransportMessage,
  isTransportStream,
  type TransportMessage,
} from '@penumbra-zone/transport-dom/messages';

/** what an unexpected message is, in a few words, for one log line */
export const describeMessage = (data: unknown): string => {
  if (isTransportStream(data)) {
    return 'a streaming request (unsupported here)';
  }
  if (data && typeof data === 'object') {
    const keys = Object.keys(data).slice(0, 5).join(', ');
    return `an object with ${keys || 'no keys'}`;
  }
  return `a ${typeof data}`;
};

const warned = new Set<string>();

export const directGetPort =
  (entry: ChannelHandlerFn, jsonOptions: ChannelTransportOptions['jsonOptions']) =>
  (): Promise<MessagePort> => {
    const { port1: servicePort, port2: clientPort } = new MessageChannel();
    const running = new Map<string, AbortController>();
    const handle = async ({ requestId, message }: TransportMessage) => {
      const ctrl = new AbortController();
      running.set(requestId, ctrl);
      const response = await entry(message, ctrl.signal)
        .then(
          r => (r instanceof ReadableStream ? { requestId, stream: r } : { requestId, message: r }),
          (error: unknown) => ({
            requestId,
            error: errorToJson(ConnectError.from(error), jsonOptions),
          }),
        )
        .finally(() => running.delete(requestId));
      if ('stream' in response && response.stream) {
        servicePort.postMessage(response, [response.stream]);
      } else {
        servicePort.postMessage(response);
      }
    };
    servicePort.addEventListener('message', (ev: MessageEvent<unknown>) => {
      if (isTransportMessage(ev.data)) {
        void handle(ev.data);
      } else if (isTransportAbort(ev.data)) {
        // the caller gave up (a sync stop, a closed view, a timeout): pass it on
        running.get(ev.data.requestId)?.abort('caller aborted');
      } else {
        const what = describeMessage(ev.data);
        if (!warned.has(what)) {
          warned.add(what);
          console.warn(`[direct-client] ignored ${ev.type} event: ${what}`);
        }
      }
    });
    servicePort.start();
    return Promise.resolve(clientPort);
  };

export const createDirectClient = <S extends ServiceType>(
  serviceType: S,
  entry: ChannelHandlerFn,
  transportOptions: Omit<ChannelTransportOptions, 'getPort'>,
): Client<S> =>
  createClient(
    serviceType,
    createChannelTransport({
      ...transportOptions,
      getPort: directGetPort(entry, transportOptions.jsonOptions),
    }),
  );
