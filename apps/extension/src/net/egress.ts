/**
 * The one egress point: every realm's `fetch`, `WebSocket` and `EventSource`
 * go through {@link decideEgress} before anything leaves the machine.
 *
 * Patched at the global, once per realm, by `./egress-install` (storage realms)
 * or `./egress-install-lite` (offscreen, workers, content scripts) as the first
 * import of every webpack entry - `egress-entries.test.ts` holds that line.
 * Globals rather than call sites because most callers are libraries
 * (connect-web transports, the block processors, the registry client) that
 * cannot be threaded a guard, and a global means a new dependency cannot open a
 * hole by forgetting to opt in.
 *
 * The decision is synchronous over a per-realm copy of the compiled table, so
 * a `new WebSocket(url)` can be refused in its constructor. Realms with
 * `chrome.storage` compile the table themselves and follow `onChanged`; realms
 * without it receive it over a BroadcastChannel from any realm that has
 * storage. Until a table arrives the realm fails closed: `fetch` waits a
 * moment for one, a socket is refused.
 *
 * A refusal throws {@link EgressBlockedError}, a TypeError so existing
 * network-error paths keep working, carrying the host, the destination and the
 * reason so the UI can say "zafu did not contact <host>" and offer to allow it.
 *
 * This file is bundled into every worker, so it imports only the table.
 */

import {
  decideEgress,
  decideRedirect,
  type EgressDecision,
  type EgressRealm,
  type EgressTable,
  type RequestClass,
} from './egress-table';
import { viaNym } from './nym-bridge';

export type EgressRefusal = Extract<EgressDecision, { allow: false }>;

/** what a request that could not reach nym says, by its class */
const NYM_DOWN: Record<RequestClass, string> = {
  broadcast: "nym isn't reachable right now. nothing was sent.",
  'own-tx': "couldn't load over nym · try again",
  'names-you': "couldn't reach this over nym · try again",
};

export class EgressBlockedError extends TypeError {
  override readonly name = 'EgressBlockedError';
  constructor(readonly refusal: EgressRefusal) {
    super(
      refusal.reason === 'transport-down'
        ? NYM_DOWN[refusal.nym ?? 'names-you']
        : `zafu did not contact ${refusal.host}`,
    );
  }
}

/** the class a cometbft JSON-RPC body names, if its rule reads bodies */
const classOfBody = (
  rows: [string, RequestClass][] | undefined,
  body: BodyInit | null | undefined,
): RequestClass | undefined => {
  const text =
    typeof body === 'string'
      ? body
      : body instanceof Uint8Array || body instanceof ArrayBuffer
        ? new TextDecoder().decode(body)
        : undefined;
  return text === undefined ? undefined : rows?.find(([p]) => new RegExp(p).test(text))?.[1];
};

export const isEgressBlocked = (e: unknown): e is EgressBlockedError =>
  e instanceof Error && e.name === 'EgressBlockedError';

/**
 * Same check, but walks a bounded `.cause` chain first. A ConnectError (the
 * penumbra/zcash transports' own error type) wraps whatever actually threw,
 * so the refusal is often one level down, not on the error the caller sees.
 */
export const isEgressBlockedCause = (e: unknown, depth = 0): boolean => {
  if (depth > 3 || e == null) {
    return false;
  }
  if (isEgressBlocked(e)) {
    return true;
  }
  return typeof e === 'object' && 'cause' in e
    ? isEgressBlockedCause((e as { cause: unknown }).cause, depth + 1)
    : false;
};

/**
 * allowed contacts per destination id (or host), how many of them went over
 * nym, and the latest time: counts, never urls
 */
export type ContactTally = Record<string, { n: number; nym: number; at: number }>;

type ChannelMessage =
  | { type: 'request' }
  | { type: 'table'; table: EgressTable }
  | { type: 'blocked'; refusal: EgressRefusal; realm: EgressRealm }
  | { type: 'contacted'; tally: ContactTally };

export interface EgressHost {
  /** storage realms: compile the table from storage */
  load?: () => Promise<EgressTable>;
  /** storage realms: call `reload` whenever an input changes */
  watch?: (reload: () => void) => void;
  /**
   * the service worker only: ask the user about a host no destination owns,
   * when the Keplr-compatible surface is on. Resolves true on approval.
   */
  askUnknown?: (url: string) => Promise<boolean>;
}

const CHANNEL = 'zafu-egress';
/** a runtime message: the service worker drops its unwritten contact counts (./contacted) */
export const CONTACTED_CLEAR = 'zafu_contacted_clear';
/** how long a realm gathers its contacts before handing them on as one message */
const TALLY_MS = 5000;
/** how long a realm waits for its first table before failing closed */
const READY_TIMEOUT_MS = 4000;

let realm: EgressRealm | undefined;
let table: EgressTable | undefined;
let markReady: (() => void) | undefined;
let ready: Promise<void> = Promise.resolve();
let channel: BroadcastChannel | undefined;
let reload: (() => Promise<void>) | undefined;
const listeners = new Set<(refusal: EgressRefusal, from: EgressRealm) => void>();
const contactListeners = new Set<(tally: ContactTally) => void>();
let tally: ContactTally = {};
let tallyTimer: ReturnType<typeof setTimeout> | undefined;

/** Subscribe to refusals from this realm and every realm on the channel. */
export const onEgressBlocked = (
  listener: (refusal: EgressRefusal, from: EgressRealm) => void,
): (() => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};

const emit = (refusal: EgressRefusal, from: EgressRealm): void => {
  for (const listener of listeners) {
    listener(refusal, from);
  }
};

/** Subscribe to batches of allowed contacts from this realm and every realm on the channel. */
export const onEgressContacted = (listener: (tally: ContactTally) => void): (() => void) => {
  contactListeners.add(listener);
  return () => void contactListeners.delete(listener);
};

const sendTally = (): void => {
  tallyTimer = undefined;
  const batch = tally;
  tally = {};
  for (const listener of contactListeners) {
    listener(batch);
  }
  channel?.postMessage({ type: 'contacted', tally: batch } satisfies ChannelMessage);
};

/**
 * A filter on every allowed request: one count in memory, handed on in
 * batches, so the hot path never waits and storage sees no write per request.
 * A device on this computer and urls without a host are not counted.
 */
const tallyContact = (id: string | undefined, overNym = false): void => {
  if (!id) {
    return;
  }
  const t = tally[id];
  tally[id] = { n: (t?.n ?? 0) + 1, nym: (t?.nym ?? 0) + Number(overNym), at: Date.now() };
  tallyTimer ??= setTimeout(sendTally, TALLY_MS);
};

const contactIdOf = (d: EgressDecision): string | undefined =>
  d.allow && d.host && (d.destination || table?.hosts[d.host] === 'allowed')
    ? (d.destination ?? d.host)
    : undefined;

const urlOf = (input: string | URL | Request): string =>
  typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

/** The decision for `input` in this realm, right now. */
export const checkEgress = (input: string | URL | Request): EgressDecision =>
  decideEgress(urlOf(input), realm ?? 'worker', table);

/** something sends over nym (any of `destinations`, when named), once this realm has its table */
export const nymRoutingOn = async (destinations: string[] = []): Promise<boolean> => {
  if (!table) {
    await waitForTable();
  }
  const via = table?.nymVia ?? [];
  return destinations.length ? destinations.some(d => via.includes(d)) : via.length > 0;
};

const tableListeners = new Set<(t: EgressTable) => void>();
/** every table this realm takes, from now on */
export const onEgressTable = (listener: (t: EgressTable) => void): (() => void) => {
  tableListeners.add(listener);
  return () => void tableListeners.delete(listener);
};

const refuse = (refusal: EgressRefusal): never => {
  emit(refusal, realm ?? 'worker');
  channel?.postMessage({
    type: 'blocked',
    refusal,
    realm: realm ?? 'worker',
  } satisfies ChannelMessage);
  throw new EgressBlockedError(refusal);
};

const enforce = (input: string | URL | Request): void => {
  const decision = checkEgress(input);
  if (!decision.allow) {
    refuse(decision);
  }
  tallyContact(contactIdOf(decision));
};

const publish = (next: EgressTable): void => {
  table = next;
  tableListeners.forEach(l => l(next));
  markReady?.();
  channel?.postMessage({ type: 'table', table: next } satisfies ChannelMessage);
};

/**
 * Recompile now instead of waiting for the storage event: a caller that just
 * turned a destination on awaits this before its first request.
 */
export const refreshEgress = (): Promise<void> => reload?.() ?? Promise.resolve();

const waitForTable = (): Promise<void> => {
  channel?.postMessage({ type: 'request' } satisfies ChannelMessage);
  // only realms with storage compile the table; a long-lived page (the
  // offscreen document) can outlive the service worker that holds it, so
  // wake it: any runtime message does, and on start it publishes the table
  if (realm !== 'content-script') {
    wakeServiceWorker();
  }
  return Promise.race([ready, new Promise<void>(r => setTimeout(r, READY_TIMEOUT_MS))]);
};

const wakeServiceWorker = (): void => {
  const runtime = (
    globalThis as { chrome?: { runtime?: { sendMessage?: (m: unknown) => Promise<unknown> } } }
  ).chrome?.runtime;
  void runtime?.sendMessage?.({ type: 'zafu_egress_wake' })?.catch(() => undefined);
};

export const installEgress = (where: EgressRealm, host: EgressHost = {}): void => {
  if (realm) {
    return;
  }
  realm = where;
  ready = new Promise<void>(r => (markReady = r));

  const nativeFetch = globalThis.fetch?.bind(globalThis);
  const send = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const response = await nativeFetch(input, init);
    // A followed redirect lands wherever the server says. The request itself
    // has already gone (a CSP connect-src cannot list user-chosen and LAN
    // nodes, so nothing stops the hop), but its answer never reaches the
    // caller unless the final url passes the same policy.
    if (response.redirected) {
      const landed = decideRedirect(urlOf(input), response.url, realm ?? 'worker', table);
      if (!landed.allow) {
        void response.body?.cancel().catch(() => undefined);
        refuse(landed);
      }
    }
    return response;
  };
  if (typeof nativeFetch === 'function') {
    globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
      if (!table) {
        await waitForTable();
      }
      const decision = checkEgress(input);
      if (!decision.allow) {
        const approved =
          decision.reason === 'unknown' && table?.adhoc && host.askUnknown
            ? await host.askUnknown(urlOf(input))
            : false;
        if (!approved) {
          refuse(decision);
        }
      }
      // counted by the way it actually went: a nym request that was refused
      // sent nothing, and a broadcast the user let go direct counts as direct
      const id = decision.allow ? contactIdOf(decision) : decision.host;
      let direct = false;
      const sendDirect = () => {
        direct = true;
        tallyContact(id);
        return send(input, init);
      };
      // a request that names you goes through nym, or nowhere
      const nym = decision.allow && (decision.nym ?? classOfBody(decision.nymBody, init?.body));
      if (decision.allow && nym) {
        const { host: h = '', destination } = decision;
        const res = await viaNym(input, init, nym, sendDirect, () =>
          refuse({ allow: false, host: h, destination, reason: 'transport-down', nym }),
        );
        if (!direct) {
          tallyContact(id, true);
        }
        return res;
      }
      return sendDirect();
    };
  }

  const NativeWebSocket = globalThis.WebSocket as typeof WebSocket | undefined;
  if (NativeWebSocket) {
    globalThis.WebSocket = class extends NativeWebSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        enforce(url);
        super(url, protocols);
      }
    };
  }

  const NativeEventSource = globalThis.EventSource as typeof EventSource | undefined;
  if (NativeEventSource) {
    globalThis.EventSource = class extends NativeEventSource {
      constructor(url: string | URL, init?: EventSourceInit) {
        enforce(url);
        super(url, init);
      }
    };
  }

  // Libraries that still use XHR (older cosmjs/axios paths) are refused at open().
  const xhr = globalThis.XMLHttpRequest?.prototype;
  // eslint-disable-next-line @typescript-eslint/unbound-method -- re-bound via .call below
  const nativeOpen = xhr?.open;
  if (xhr && nativeOpen) {
    xhr.open = function (
      this: XMLHttpRequest,
      method: string,
      url: string | URL,
      ...rest: unknown[]
    ) {
      enforce(url);
      // an xhr follows redirects too: drop the answer when it landed off-policy
      this.addEventListener('readystatechange', () => {
        if (
          this.readyState === XMLHttpRequest.HEADERS_RECEIVED &&
          this.responseURL &&
          !decideRedirect(String(url), this.responseURL, realm ?? 'worker', table).allow
        ) {
          this.abort();
        }
      });
      return (nativeOpen as (...a: unknown[]) => void).call(this, method, url, ...rest);
    } as typeof xhr.open;
  }

  // A content script never talks to anyone on the page's behalf: every
  // decision there is a refusal, with no table and no channel to wait on.
  if (host.load) {
    const load = host.load;
    reload = () =>
      load().then(publish, (e: unknown) =>
        console.error('[egress] could not compile the table:', e),
      );
  }
  if (where === 'content-script' || typeof BroadcastChannel === 'undefined') {
    markReady?.();
    void reload?.();
    return;
  }

  channel = new BroadcastChannel(CHANNEL);
  channel.onmessage = (ev: MessageEvent<ChannelMessage>) => {
    const msg = ev.data;
    // anyone holding a table answers, so a worker inside the offscreen
    // document is served by that document while the service worker sleeps
    if (msg.type === 'request' && table) {
      channel!.postMessage({ type: 'table', table } satisfies ChannelMessage);
    } else if (msg.type === 'table' && !host.load) {
      table = msg.table;
      tableListeners.forEach(l => l(msg.table));
      markReady?.();
    } else if (msg.type === 'blocked') {
      emit(msg.refusal, msg.realm);
    } else if (msg.type === 'contacted') {
      for (const listener of contactListeners) {
        listener(msg.tally);
      }
    }
  };

  if (reload) {
    void reload();
    host.watch?.(() => void reload?.());
  } else {
    channel.postMessage({ type: 'request' } satisfies ChannelMessage);
  }
};
