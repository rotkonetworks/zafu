/**
 * The one way any realm reaches the nym tunnel, which lives in the offscreen
 * document (`./nym-host`): a BroadcastChannel, so the popup, the zcash worker
 * and the service worker all speak to it the same way.
 *
 * {@link viaNym} is the transport filter the egress guard wraps around a
 * request of a nym class: wait for the tunnel (bounded), send through it, or
 * fail closed. A broadcast that could not reach nym is held while a zafu
 * window offers to send it directly instead, this once.
 *
 * Bundled into every worker: no imports beyond the table's and the
 * service worker's offscreen-document call.
 */

import { hostOf } from './destination';
import { ensureOffscreenDocument } from '../offscreen-document';
import type { RequestClass } from './egress-table';

/** the nym destination: "send over nym" is on unless the person blocks it (`optIns.nym`) */
export const NYM = 'nym';
export const NYM_CHANNEL = 'zafu-nym';
/** the tunnel worker's name: its egress realm is `nym` */
export const NYM_WORKER_NAME = 'zafu-nym';

/** how long a request waits for the tunnel before it is refused */
export const NYM_READY_MS = 60_000;
/** how long a held broadcast waits for the person's answer */
// with the wait for nym it stays inside the send screen's broadcast bound (3 min)
export const NYM_ANSWER_MS = 90_000;
/** how long a request inside the tunnel may take (mixFetch has no timeout of its own) */
export const NYM_REPLY_MS = 90_000;

export interface NymRequestInit {
  method: string;
  headers: Record<string, string>;
  body?: Uint8Array;
}

export type NymMessage =
  | { type: 'start' }
  | { type: 'stop' }
  | { type: 'ping' }
  /** `down`: the last start failed, so a waiting request need not wait out its bound */
  | { type: 'state'; ready: boolean; down?: boolean }
  | { type: 'fetch'; id: string; url: string; init: NymRequestInit }
  | {
      type: 'response';
      id: string;
      status: number;
      statusText: string;
      headers: [string, string][];
      body: Uint8Array;
    }
  | { type: 'failed'; id: string; message: string }
  /** a broadcast waits: nym was not reachable */
  | { type: 'held'; id: string; host: string }
  /** the person's answer for that one broadcast */
  | { type: 'answer'; id: string; direct: boolean };

let channel: BroadcastChannel | undefined;
const listeners = new Set<(m: NymMessage) => void>();

const bus = (): BroadcastChannel => {
  if (!channel) {
    channel = new BroadcastChannel(NYM_CHANNEL);
    channel.onmessage = (e: MessageEvent<NymMessage>) => listeners.forEach(l => l(e.data));
  }
  return channel;
};

export const onNymMessage = (listener: (m: NymMessage) => void): (() => void) => {
  bus();
  listeners.add(listener);
  return () => void listeners.delete(listener);
};

/** to every realm on the channel, this one included (a channel never hears itself) */
export const postNym = (m: NymMessage): void => {
  bus().postMessage(m);
  queueMicrotask(() => listeners.forEach(l => l(m)));
};

/** the first message `pick` accepts within `ms`, or undefined; `send` runs once listening */
const waitFor = <T>(
  pick: (m: NymMessage) => T | undefined,
  ms: number,
  send: () => void,
): Promise<T | undefined> =>
  new Promise(resolve => {
    const off = onNymMessage(m => {
      const v = pick(m);
      if (v !== undefined) {
        clearTimeout(timer);
        off();
        resolve(v);
      }
    });
    const timer = setTimeout(() => {
      off();
      resolve(undefined);
    }, ms);
    send();
  });

interface Chrome {
  offscreen?: unknown;
  runtime?: { sendMessage?: (m: unknown) => Promise<unknown> };
}

/**
 * Start the tunnel if it is not up (the host ignores this while nym is off).
 * The service worker makes sure the offscreen document exists; pages ask it
 * to; a web worker already lives inside it.
 */
export const startNym = async (): Promise<void> => {
  const chrome = (globalThis as { chrome?: Chrome }).chrome;
  await (
    chrome?.offscreen
      ? ensureOffscreenDocument()
      : chrome?.runtime?.sendMessage?.({ type: 'ZCASH_ENSURE_OFFSCREEN' })
  )?.catch(() => undefined);
  postNym({ type: 'start' });
};

/** true once the tunnel is ready, false if it was not within `ms` */
export const nymReady = async (ms = NYM_READY_MS): Promise<boolean> =>
  (await waitFor(
    m => (m.type !== 'state' ? undefined : m.ready ? true : m.down ? false : undefined),
    ms,
    () => void startNym().then(() => postNym({ type: 'ping' })),
  )) ?? false;

const flatten = async (
  input: string | URL | Request,
  init?: RequestInit,
): Promise<{ url: string; init: NymRequestInit }> => {
  const req = new Request(input, init);
  const body = req.body ? new Uint8Array(await req.arrayBuffer()) : undefined;
  return {
    url: req.url,
    init: { method: req.method, headers: Object.fromEntries(req.headers), ...(body && { body }) },
  };
};

/** one request through the tunnel; the tunnel must be ready */
export const nymFetch = async (
  input: string | URL | Request,
  init?: RequestInit,
): Promise<Response> => {
  const id = crypto.randomUUID();
  const req = await flatten(input, init);
  const reply = await waitFor(
    m => ((m.type === 'response' || m.type === 'failed') && m.id === id ? m : undefined),
    NYM_REPLY_MS,
    () => postNym({ type: 'fetch', id, ...req }),
  );
  // it entered the tunnel, so it may still arrive: never "nothing was sent"
  if (!reply) {
    throw new TypeError('nym did not answer in time · it may still arrive');
  }
  if (reply.type === 'failed') {
    throw new TypeError(reply.message);
  }
  return new Response(reply.status === 204 ? null : (reply.body as Uint8Array<ArrayBuffer>), {
    status: reply.status,
    statusText: reply.statusText,
    headers: reply.headers,
  });
};

/** hold one broadcast until a zafu window answers; no answer is "don't send" */
export const askSendDirect = async (host: string): Promise<boolean> => {
  const id = crypto.randomUUID();
  return (
    (await waitFor(
      m => (m.type === 'answer' && m.id === id ? m.direct : undefined),
      NYM_ANSWER_MS,
      () => postNym({ type: 'held', id, host }),
    )) ?? false
  );
};

/**
 * The transport filter: `(req, next) => rep` around a request of a nym class.
 * Never sends directly on its own: only a broadcast the person chose to send
 * directly, this once, goes to `next`.
 */
export const viaNym = async (
  input: string | URL | Request,
  init: RequestInit | undefined,
  cls: RequestClass,
  next: () => Promise<Response>,
  refuse: () => never,
): Promise<Response> => {
  if (await nymReady()) {
    return nymFetch(input, init);
  }
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (cls === 'broadcast' && (await askSendDirect(hostOf(url) ?? url))) {
    return next();
  }
  return refuse();
};
