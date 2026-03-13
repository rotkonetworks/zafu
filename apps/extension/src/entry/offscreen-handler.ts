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
    void handleBuildRequest(
      () => spawnParallelBuildWorker(request),
      type,
      respond,
    );
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
    persistentWorker.addEventListener('error', (e) => {
      console.error('[Offscreen] Parallel worker error, will recreate:', e.message);
      persistentWorker = null;
    });
  }
  return persistentWorker;
};

/**
 * Build transaction using persistent rayon worker.
 * First build initializes WASM + loads keys, subsequent builds are faster.
 */
const spawnParallelBuildWorker = (req: ParallelBuildRequest) => {
  const { promise, resolve, reject } = Promise.withResolvers<ParallelBuildResponse>();

  const worker = getOrCreateParallelWorker();

  const onWorkerMessage = (e: MessageEvent) => {
    resolve(e.data as ParallelBuildResponse);
  };

  const onWorkerError = ({ error, filename, lineno, colno, message }: ErrorEvent) => {
    // Don't kill worker on build error, just reject this request
    reject(
      error instanceof Error
        ? error
        : new Error(`Parallel Worker ErrorEvent ${filename}:${lineno}:${colno} ${message}`),
    );
  };

  const onWorkerMessageError = (ev: MessageEvent) => reject(ConnectError.from(ev.data ?? ev));

  // Use once:true so handlers don't stack up
  worker.addEventListener('message', onWorkerMessage, { once: true });
  worker.addEventListener('error', onWorkerError, { once: true });
  worker.addEventListener('messageerror', onWorkerMessageError, { once: true });

  // Send data to web worker
  worker.postMessage(req);

  return promise;
};

// ── zcash parallel proving ──

let zcashWorker: Worker | null = null;

const getOrCreateZcashWorker = (): Worker => {
  if (!zcashWorker) {
    console.log('[Offscreen] Creating persistent zcash build worker');
    zcashWorker = new Worker('zcash-build-parallel.js');
    zcashWorker.addEventListener('error', (e) => {
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

    worker.addEventListener('message', (e: MessageEvent) => {
      const msg = e.data as { data?: unknown; error?: { message: string } };
      if (msg.error) {
        reject(new Error(msg.error.message));
      } else {
        resolve(msg.data);
      }
    }, { once: true });
    worker.addEventListener('error', ({ message }: ErrorEvent) => {
      reject(new Error(message));
    }, { once: true });

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
