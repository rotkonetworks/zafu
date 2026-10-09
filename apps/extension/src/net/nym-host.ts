/**
 * The nym tunnel, hosted by the offscreen document: one worker running
 * smolmix (`workers/nym-worker.ts`), answering every realm over the
 * {@link NYM_CHANNEL}.
 *
 * Started and stopped by the service worker's plan (`./nym-lifecycle`), by a
 * send, swap or liquidity screen, or by the first request that needs it;
 * never for a destination that goes direct. Stopped by terminating the
 * worker: smolmix's own disconnect
 * leaves its wasm unusable, so each start is a fresh worker with a fresh,
 * throwaway client identity.
 *
 * A route (entry gateway and exit) that stalls is dropped, not waited on: a
 * start that is not ready within {@link START_MS} is tried again from a fresh
 * worker, which picks its own gateway and exit, and a request that got no
 * answer may ask for a fresh route (`reroute`).
 */

import { wrap, type Remote } from 'comlink';
import type { IMixTunnelWorker } from '@nymproject/mix-tunnel';
import { checkEgress, EgressBlockedError, nymRoutingOn } from './egress';
import {
  NYM_CHANNEL,
  NYM_MAY_START,
  NYM_WORKER_NAME,
  type NymMessage,
  type NymRequestInit,
} from './nym-bridge';

const channel = new BroadcastChannel(NYM_CHANNEL);
const say = (m: NymMessage): void => channel.postMessage(m);

/** one start: a stuck gateway registration or exit handshake is dropped after this */
export const START_MS = 40_000;
/** starts in a row before the tunnel says it is down */
export const START_TRIES = 3;
/** smolmix keeps its client key in IndexedDB under this prefix and the id: forgotten at drop */
const NYM_DB = 'wasm-client-storage-';

let worker: Worker | undefined;
let clientId: string | undefined;
/** the ready tunnel */
let tunnel: Remote<IMixTunnelWorker> | undefined;
let starting: Promise<void> | undefined;
/** starts still asking whether they may: none of them is a "down" yet */
let asking = 0;
/** bumped by a stop: a start that was overtaken gives up */
let generation = 0;
/** requests inside the tunnel: a dropped route answers them as failed, so their callers retry */
const inFlight = new Set<string>();
/** no longer kept ready: stop once the last request inside has its answer */
let idleStop = false;

const spawn = (): Promise<Remote<IMixTunnelWorker>> =>
  new Promise((resolve, reject) => {
    const w = new Worker('workers/nym-worker.js', { name: NYM_WORKER_NAME });
    worker = w;
    w.addEventListener(
      'message',
      (e: MessageEvent<{ kind?: string }>) =>
        e.data?.kind === 'Loaded'
          ? resolve(wrap<IMixTunnelWorker>(w))
          : reject(new Error('the nym worker did not load')),
      { once: true },
    );
    w.addEventListener('error', e => reject(new Error(e.message)), { once: true });
  });

const randomHex = (): string =>
  Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, '0')).join(
    '',
  );

/** end this route: its worker, its identity, and every request still inside it */
const drop = (): void => {
  worker?.terminate();
  worker = undefined;
  tunnel = undefined;
  if (clientId) {
    indexedDB.deleteDatabase(NYM_DB + clientId);
    clientId = undefined;
  }
  inFlight.forEach(id => say({ type: 'failed', id, message: 'nym changed route', route: true }));
  inFlight.clear();
};

/** one fresh worker and identity: smolmix picks its own gateway and exit */
const startOnce = async (): Promise<Remote<IMixTunnelWorker> | undefined> => {
  const id = `zafu-${randomHex().slice(0, 16)}`;
  clientId = id;
  // an identity a closed browser never got to forget
  void indexedDB
    .databases?.()
    .then(dbs =>
      dbs.forEach(
        ({ name }) =>
          name?.startsWith(NYM_DB) && name !== NYM_DB + id && indexedDB.deleteDatabase(name),
      ),
    );
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const t = await spawn();
    await Promise.race([
      t.setupMixTunnel({
        clientId: id,
        // the key is sealed with a passphrase nobody keeps
        storagePassphrase: randomHex(),
        forceTls: true,
        // the exit handshake answers in a few seconds when it answers at all
        connectTimeoutMs: 15_000,
        // a lookup answers in 1-2 s; a lost one waited 30 s for the next resolver
        dnsTimeoutMs: 5_000,
        maxRedirects: 0,
      }),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`not ready in ${START_MS}ms`)), START_MS);
      }),
    ]);
    return t;
  } catch (e) {
    console.warn('[nym] this route did not start:', e instanceof Error ? e.message : e);
    return undefined;
  } finally {
    clearTimeout(timer);
  }
};

/** the service worker's plan allows a start (not locked, nym on); no answer is no */
const planAllows = async (): Promise<boolean> => {
  try {
    return (await chrome.runtime.sendMessage({ type: NYM_MAY_START })) === true;
  } catch {
    return false;
  }
};

/** start the tunnel if any of `via` sends over nym and it is not up; resolves once it is ready or down */
export const startNymTunnel = async (why = 'asked', via: string[] = []): Promise<void> => {
  // asked for again: whatever wanted it gone has been overtaken
  idleStop = false;
  if (tunnel) {
    return;
  }
  asking++;
  let allowed = false;
  try {
    allowed = !starting && (await nymRoutingOn(via)) && (await planAllows());
  } finally {
    asking--;
  }
  // another start may be asking or under way: it speaks for the tunnel
  if (!allowed && !tunnel && !starting && asking === 0) {
    // a request already waiting for the tunnel fails now, not at the end of its bound
    say({ type: 'state', ready: false, down: true });
    return;
  }
  if (allowed && !tunnel && !starting) {
    console.info(`[nym] starting: ${why}`);
    const gen = generation;
    const t0 = performance.now();
    starting = (async () => {
      for (let n = 1; n <= START_TRIES; n++) {
        const t = await startOnce();
        if (gen !== generation) {
          return;
        }
        if (t) {
          tunnel = t;
          console.info(`[nym] ready in ${Math.round(performance.now() - t0)}ms (route ${n})`);
          say({ type: 'state', ready: true });
          return;
        }
        drop();
      }
      say({ type: 'state', ready: false, down: true });
    })().finally(() => {
      if (gen === generation) {
        starting = undefined;
      }
    });
  }
  await starting;
};

export const stopNymTunnel = (): void => {
  idleStop = false;
  generation++;
  starting = undefined;
  drop();
  say({ type: 'state', ready: false });
};

/** stop now if nothing is inside or starting, else once the last request inside is answered */
const stopWhenIdle = (): void => {
  if (inFlight.size === 0 && !starting) {
    stopNymTunnel();
    return;
  }
  idleStop = true;
};

/** a request inside this tunnel got no answer: drop the route and take a fresh one */
const reroute = (id: string): void => {
  if (inFlight.has(id)) {
    console.info('[nym] no answer on this route, taking another');
    stopNymTunnel();
    void startNymTunnel('reroute');
  }
};

/** a tunnel up or on its way: the offscreen document stays */
export const nymTunnelRunning = (): boolean => worker !== undefined || starting !== undefined;

const relay = async (id: string, url: string, init: NymRequestInit): Promise<void> => {
  // the tunnel carries only what the policy allows, whoever asks
  const decision = checkEgress(url);
  if (!decision.allow) {
    say({ type: 'failed', id, message: new EgressBlockedError(decision).message });
    return;
  }
  if (!tunnel) {
    say({ type: 'failed', id, message: 'nym is not running', route: true });
    return;
  }
  const used = tunnel;
  inFlight.add(id);
  try {
    const reply = await used.mixFetch(url, init);
    if (inFlight.delete(id)) {
      say({ type: 'response', id, ...reply });
    }
    if (idleStop && inFlight.size === 0) {
      stopNymTunnel();
    }
  } catch (e) {
    if (inFlight.delete(id)) {
      say({ type: 'failed', id, message: e instanceof Error ? e.message : String(e), route: true });
    }
    // a try this route failed outright: the caller's next try gets a fresh one
    if (tunnel === used) {
      stopNymTunnel();
      void startNymTunnel('failed try');
    }
  }
};

const handlers: { [K in NymMessage['type']]?: (m: Extract<NymMessage, { type: K }>) => void } = {
  start: m => void startNymTunnel(m.via?.join(' ') || 'asked', m.via),
  ping: () => say({ type: 'state', ready: !!tunnel }),
  stop: m => (m.idle ? stopWhenIdle() : stopNymTunnel()),
  reroute: m => reroute(m.id),
  fetch: m => void relay(m.id, m.url, m.init),
};

channel.onmessage = (e: MessageEvent<NymMessage>) =>
  (handlers[e.data.type] as ((m: NymMessage) => void) | undefined)?.(e.data);
