/**
 * zidecarMempoolFetcher — one-shot snapshot fetcher backed by zidecar.
 *
 * yields exactly one MempoolSnapshot per call (the current zidecar
 * mempool stream returns the full current mempool as a list of compact
 * blocks with height=0). cadence (how often we poll) is layered on top
 * via withPoll. reconnect / backoff is layered on top via withReconnect.
 *
 * this is the only place that talks to the network in the service module.
 * keeping it narrow lets tests inject a fake `MempoolStreamClient`.
 */

import type {
  MempoolEntry,
  MempoolFetcher,
} from './types';

/**
 * Minimal client interface — exact shape of the relevant ZidecarClient
 * method. Allows tests to inject a fake without pulling the whole client.
 *
 * The optional `signal` is plumbed all the way to the underlying fetch so
 * an in-flight network round-trip can be cancelled mid-flight. Without it,
 * `stop-sync` would have to wait for the request to settle before the
 * watcher could observe the abort and return.
 */
export interface MempoolStreamClient {
  getMempoolStream(signal?: AbortSignal): Promise<ReadonlyArray<{
    readonly hash: Uint8Array;
    readonly actions: ReadonlyArray<{
      readonly nullifier: Uint8Array;
      readonly cmx: Uint8Array;
      readonly ephemeralKey: Uint8Array;
      readonly ciphertext: Uint8Array;
    }>;
  }>>;
}

export function zidecarMempoolFetcher(client: MempoolStreamClient): MempoolFetcher {
  return async function* (_walletId, ctx) {
    if (ctx.signal.aborted) return;
    ctx.onStatus?.({ kind: 'connecting' });
    try {
      // Plumb the abort signal through. If the caller aborts during the
      // round-trip, the fetch promise rejects with AbortError and we treat
      // it as a clean exit (no error status fired).
      const blocks = await client.getMempoolStream(ctx.signal);
      if (ctx.signal.aborted) return;
      ctx.onStatus?.({ kind: 'connected' });
      const entries: MempoolEntry[] = blocks.map(b => ({
        hash: b.hash,
        actions: b.actions.map(a => ({
          nullifier: a.nullifier,
          cmx: a.cmx,
          ephemeralKey: a.ephemeralKey,
          ciphertext: a.ciphertext,
        })),
      }));
      yield { entries, observedAtMs: Date.now() };
    } catch (err) {
      // Abort during the network call surfaces as DOMException 'AbortError'.
      // It's not a watcher error — the caller asked us to stop.
      if (ctx.signal.aborted) return;
      ctx.onStatus?.({ kind: 'error', error: err instanceof Error ? err.message : String(err) });
      throw err;
    }
  };
}
