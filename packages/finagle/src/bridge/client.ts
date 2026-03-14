import type { Service, StreamingService } from '../types';
import type { MessagePort, CallEnvelope } from './types';
import { isReplyEnvelope, isProgressEnvelope } from './types';

let nextId = 0;
const callId = () => `f_${++nextId}_${Date.now().toString(36)}`;

/**
 * Create a remote service proxy that sends requests over a MessagePort.
 *
 * Calls are fully async — the returned promise resolves when the worker
 * replies with a matching `callId`, or rejects on error/timeout.
 */
export function createClient<Req, Rep>(
  port: MessagePort,
  serviceName: string,
): Service<Req, Rep> {
  return (req: Req) =>
    new Promise<Rep>((resolve, reject) => {
      const id = callId();

      const handler = (e: MessageEvent) => {
        const msg = e.data;
        if (!isReplyEnvelope(msg) || msg.callId !== id) return;
        port.removeEventListener('message', handler);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result as Rep);
      };

      port.addEventListener('message', handler);

      const envelope: CallEnvelope = {
        __finagle: true,
        callId: id,
        serviceName,
        request: req,
      };
      port.postMessage(envelope);
    });
}

/**
 * Create a streaming remote service proxy.
 *
 * Like `createClient`, but the caller provides an `emit` callback that
 * receives `ProgressEnvelope` payloads as they arrive. The promise
 * resolves with the final reply.
 */
export function createStreamingClient<Req, Progress, Rep>(
  port: MessagePort,
  serviceName: string,
): StreamingService<Req, Progress, Rep> {
  return (req: Req, emit: (progress: Progress) => void) =>
    new Promise<Rep>((resolve, reject) => {
      const id = callId();

      const handler = (e: MessageEvent) => {
        const msg = e.data;
        if (
          typeof msg !== 'object' ||
          msg === null ||
          !('__finagle' in msg) ||
          msg.callId !== id
        )
          return;

        if (isProgressEnvelope(msg)) {
          emit(msg.progress as Progress);
          return;
        }

        if (isReplyEnvelope(msg)) {
          port.removeEventListener('message', handler);
          if (msg.error) reject(new Error(msg.error.message));
          else resolve(msg.result as Rep);
        }
      };

      port.addEventListener('message', handler);

      const envelope: CallEnvelope = {
        __finagle: true,
        callId: id,
        serviceName,
        request: req,
      };
      port.postMessage(envelope);
    });
}
