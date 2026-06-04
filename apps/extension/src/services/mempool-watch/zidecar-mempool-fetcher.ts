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
 */
export interface MempoolStreamClient {
  getMempoolStream(): Promise<ReadonlyArray<{
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
      const blocks = await client.getMempoolStream();
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
      ctx.onStatus?.({ kind: 'error', error: err instanceof Error ? err.message : String(err) });
      throw err;
    }
  };
}
