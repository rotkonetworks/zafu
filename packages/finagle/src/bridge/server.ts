import type { Service, StreamingService } from '../types';
import type { MessagePort, ReplyEnvelope, ProgressEnvelope } from './types';
import { isCallEnvelope } from './types';

type AnyService = Service<unknown, unknown>;
type AnyStreamingService = StreamingService<unknown, unknown, unknown>;

interface RegisteredService {
  handler: AnyService | AnyStreamingService;
  streaming: boolean;
}

/**
 * A worker-side server that dispatches incoming `CallEnvelope`s to
 * registered services and sends replies back over the port.
 *
 * Usage:
 *   const server = createServer(self);          // `self` in a Worker
 *   server.register('scan', scanService);
 *   server.registerStreaming('sync', syncService);
 */
export interface WorkerServer {
  /** Register a request→response service. */
  register<Req, Rep>(name: string, service: Service<Req, Rep>): void;

  /** Register a streaming service that can emit progress. */
  registerStreaming<Req, Progress, Rep>(
    name: string,
    service: StreamingService<Req, Progress, Rep>,
  ): void;

  /** Stop listening and clear all registrations. */
  close(): void;
}

export function createServer(port: MessagePort): WorkerServer {
  const services = new Map<string, RegisteredService>();

  const handler = async (e: MessageEvent) => {
    const msg = e.data;
    if (!isCallEnvelope(msg)) return;

    const { callId, serviceName, request } = msg;
    const entry = services.get(serviceName);

    if (!entry) {
      const reply: ReplyEnvelope = {
        __finagle: true,
        callId,
        error: { message: `unknown service: ${serviceName}` },
      };
      port.postMessage(reply);
      return;
    }

    try {
      let result: unknown;

      if (entry.streaming) {
        const emit = (progress: unknown) => {
          const prog: ProgressEnvelope = {
            __finagle: true,
            callId,
            progress,
          };
          port.postMessage(prog);
        };
        result = await (entry.handler as AnyStreamingService)(request, emit);
      } else {
        result = await (entry.handler as AnyService)(request);
      }

      const reply: ReplyEnvelope = { __finagle: true, callId, result };
      port.postMessage(reply);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : String(err);
      const reply: ReplyEnvelope = {
        __finagle: true,
        callId,
        error: { message },
      };
      port.postMessage(reply);
    }
  };

  port.addEventListener('message', handler);

  return {
    register(name, service) {
      services.set(name, { handler: service as AnyService, streaming: false });
    },
    registerStreaming(name, service) {
      services.set(name, {
        handler: service as AnyStreamingService,
        streaming: true,
      });
    },
    close() {
      port.removeEventListener('message', handler);
      services.clear();
    },
  };
}
