// egress guard first: nothing may capture fetch or open a socket before it
import '../net/egress-install-lite';
import { ConnectError } from '@connectrpc/connect';
import { errorToJson } from '@connectrpc/connect/protocol-connect';
import {
  ParallelBuildResponse,
  isParallelBuildRequest,
  isOffscreenRequest,
} from '@penumbrafi/types/internal-msg/offscreen';
import { assertProveRequest } from '../shared/prove-guard';
import { isValidInternalSender } from '../senders/internal';
import { hostedWorkerCount, initNetworkWorkerHost } from '../state/keyring/network-worker';
import type { ParallelProveRequest } from '@penumbrafi/types/internal-msg/offscreen';
import type { ParallelWorkerFailure, ParallelWorkerRequest } from '../wasm-build-parallel';

// this document is the one long-lived home for the zcash/penumbra sync
// workers - every popup, settings screen and approval window is a client
// that asks this host to spawn/call/terminate them instead of each owning
// a private worker of its own.
initNetworkWorkerHost(proveInBuildWorker);

// The penumbra offscreen client closes this document only when idle, and asks
// here first: hosted sync workers and zcash proves never pass through it.
let jobsInFlight = 0;
let lastJobAt = Date.now();
const trackJob = async <T>(job: () => Promise<T>): Promise<T> => {
  jobsInFlight++;
  lastJobAt = Date.now();
  try {
    return await job();
  } finally {
    jobsInFlight--;
    lastJobAt = Date.now();
  }
};

const isProveParallel = (
  req: unknown,
): req is { type: 'PROVE_PARALLEL'; request: ParallelProveRequest } =>
  typeof req === 'object' &&
  req !== null &&
  'type' in req &&
  req.type === 'PROVE_PARALLEL' &&
  'request' in req &&
  typeof req.request === 'object' &&
  req.request !== null &&
  !('authData' in req.request);

chrome.runtime.onMessage.addListener((req: unknown, sender, respond) => {
  // proving and building are for zafu's own pages, never a content script
  if (!isValidInternalSender(sender)) {
    return false;
  }
  if (typeof req === 'object' && req !== null && 'type' in req && req.type === 'OFFSCREEN_STATUS') {
    respond({
      inFlight: jobsInFlight + (hostedWorkerCount() > 0 ? 1 : 0),
      idleMs: Date.now() - lastJobAt,
    });
    return false;
  }
  if (isProveParallel(req)) {
    void handleBuildRequest(
      () => trackJob(() => runParallelJob({ kind: 'prove', request: req.request })),
      req.type,
      respond,
    );
    return true;
  }
  if (!isOffscreenRequest(req)) {
    return false;
  }
  const { type, request } = req;

  // Handle parallel build (rayon-based, single WASM call)
  if (type === 'BUILD_PARALLEL' && isParallelBuildRequest(request)) {
    void handleBuildRequest(
      () => trackJob(() => runParallelJob<ParallelBuildResponse>({ kind: 'build', request })),
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
 *   interleave inside one WASM instance. `runParallelJob` serializes them.
 */
const PARALLEL_BUILD_TIMEOUT_MS = 5 * 60_000;

const spawnParallelWorker = <T>(job: ParallelWorkerRequest) => {
  const { promise, resolve, reject } = Promise.withResolvers<T>();

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
    // A refused job replies `{ __buildError }`; a successful one replies with
    // the bare JSON result (wasm-build-parallel.ts).
    if (typeof reply === 'object' && reply !== null && '__buildError' in reply) {
      const { message } = (reply as ParallelWorkerFailure).__buildError;
      settle(() => reject(new Error(message)));
    } else {
      settle(() => resolve(reply as T));
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

  worker.postMessage(job);

  return promise;
};

/**
 * Serialize parallel builds and proves: one at a time, in arrival order. A failed build
 * must not poison the queue for the next one.
 */
let parallelBuildQueue: Promise<unknown> = Promise.resolve();
const runParallelJob = <T>(job: ParallelWorkerRequest): Promise<T> => {
  const run = parallelBuildQueue.then(() => spawnParallelWorker<T>(job));
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

/** run one prove request from this document's zcash worker on the build worker */
function proveInBuildWorker(raw: unknown): Promise<unknown> {
  return trackJob(() => proveZcash(raw));
}

async function proveZcash(raw: unknown): Promise<unknown> {
  const req = assertProveRequest(raw);
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
  worker.addEventListener('error', ({ message }: ErrorEvent) => reject(new Error(message)), {
    once: true,
  });
  worker.postMessage(req);
  return promise;
}
