/** Wire envelope for cross-boundary service calls. */
export interface CallEnvelope {
  __finagle: true;
  callId: string;
  serviceName: string;
  request: unknown;
}

/** Wire envelope for service replies. */
export interface ReplyEnvelope {
  __finagle: true;
  callId: string;
  result?: unknown;
  error?: { message: string };
}

/** Wire envelope for streaming progress. */
export interface ProgressEnvelope {
  __finagle: true;
  callId: string;
  progress: unknown;
}

export function isCallEnvelope(msg: unknown): msg is CallEnvelope {
  return (
    typeof msg === 'object' &&
    msg !== null &&
    '__finagle' in msg &&
    'serviceName' in msg &&
    'request' in msg
  );
}

export function isReplyEnvelope(msg: unknown): msg is ReplyEnvelope {
  return (
    typeof msg === 'object' &&
    msg !== null &&
    '__finagle' in msg &&
    'callId' in msg &&
    !('serviceName' in msg) &&
    !('progress' in msg)
  );
}

export function isProgressEnvelope(msg: unknown): msg is ProgressEnvelope {
  return (
    typeof msg === 'object' &&
    msg !== null &&
    '__finagle' in msg &&
    'progress' in msg
  );
}

/** Minimal port interface — works with Worker, MessagePort, BroadcastChannel. */
export interface MessagePort {
  postMessage(msg: unknown): void;
  addEventListener(type: 'message', fn: (e: MessageEvent) => void): void;
  removeEventListener(type: 'message', fn: (e: MessageEvent) => void): void;
}
