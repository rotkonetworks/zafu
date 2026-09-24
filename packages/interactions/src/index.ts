/**
 * @zafu/interactions - the app side of asking a wallet for something.
 *
 * An interaction is any request the user has to act on in the wallet: connect,
 * sign, approve. Three things go wrong when every app hand-rolls these, and
 * this package fixes each once:
 *
 * 1. Double requests. A second click on "Connect" sent the wallet a second
 *    approval (a second side panel or popup), and whichever resolved last won.
 *    Here, a request with the same key JOINS the one already in flight.
 *
 * 2. Timers that lie. Apps gave the wallet 3-8 seconds and then showed "wallet
 *    didn't respond" - while the user was still typing their password. Here,
 *    nothing times out on the app side: after `slowAfterMs` the status becomes
 *    `slow` (a hint to say where to look), and the request keeps waiting for the
 *    wallet's real answer.
 *
 * 3. No state to render. Apps had nothing to show between click and answer.
 *    Here, every interaction has a status (`waiting` -> `slow` -> `done` |
 *    `failed`) you can subscribe to.
 *
 * Where the wallet shows the request (side panel, popup window) is the
 * wallet's decision, from its user's settings. Nothing here lets an app pick.
 *
 * Dependency-free: no chrome, no DOM, no wallet contract. It wraps any
 * `() => Promise<T>`; the zid SDK uses it around its wallet transport.
 */

export type InteractionStatus =
  /** sent to the wallet, no answer yet. */
  | 'waiting'
  /** still no answer after `slowAfterMs`: say where to look, keep waiting. */
  | 'slow'
  /** the wallet answered and the request succeeded. */
  | 'done'
  /** the request failed (the user declined, the wallet is locked, no wallet...). */
  | 'failed';

export interface Interaction<T> {
  /** what identifies "the same request"; see {@link interactionKey}. */
  readonly key: string;
  /** the current status. */
  readonly status: InteractionStatus;
  /** the wallet's answer. Rejects with whatever the request threw. */
  readonly result: Promise<T>;
  /**
   * Call `listener` now with the current status and on every change. Returns an
   * unsubscribe function. Listeners are dropped once the interaction settles.
   */
  subscribe(listener: (status: InteractionStatus) => void): () => void;
}

export interface InteractionOptions {
  /** ms of silence before status turns `slow`. Default 15000. Never a timeout. */
  slowAfterMs?: number;
  /** shorthand for `subscribe(onStatus)` on the returned interaction. */
  onStatus?: (status: InteractionStatus) => void;
}

export const DEFAULT_SLOW_AFTER_MS = 15_000;

const inFlight = new Map<string, Interaction<unknown>>();

/**
 * Start an interaction, or join the one already in flight under `key`.
 *
 * `run` is called only when nothing is in flight for `key`; a joined call's
 * `run` is ignored and its caller gets the existing interaction (its
 * `onStatus`, if any, is subscribed to it). The entry is removed as soon as the
 * interaction settles, so the next call starts a fresh request.
 *
 * ```ts
 * const connecting = interaction('connect', () => wallet.connect(), {
 *   onStatus: s => (button.textContent = s === 'slow'
 *     ? 'Approve in your wallet (click its toolbar icon)'
 *     : 'Approve in your wallet...'),
 * });
 * await connecting.result;
 * ```
 */
export function interaction<T>(
  key: string,
  run: () => Promise<T>,
  opts: InteractionOptions = {},
): Interaction<T> {
  const existing = inFlight.get(key) as Interaction<T> | undefined;
  if (existing) {
    if (opts.onStatus) {
      existing.subscribe(opts.onStatus);
    }
    return existing;
  }

  let status: InteractionStatus = 'waiting';
  const listeners = new Set<(s: InteractionStatus) => void>();
  const setStatus = (next: InteractionStatus) => {
    if (status === next) {
      return;
    }
    status = next;
    for (const listener of [...listeners]) {
      notify(listener, next);
    }
  };

  const slowTimer = setTimeout(() => {
    if (status === 'waiting') {
      setStatus('slow');
    }
  }, opts.slowAfterMs ?? DEFAULT_SLOW_AFTER_MS);

  // Run on a microtask so a synchronous throw inside `run` becomes a rejection
  // of `result`, like any other failure, instead of escaping this call.
  const result = Promise.resolve()
    .then(run)
    .then(
      value => {
        settle('done');
        return value;
      },
      (error: unknown) => {
        settle('failed');
        throw error;
      },
    );

  function settle(final: InteractionStatus) {
    clearTimeout(slowTimer);
    inFlight.delete(key);
    setStatus(final);
    listeners.clear();
  }

  const created: Interaction<T> = {
    key,
    get status() {
      return status;
    },
    result,
    subscribe(listener) {
      notify(listener, status);
      if (status === 'done' || status === 'failed') {
        return () => undefined;
      }
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };

  inFlight.set(key, created as Interaction<unknown>);
  if (opts.onStatus) {
    created.subscribe(opts.onStatus);
  }
  return created;
}

/** The interaction in flight under `key`, if any. */
export function currentInteraction(key: string): Interaction<unknown> | undefined {
  return inFlight.get(key);
}

/**
 * A stable key for "the same request": the parts, JSON-encoded with object keys
 * sorted, so `{ a, b }` and `{ b, a }` collide as they should. Binary data is
 * encoded as hex.
 *
 * ```ts
 * interactionKey('zafu_sign', { challengeHex, statement })
 * ```
 */
export function interactionKey(...parts: unknown[]): string {
  return JSON.stringify(parts, (_k, value: unknown) => {
    if (value instanceof Uint8Array) {
      return { u8: Array.from(value, b => b.toString(16).padStart(2, '0')).join('') };
    }
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return Object.fromEntries(
        Object.keys(value as Record<string, unknown>)
          .sort()
          .map(k => [k, (value as Record<string, unknown>)[k]]),
      );
    }
    return value;
  });
}

const notify = (listener: (s: InteractionStatus) => void, status: InteractionStatus) => {
  try {
    listener(status);
  } catch {
    // a throwing UI callback must not break the interaction or other listeners
  }
};
