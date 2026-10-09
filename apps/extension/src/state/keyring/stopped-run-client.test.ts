/**
 * A sync run's node client is bound to the run: once the run is stopped
 * (the last window closed, or the wallet locked), the request in flight ends
 * and the rest of the pass sends nothing.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startRun, stopRun, type RunSlot } from '../../workers/sync-runs';
import { zcashClient, type ZcashBackend } from './zcash-backend';

/** a node that never answers, like one that timed out: only an abort ends a request */
const silentNode = () => {
  const asked: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(
      (url: string, init: RequestInit) =>
        new Promise((_, reject) => {
          if (init.signal?.aborted) {
            reject(new DOMException('aborted', 'AbortError'));
            return;
          }
          asked.push(url.split('/').pop()!);
          init.signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          );
        }),
    ),
  );
  return asked;
};

afterEach(() => vi.unstubAllGlobals());

describe.each<ZcashBackend>(['zidecar', 'lightwalletd'])('a stopped sync run (%s)', backend => {
  it('ends the request in flight and sends nothing more, with no retry', async () => {
    const asked = silentNode();
    const slot: RunSlot = {};
    let ended = false;
    void startRun(
      slot,
      async signal => {
        const client = zcashClient('https://zcash.example', backend, signal);
        // a pass: one request after another, and a retry of the first on failure
        for (let tries = 0; tries < 3; tries++) {
          try {
            await client.getTip();
            await client.getTreeState(1);
            await client.getSubtreeRoots('orchard', 0);
          } catch {
            // the run's own retries check the signal before the next try
          }
        }
      },
      () => (ended = true),
    );
    await vi.waitFor(() => expect(asked).toHaveLength(1));
    await stopRun(slot, 1_000);
    expect(ended).toBe(true);
    // the rest of the pass and its retries reached fetch only with an aborted signal
    expect(asked).toHaveLength(1);
  });
});
