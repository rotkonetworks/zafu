import { ConnectError } from '@connectrpc/connect';
import { errorToJson } from '@connectrpc/connect/protocol-connect';
import {
  ParallelBuildRequest,
  ParallelBuildResponse,
  isParallelBuildRequest,
  isOffscreenRequest,
} from '@rotko/penumbra-types/internal-msg/offscreen';

chrome.runtime.onMessage.addListener((req, _sender, respond) => {
  if (!isOffscreenRequest(req)) {
    // check for zcash build requests (from zcash-worker)
    if (req?.type === 'ZCASH_BUILD' && req?.request?.fn) {
      console.log('[Offscreen] Received ZCASH_BUILD request:', req.request.fn);
      void handleZcashBuild(req.request, respond);
      return true;
    }
    return false;
  }
  const { type, request } = req;

  // Handle parallel build (rayon-based, single WASM call)
  if (type === 'BUILD_PARALLEL' && isParallelBuildRequest(request)) {
    console.log('[Offscreen] Received BUILD_PARALLEL request');
    void handleBuildRequest(() => runParallelBuild(request), type, respond);
    return true;
  }

  return false;
});

/**
 * Generic handler for build requests with error handling.
 */
async function handleBuildRequest<T>(
  buildFn: () => Promise<T>,
  type: string,
  respond: (response: { type: string; data?: T; error?: unknown }) => void,
): Promise<void> {
  try {
    // propagate errors that occur in unawaited promises
    const unhandled = Promise.withResolvers<never>();
    self.addEventListener('unhandledrejection', unhandled.reject, {
      once: true,
    });

    const data = await Promise.race([buildFn(), unhandled.promise]).finally(() =>
      self.removeEventListener('unhandledrejection', unhandled.reject),
    );

    respond({ type, data });
  } catch (e) {
    const error = errorToJson(
      ConnectError.from(e instanceof PromiseRejectionEvent ? e.reason : e),
      undefined,
    );
    respond({ type, error });
  }
}

/**
 * Persistent worker for rayon-based parallel transaction building.
 * Keeping the worker alive means:
 * - WASM only initializes once
 * - Rayon thread pool stays warm
 * - Proving keys stay cached in memory
 */
let persistentWorker: Worker | null = null;

const getOrCreateParallelWorker = (): Worker => {
  if (!persistentWorker) {
    console.log('[Offscreen] Creating persistent parallel build worker');
    persistentWorker = new Worker('wasm-build-parallel.js');

    // Handle worker errors - recreate on fatal error
    persistentWorker.addEventListener('error', e => {
      console.error('[Offscreen] Parallel worker error, will recreate:', e.message);
      persistentWorker = null;
    });
  }
  return persistentWorker;
};

/**
 * Build transaction using persistent rayon worker.
 * First build initializes WASM + loads keys, subsequent builds are faster.
 *
 * Every request is BOUNDED and every request gets exactly one reply. Both
 * properties are load-bearing for the wallet's send flow, which has no timeout
 * of its own:
 *
 * - No reply, no answer. A worker that dies mid-prove (the offscreen document
 *   torn down by another build's release, a WASM trap, a proving key that fails
 *   to fetch) used to leave this promise pending forever: the send sat at
 *   "approve and build" and nothing downstream ever gave up. The cap below turns
 *   that into a failure the UI can show.
 * - One reply per request. The wire shape carries no request id, so a second
 *   build in flight (the wallet's send plus the 30s swap-claim sweep) could have
 *   its reply taken as the other request's answer - and two rayon builds would
 *   interleave inside one WASM instance. `runParallelBuild` serializes them.
 */
const PARALLEL_BUILD_TIMEOUT_MS = 5 * 60_000;

const spawnParallelBuildWorker = (req: ParallelBuildRequest) => {
  const { promise, resolve, reject } = Promise.withResolvers<ParallelBuildResponse>();

  const worker = getOrCreateParallelWorker();
  let settled = false;

  const settle = (fn: () => void) => {
    if (settled) {
      return;
    }
    settled = true;
    clearTimeout(timer);
    worker.removeEventListener('message', onWorkerMessage);
    worker.removeEventListener('error', onWorkerError);
    worker.removeEventListener('messageerror', onWorkerMessageError);
    fn();
  };

  const onWorkerMessage = (e: MessageEvent) => {
    const reply: unknown = e.data;
    // A refused build replies `{ __buildError: { message } }`; a successful one
    // replies with the bare transaction JSON (wasm-build-parallel.ts).
    if (typeof reply === 'object' && reply !== null && '__buildError' in reply) {
      const failure: unknown = reply.__buildError;
      const message =
        typeof failure === 'object' &&
        failure !== null &&
        'message' in failure &&
        typeof failure.message === 'string'
          ? failure.message
          : 'parallel build failed';
      settle(() => reject(new Error(message)));
    } else {
      settle(() => resolve(reply as ParallelBuildResponse));
    }
  };

  const onWorkerError = ({ error, filename, lineno, colno, message }: ErrorEvent) => {
    // Don't kill worker on build error, just reject this request
    settle(() =>
      reject(
        error instanceof Error
          ? error
          : new Error(`Parallel Worker ErrorEvent ${filename}:${lineno}:${colno} ${message}`),
      ),
    );
  };

  const onWorkerMessageError = (ev: MessageEvent) =>
    settle(() => reject(ConnectError.from(ev.data ?? ev)));

  worker.addEventListener('message', onWorkerMessage);
  worker.addEventListener('error', onWorkerError);
  worker.addEventListener('messageerror', onWorkerMessageError);

  // A stuck worker cannot answer again (a proof that never returns), so kill it:
  // the next build then starts from a fresh WASM instance instead of queueing
  // behind the corpse.
  const timer = setTimeout(() => {
    console.error(`[Offscreen] parallel build timed out after ${PARALLEL_BUILD_TIMEOUT_MS}ms`);
    if (persistentWorker === worker) {
      persistentWorker = null;
    }
    worker.terminate();
    settle(() => reject(new Error('parallel build timed out')));
  }, PARALLEL_BUILD_TIMEOUT_MS);

  // Send data to web worker
  worker.postMessage(req);

  return promise;
};

/**
 * Serialize parallel builds: one at a time, in arrival order. A failed build
 * must not poison the queue for the next one.
 */
let parallelBuildQueue: Promise<unknown> = Promise.resolve();
const runParallelBuild = (req: ParallelBuildRequest): Promise<ParallelBuildResponse> => {
  const run = parallelBuildQueue.then(() => spawnParallelBuildWorker(req));
  parallelBuildQueue = run.catch(() => undefined);
  return run;
};

// ── zcash parallel proving ──

let zcashWorker: Worker | null = null;

const getOrCreateZcashWorker = (): Worker => {
  if (!zcashWorker) {
    console.log('[Offscreen] Creating persistent zcash build worker');
    zcashWorker = new Worker('zcash-build-parallel.js');
    zcashWorker.addEventListener('error', e => {
      console.error('[Offscreen] Zcash worker error, will recreate:', e.message);
      zcashWorker = null;
    });
  }
  return zcashWorker;
};

interface ZcashBuildRequest {
  fn: string;
  args: unknown[];
}

async function handleZcashBuild(
  req: ZcashBuildRequest,
  respond: (response: { type: string; data?: unknown; error?: unknown }) => void,
): Promise<void> {
  try {
    const { promise, resolve, reject } = Promise.withResolvers<unknown>();
    const worker = getOrCreateZcashWorker();

    worker.addEventListener(
      'message',
      (e: MessageEvent) => {
        const msg = e.data as { data?: unknown; error?: { message: string } };
        if (msg.error) {
          reject(new Error(msg.error.message));
        } else {
          resolve(msg.data);
        }
      },
      { once: true },
    );
    worker.addEventListener(
      'error',
      ({ message }: ErrorEvent) => {
        reject(new Error(message));
      },
      { once: true },
    );

    worker.postMessage(req);
    const data = await promise;
    respond({ type: 'ZCASH_BUILD', data });
  } catch (e) {
    respond({
      type: 'ZCASH_BUILD',
      error: { message: e instanceof Error ? e.message : String(e) },
    });
  }
}
