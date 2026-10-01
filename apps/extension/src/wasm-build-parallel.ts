/**
 * Web Worker for rayon-based parallel transaction building.
 *
 * This worker initializes WASM with rayon thread pool support and builds
 * entire transactions in parallel using build_parallel_native.
 *
 * Unlike wasm-build-action.ts which builds individual actions, this worker
 * builds ALL actions concurrently via rayon's par_iter() in a single WASM call.
 */

// egress guard first: nothing may capture fetch or open a socket before it
import './net/egress-install-lite';
import {
  AuthorizationData,
  Transaction,
  TransactionBody,
  TransactionPlan,
  WitnessData,
} from '@penumbra-zone/protobuf/penumbra/core/transaction/v1/transaction_pb';
import type { JsonValue } from '@bufbuild/protobuf';
import type { ParallelBuildRequest } from '@rotko/penumbra-types/internal-msg/offscreen';
import { FullViewingKey } from '@penumbra-zone/protobuf/penumbra/core/keys/v1/keys_pb';
import actionKeys from '@penumbra-zone/keys';
import { assessAmbientRayonIsolation, RAYON_ISOLATION_WARNING } from './perf/rayon-isolation';

// Proving key URLs are relative to the extension origin. self.location.origin
// is the chrome-extension://<id> origin in any extension worker context, so
// it's correct for unpacked, beta, and Web Store installs alike.
const keyFileNames: Partial<Record<string, URL>> = Object.fromEntries(
  Object.entries(actionKeys).map(([action, keyFile]) => [
    action,
    new URL('keys/' + keyFile, self.location.origin),
  ]),
);

// Action type to proving key file mapping
const ACTION_KEY_FILES: Record<string, string> = {
  spend: 'spend_pk.bin',
  output: 'output_pk.bin',
  swap: 'swap_pk.bin',
  swapClaim: 'swapclaim_pk.bin',
  delegatorVote: 'delegator_vote_pk.bin',
  undelegateClaim: 'convert_pk.bin',
  actionLiquidityTournamentVote: 'delegator_vote_pk.bin',
};

// Propagate unhandled promise rejections
self.addEventListener(
  'unhandledrejection',
  event => {
    throw event.reason;
  },
  { once: true },
);

// Track initialization state
let wasmInitialized = false;
let wasmInitPromise: Promise<void> | null = null;

/**
 * Initialize WASM with rayon parallel support.
 * Must be called before building transactions.
 */
const initParallelWasm = async () => {
  if (wasmInitialized) {
    return;
  }
  if (wasmInitPromise) {
    return wasmInitPromise;
  }

  wasmInitPromise = (async () => {
    try {
      const wasmInit = await import('@rotko/penumbra-wasm/init');

      if (typeof SharedArrayBuffer === 'undefined') {
        throw new Error('SharedArrayBuffer not available - parallel WASM requires it');
      }

      // Regression guard: even when SharedArrayBuffer exists, a lost
      // cross-origin-isolated context degrades rayon to a single thread. No
      // COOP/COEP is set anywhere - this depends on current Chrome policy for
      // extension realms; shout loudly if that ever slips.
      const isolation = assessAmbientRayonIsolation();
      if (!isolation.ok) {
        console.error(`${RAYON_ISOLATION_WARNING} (penumbra parallel build: ${isolation.reason})`);
      }

      const numThreads = navigator.hardwareConcurrency || 4;
      await wasmInit.initWasmWithParallel(numThreads);
      console.log(`[Parallel Build Worker] Initialized with ${numThreads} rayon threads`);
      wasmInitialized = true;
    } catch (error) {
      console.error('[Parallel Build Worker] Failed to initialize:', error);
      wasmInitPromise = null;
      throw error;
    }
  })();

  return wasmInitPromise;
};

// Proving keys are loaded once per KEY FILE, not per action type:
// delegatorVote and actionLiquidityTournamentVote share delegator_vote_pk.bin
// (~22MB). Keying by action type fetched it twice (and concurrently, via the
// Promise.all below, when a plan contained both). Now the file is fetched once
// and handed to load_proving_key under EVERY action type that uses it, so both
// are ready without retaining the bytes in JS. (In wasm both names map to the
// same OnceCell static, so the second call is a cheap no-op.)
const keyFileLoads = new Map<string, Promise<void>>();

/**
 * Load a proving key if not already loaded.
 */
const loadProvingKeyIfNeeded = (
  actionType: string,
  loadKey: (key: Uint8Array, type: string) => void,
): Promise<void> => {
  const keyFile = ACTION_KEY_FILES[actionType];
  if (!keyFile) {
    console.warn(`[Parallel Build Worker] No proving key file for action type: ${actionType}`);
    return Promise.resolve();
  }

  const keyUrl = keyFileNames[actionType]?.href;
  if (!keyUrl) {
    console.warn(`[Parallel Build Worker] No key URL for action type: ${actionType}`);
    return Promise.resolve();
  }

  const existing = keyFileLoads.get(keyFile);
  if (existing) {
    return existing;
  }

  const load = (async () => {
    console.log(`[Parallel Build Worker] Loading proving key file: ${keyFile}`);
    const response = await fetch(keyUrl);
    if (!response.ok) {
      throw new Error(`Failed to fetch proving key: ${keyUrl}`);
    }
    const keyBytes = new Uint8Array(await response.arrayBuffer());
    for (const [action, file] of Object.entries(ACTION_KEY_FILES)) {
      if (file === keyFile) {
        loadKey(keyBytes, action);
      }
    }
  })().catch((e: unknown) => {
    // Don't cache failures: allow a retry on the next build.
    keyFileLoads.delete(keyFile);
    throw e;
  });

  keyFileLoads.set(keyFile, load);
  return load;
};

/**
 * Get the set of action types that require proving keys from a transaction plan.
 */
const getRequiredProvingKeys = (txPlan: TransactionPlan): Set<string> => {
  const required = new Set<string>();

  for (const actionPlan of txPlan.actions) {
    const actionCase = actionPlan.action.case;
    if (!actionCase) {
      continue;
    }

    switch (actionCase) {
      case 'spend':
        required.add('spend');
        break;
      case 'output':
        required.add('output');
        break;
      case 'swap':
        required.add('swap');
        break;
      case 'swapClaim':
        required.add('swapClaim');
        break;
      case 'delegatorVote':
        required.add('delegatorVote');
        break;
      case 'undelegateClaim':
        required.add('undelegateClaim');
        break;
      case 'actionLiquidityTournamentVote':
        required.add('actionLiquidityTournamentVote');
        break;
    }
  }

  return required;
};

/**
 * PROVE_PARALLEL from @penumbrafi/services: prove every action before the user
 * approves, from viewing data only. Mirrors ParallelBuildRequest without
 * authData; import it from @penumbrafi/types once zafu moves there.
 */
export interface ParallelProveRequest {
  transactionPlan: ParallelBuildRequest['transactionPlan'];
  witness: ParallelBuildRequest['witness'];
  fullViewingKey: ParallelBuildRequest['fullViewingKey'];
}

export type ParallelWorkerRequest =
  | { kind: 'build'; request: ParallelBuildRequest }
  | { kind: 'prove'; request: ParallelProveRequest };

/**
 * Reply shape for a refused job. The success reply is the bare JSON result, so
 * failures are marked with this key instead of a wrapper. `unimplemented` means
 * this wasm cannot prove without auth data; the caller falls back to a build.
 */
export interface ParallelWorkerFailure {
  __buildError: { message: string; unimplemented?: boolean };
}

class ProveUnsupportedError extends Error {}

const postFailure = (e: unknown): void => {
  self.postMessage({
    __buildError: {
      message: e instanceof Error ? e.message : String(e),
      unimplemented: e instanceof ProveUnsupportedError,
    },
  } satisfies ParallelWorkerFailure);
};

// ALWAYS reply. A rejection here - a proving key that fails to fetch, a WASM
// trap, a malformed payload - used to vanish into an unhandled rejection, so
// no message was ever posted and the offscreen handler's request (and with
// it the wallet's send) stayed pending forever.
const workerListener = ({ data }: MessageEvent<ParallelWorkerRequest>) => {
  const job = data.kind === 'prove' ? executeProve(data.request) : executeBuild(data.request);
  void job.then(result => self.postMessage(result), postFailure);
};

// Listen for all messages - worker is persistent
self.addEventListener('message', workerListener);

/** Initialize wasm and load every proving key the plan needs; both stay cached. */
async function prepare(transactionPlan: TransactionPlan) {
  await initParallelWasm();

  // Import parallel WASM module directly - keys must be loaded into the same module that uses them
  const parallelWasm = await import('@rotko/penumbra-wasm/wasm-parallel');

  await Promise.all(
    Array.from(getRequiredProvingKeys(transactionPlan)).map(actionType =>
      loadProvingKeyIfNeeded(actionType, parallelWasm.load_proving_key),
    ),
  );
  return parallelWasm;
}

/** wasm-parallel exports added after @rotko/penumbra-wasm@55.0.2 */
interface ProveOnlyWasm {
  build_actions_native?: (
    full_viewing_key: Uint8Array,
    transaction_plan: Uint8Array,
    witness_data: Uint8Array,
  ) => Uint8Array;
}

/** Prove all actions without authorization data; returns them in plan order. */
async function executeProve(req: ParallelProveRequest): Promise<JsonValue> {
  const transactionPlan = TransactionPlan.fromJson(req.transactionPlan);
  const parallelWasm = (await prepare(transactionPlan)) as ProveOnlyWasm;
  if (typeof parallelWasm.build_actions_native !== 'function') {
    throw new ProveUnsupportedError('wasm-parallel has no build_actions_native');
  }

  const start = performance.now();
  const { actions } = TransactionBody.fromBinary(
    parallelWasm.build_actions_native(
      FullViewingKey.fromJson(req.fullViewingKey).toBinary(),
      transactionPlan.toBinary(),
      WitnessData.fromJson(req.witness).toBinary(),
    ),
  );
  console.debug(
    `[Parallel Build Worker] proved ${actions.length} actions in ${(performance.now() - start).toFixed(0)}ms`,
  );
  return actions.map(action => action.toJson());
}

/** Proofs and authorization in one call (the pre-approval path is executeProve). */
async function executeBuild(req: ParallelBuildRequest): Promise<JsonValue> {
  const transactionPlan = TransactionPlan.fromJson(req.transactionPlan);
  const parallelWasm = await prepare(transactionPlan);

  const start = performance.now();
  const transaction = Transaction.fromBinary(
    parallelWasm.build_parallel_native(
      FullViewingKey.fromJson(req.fullViewingKey).toBinary(),
      transactionPlan.toBinary(),
      WitnessData.fromJson(req.witness).toBinary(),
      AuthorizationData.fromJson(req.authData).toBinary(),
    ),
  );
  console.debug(
    `[Parallel Build Worker] built transaction in ${(performance.now() - start).toFixed(0)}ms`,
  );
  return transaction.toJson();
}
