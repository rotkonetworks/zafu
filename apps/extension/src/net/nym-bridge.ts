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

/**
 * How long a request keeps trying routes. A broadcast that still has no
 * answer then waits {@link NYM_ANSWER_MS} for the person; both fit inside the
 * send screen's broadcast bound (send-watch, 4 min).
 */
export const NYM_BUDGET_MS = 150_000;
/** how long a held broadcast waits for the person's answer */
export const NYM_ANSWER_MS = 60_000;
/**
 * How long one try inside the tunnel may take before its route is dropped
 * (mixFetch has no timeout of its own). On a working route a broadcast
 * answers in about 6 s; on a bad exit it never does.
 */
export const NYM_REPLY_MS = 30_000;

export interface NymRequestInit {
  method: string;
  headers: Record<string, string>;
  body?: Uint8Array;
}

export type NymMessage =
  /** start if any of `via` (every destination when empty) sends over nym */
  | { type: 'start'; via?: string[] }
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
  /** `route`: the tunnel failed it, not the policy, so another route may carry it */
  | { type: 'failed'; id: string; message: string; route?: boolean }
  /** a request got no answer on this route: the host takes another */
  | { type: 'reroute'; id: string }
  /** a broadcast waits: nym was not reachable; `sent`, a try may have reached the node */
  | { type: 'held'; id: string; host: string; sent: boolean }
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
 * The tunnel is up, or on its way, if any of `via` (destination ids; every
 * one when none is named) sends over nym; otherwise nothing starts. The same
 * call whether nym is kept ready or started on demand. The service worker
 * makes sure the offscreen document exists; pages ask it to; a web worker
 * already lives inside it.
 */
export const ensureNym = async (...via: string[]): Promise<void> => {
  const chrome = (globalThis as { chrome?: Chrome }).chrome;
  await (
    chrome?.offscreen
      ? ensureOffscreenDocument()
      : chrome?.runtime?.sendMessage?.({ type: 'ZCASH_ENSURE_OFFSCREEN' })
  )?.catch(() => undefined);
  postNym({ type: 'start', via });
};

/** true once the tunnel is ready, false if it was not within `ms` or its start failed */
export const nymReady = async (ms: number): Promise<boolean> =>
  (await waitFor(
    m => (m.type !== 'state' ? undefined : m.ready ? true : m.down ? false : undefined),
    ms,
    () => void ensureNym().then(() => postNym({ type: 'ping' })),
  )) ?? false;

const flatten = async (
  input: string | URL | Request,
  init?: RequestInit,
): Promise<{ url: string; init: NymRequestInit }> => {
  // the caller's signal stays with viaNym: the tunnel has no way to cancel
  const req = new Request(input, init && { ...init, signal: null });
  const body = req.body ? new Uint8Array(await req.arrayBuffer()) : undefined;
  return {
    url: req.url,
    init: { method: req.method, headers: Object.fromEntries(req.headers), ...(body && { body }) },
  };
};

type Reply = Extract<NymMessage, { type: 'response' | 'failed' }>;

/** one try through the ready tunnel: its reply, or undefined after `ms` */
const exchange = (
  id: string,
  req: { url: string; init: NymRequestInit },
  ms: number,
): Promise<Reply | undefined> =>
  waitFor(
    m => ((m.type === 'response' || m.type === 'failed') && m.id === id ? m : undefined),
    ms,
    () => postNym({ type: 'fetch', id, ...req }),
  );

/** hold one broadcast until a zafu window answers; no answer is "don't send" */
export const askSendDirect = async (host: string, sent: boolean): Promise<boolean> => {
  const id = crypto.randomUUID();
  return (
    (await waitFor(
      m => (m.type === 'answer' && m.id === id ? m.direct : undefined),
      NYM_ANSWER_MS,
      () => postNym({ type: 'held', id, host, sent }),
    )) ?? false
  );
};

/**
 * The transport filter: `(req, next) => rep` around a request of a nym class.
 * Never sends directly on its own: only a broadcast the person chose to send
 * directly, this once, goes to `next`.
 */
export const viaNym = (
  input: string | URL | Request,
  init: RequestInit | undefined,
  cls: RequestClass,
  next: () => Promise<Response>,
  refuse: () => never,
): Promise<Response> => {
  // the tunnel cannot cancel a request, but the caller can stop waiting for it
  const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
  const run = route(input, init, cls, next, refuse, signal);
  return signal
    ? new Promise((resolve, reject) => {
        const abort = () => reject(signal.reason as Error);
        if (signal.aborted) {
          abort();
        }
        signal.addEventListener('abort', abort, { once: true });
        run.then(resolve, reject);
      })
    : run;
};

/**
 * Try routes until one answers or the budget is spent. Sending the same bytes
 * again is safe: every nym class is a read, or a broadcast the node keeps once.
 */
const route = async (
  input: string | URL | Request,
  init: RequestInit | undefined,
  cls: RequestClass,
  next: () => Promise<Response>,
  refuse: () => never,
  signal?: AbortSignal,
): Promise<Response> => {
  const req = await flatten(input, init);
  const deadline = Date.now() + NYM_BUDGET_MS;
  let sent = false;
  for (let left = NYM_BUDGET_MS; left > 0 && !signal?.aborted; left = deadline - Date.now()) {
    // down: the host already tried its routes
    if (!(await nymReady(left))) {
      break;
    }
    const id = crypto.randomUUID();
    sent = true;
    const reply = await exchange(id, req, Math.min(NYM_REPLY_MS, deadline - Date.now()));
    if (reply?.type === 'response') {
      return new Response(reply.status === 204 ? null : (reply.body as Uint8Array<ArrayBuffer>), {
        status: reply.status,
        statusText: reply.statusText,
        headers: reply.headers,
      });
    }
    if (reply && !reply.route) {
      throw new TypeError(reply.message);
    }
    postNym({ type: 'reroute', id });
  }
  if (
    cls === 'broadcast' &&
    !signal?.aborted &&
    (await askSendDirect(hostOf(req.url) ?? req.url, sent))
  ) {
    return next();
  }
  // it entered the tunnel, so it may still arrive: never "nothing was sent"
  if (sent) {
    throw new TypeError('nym did not answer in time · it may still arrive');
  }
  return refuse();
};
