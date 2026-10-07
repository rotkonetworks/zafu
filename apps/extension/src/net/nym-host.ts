/**
 * The nym tunnel, hosted by the offscreen document: one worker running
 * smolmix (`workers/nym-worker.ts`), answering every realm over the
 * {@link NYM_CHANNEL}.
 *
 * Started on intent (a send, swap or liquidity screen), when a proof starts,
 * or by the first request that needs it; never while nym is off. Stopped with
 * the last zafu window by terminating the worker: smolmix's own disconnect
 * leaves its wasm unusable, so each start is a fresh worker with a fresh,
 * throwaway client identity.
 */

import { wrap, type Remote } from 'comlink';
import type { IMixTunnelWorker } from '@nymproject/mix-tunnel';
import { checkEgress, EgressBlockedError, nymRoutingOn } from './egress';
import { NYM_CHANNEL, NYM_WORKER_NAME, type NymMessage, type NymRequestInit } from './nym-bridge';

const channel = new BroadcastChannel(NYM_CHANNEL);
const say = (m: NymMessage): void => channel.postMessage(m);

let worker: Worker | undefined;
let tunnel: Promise<Remote<IMixTunnelWorker>> | undefined;
let ready = false;
/** smolmix keeps its client key in IndexedDB under the client id: forgotten at stop */
let clientId: string | undefined;

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

/** start the tunnel if nym is on and it is not up; resolves once it is ready */
export const startNymTunnel = async (): Promise<void> => {
  if (!tunnel && !(await nymRoutingOn())) {
    return;
  }
  if (tunnel) {
    await tunnel.catch(() => undefined);
    return;
  }
  const t0 = performance.now();
  clientId = `zafu-${randomHex().slice(0, 16)}`;
  const id = clientId;
  tunnel = spawn().then(async t => {
    await t.setupMixTunnel({
      clientId: id,
      // the key is sealed with a passphrase nobody keeps
      storagePassphrase: randomHex(),
      forceTls: true,
      connectTimeoutMs: 30_000,
      maxRedirects: 0,
    });
    return t;
  });
  const mine = tunnel;
  try {
    await mine;
  } catch (e) {
    console.warn('[nym] the tunnel did not start:', e);
    if (tunnel === mine) {
      stopNymTunnel();
      say({ type: 'state', ready: false, down: true });
    }
    return;
  }
  // stopped while it started: the last window closed
  if (tunnel !== mine) {
    return;
  }
  ready = true;
  console.info(`[nym] ready in ${Math.round(performance.now() - t0)}ms`);
  say({ type: 'state', ready });
};

export const stopNymTunnel = (): void => {
  worker?.terminate();
  worker = undefined;
  tunnel = undefined;
  ready = false;
  if (clientId) {
    indexedDB.deleteDatabase(clientId);
    clientId = undefined;
  }
  say({ type: 'state', ready });
};

export const nymTunnelRunning = (): boolean => worker !== undefined;

const relay = async (id: string, url: string, init: NymRequestInit): Promise<void> => {
  try {
    if (!tunnel || !ready) {
      throw new TypeError('nym is not running');
    }
    // the tunnel carries only what the policy allows, whoever asks
    const decision = checkEgress(url);
    if (!decision.allow) {
      throw new EgressBlockedError(decision);
    }
    say({ type: 'response', id, ...(await (await tunnel).mixFetch(url, init)) });
  } catch (e) {
    say({ type: 'failed', id, message: e instanceof Error ? e.message : String(e) });
  }
};

const handlers: { [K in NymMessage['type']]?: (m: Extract<NymMessage, { type: K }>) => void } = {
  start: () => void startNymTunnel(),
  ping: () => say({ type: 'state', ready }),
  stop: stopNymTunnel,
  fetch: m => void relay(m.id, m.url, m.init),
};

channel.onmessage = (e: MessageEvent<NymMessage>) =>
  (handlers[e.data.type] as ((m: NymMessage) => void) | undefined)?.(e.data);
