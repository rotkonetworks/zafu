/**
 * The offscreen parallel-build runner's anti-hang contract.
 *
 * The wallet's send has no timeout of its own: it takes the first reply from
 * this document as the answer to its request and waits. That made two
 * properties load-bearing, and this test pins both:
 *
 *  - every request is answered, even when the worker refuses or never replies
 *    (a proving key that fails to fetch, a WASM trap, a worker killed with the
 *    offscreen document) - otherwise the send sat at "approve and build" with
 *    nothing to show for it, forever;
 *  - builds are serialized, because the wire shape carries no request id: with
 *    two in flight (the wallet's send plus the 30s swap-claim sweep) one
 *    request's reply could resolve the other's promise, and two rayon builds
 *    would interleave inside one WASM instance.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type OffscreenListener = (
  req: unknown,
  sender: unknown,
  respond: (response?: unknown) => void,
) => boolean;

class FakeWorker {
  terminated = false;
  readonly posts: unknown[] = [];
  private readonly messageListeners: ((e: MessageEvent) => void)[] = [];
  private readonly errorListeners: ((e: ErrorEvent) => void)[] = [];

  addEventListener(type: string, fn: never): void {
    if (type === 'message') {
      this.messageListeners.push(fn as never);
    } else if (type === 'error') {
      this.errorListeners.push(fn as never);
    }
  }

  removeEventListener(type: string, fn: never): void {
    const list = type === 'message' ? this.messageListeners : this.errorListeners;
    const at = list.indexOf(fn as never);
    if (at >= 0) {
      list.splice(at, 1);
    }
  }

  postMessage(req: unknown): void {
    this.posts.push(req);
  }

  terminate(): void {
    this.terminated = true;
  }

  emitMessage(data: unknown): void {
    for (const fn of [...this.messageListeners]) {
      fn({ data } as MessageEvent);
    }
  }
}

const listeners: OffscreenListener[] = [];
const workers: FakeWorker[] = [];

/** a request the offscreen document's guards accept */
const buildRequest = (): unknown => ({
  type: 'BUILD_PARALLEL',
  request: { transactionPlan: { actions: [] }, witness: {}, fullViewingKey: {}, authData: {} },
});

const dispatch = async (req: unknown): Promise<unknown> => {
  const response = Promise.withResolvers<unknown>();
  const handled = listeners.some(listener => listener(req, {}, response.resolve));
  expect(handled, 'the offscreen listener claimed the request').toBe(true);
  return response.promise;
};

/** the runner builds the worker a microtask after the request arrives */
const onlyWorker = async (): Promise<FakeWorker> => {
  await vi.waitFor(() => expect(workers).toHaveLength(1));
  return workers[0]!;
};

describe('offscreen parallel build', () => {
  beforeEach(async () => {
    listeners.length = 0;
    workers.length = 0;
    vi.resetModules();
    vi.stubGlobal('chrome', {
      runtime: { onMessage: { addListener: (l: OffscreenListener) => listeners.push(l) } },
    });
    vi.stubGlobal(
      'Worker',
      class extends FakeWorker {
        constructor() {
          super();
          workers.push(this);
        }
      },
    );
    // dynamic on purpose: the module registers its chrome.runtime.onMessage
    // listener at import time, so it must load AFTER the stubs above. A static
    // import would run before this file's body.
    await import('./offscreen-handler');
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('answers a successful build with the transaction payload', async () => {
    const response = dispatch(buildRequest());
    const worker = await onlyWorker();
    worker.emitMessage({ id: 1 });

    await expect(response).resolves.toEqual({ type: 'BUILD_PARALLEL', data: { id: 1 } });
  });

  it('rejects a refused build instead of leaving the caller pending', async () => {
    const response = dispatch(buildRequest());
    const worker = await onlyWorker();
    worker.emitMessage({ __buildError: { message: 'Failed to fetch proving key' } });

    await expect(response).resolves.toEqual({
      type: 'BUILD_PARALLEL',
      error: expect.objectContaining({ message: 'Failed to fetch proving key' }),
    });
  });

  it('fails a build whose worker never answers, and kills the stuck worker', async () => {
    vi.useFakeTimers();
    const response = dispatch(buildRequest());
    await vi.advanceTimersByTimeAsync(5 * 60_000);

    await expect(response).resolves.toEqual({
      type: 'BUILD_PARALLEL',
      error: expect.objectContaining({ message: 'parallel build timed out' }),
    });
    expect(workers[0]!.terminated).toBe(true);
  });

  it('runs one build at a time, in arrival order', async () => {
    const first = dispatch(buildRequest());
    const second = dispatch(buildRequest());
    const worker = await onlyWorker();

    // the second build must wait: a second postMessage would race the first
    // build's reply, which carries no request id.
    expect(worker.posts).toHaveLength(1);
    worker.emitMessage({ id: 'first' });
    await expect(first).resolves.toEqual({ type: 'BUILD_PARALLEL', data: { id: 'first' } });

    await vi.waitFor(() => expect(worker.posts).toHaveLength(2));
    worker.emitMessage({ id: 'second' });
    await expect(second).resolves.toEqual({ type: 'BUILD_PARALLEL', data: { id: 'second' } });
  });
});
