/**
 * Regression guard for cross-origin isolation / rayon multi-threading.
 *
 * halo2 proving (offscreen document) and zcash scanning (web worker) both use
 * rayon via wasm-bindgen-rayon, which needs `SharedArrayBuffer` and a
 * cross-origin-isolated context to spin up its worker pool. Today Chrome grants
 * `SharedArrayBuffer` in extension worker/offscreen contexts WITHOUT any
 * explicit COOP/COEP wiring - so nothing in this repo sets those headers. That
 * is a standing dependency on undocumented Chrome behavior: a future policy
 * change could silently drop every rayon pool to a single thread (proving ~5x
 * slower, scanning several times slower) with NO error thrown - `initThreadPool`
 * would just build a one-thread pool and everything would still "work".
 *
 * This helper is the pure, browser-free core of a loud runtime assertion. The
 * two init sites (offscreen prover, scan worker) call it right where rayon is
 * about to be initialized and shout if isolation is gone. Keeping it a pure
 * function of two booleans makes the degradation logic unit-testable without a
 * browser, SharedArrayBuffer, or a wasm build.
 */

export interface RayonIsolationInputs {
  /** `globalThis.crossOriginIsolated` at the point rayon is expected. */
  crossOriginIsolated: boolean;
  /** `typeof SharedArrayBuffer !== 'undefined'` at the same point. */
  hasSharedArrayBuffer: boolean;
}

export interface RayonIsolationResult {
  /** true when rayon's shared-memory prerequisites are present. */
  ok: boolean;
  /** human-readable cause when degraded; absent when ok. */
  reason?: string;
}

/**
 * Assess whether rayon's shared-memory prerequisites hold.
 *
 * Both conditions must be true for a real (multi-thread) rayon pool:
 *  - `crossOriginIsolated` - the context is cross-origin isolated
 *  - `SharedArrayBuffer` is defined - shared memory can back the pool
 *
 * Either missing means rayon will silently degrade to a single thread.
 */
export const assessRayonIsolation = (inputs: RayonIsolationInputs): RayonIsolationResult => {
  const { crossOriginIsolated, hasSharedArrayBuffer } = inputs;

  if (!hasSharedArrayBuffer) {
    return {
      ok: false,
      reason: 'SharedArrayBuffer is undefined',
    };
  }
  if (!crossOriginIsolated) {
    return {
      ok: false,
      reason: 'crossOriginIsolated is false',
    };
  }
  return { ok: true };
};

/** Loud, side-effecting version for the runtime init sites. */
export const RAYON_ISOLATION_WARNING =
  '[perf] cross-origin isolation unavailable - rayon disabled, proving will be ~5x slower';

/**
 * Read the ambient isolation state from the current realm and assess it.
 * Safe in any worker/offscreen context - reads globals defensively.
 */
export const assessAmbientRayonIsolation = (): RayonIsolationResult =>
  assessRayonIsolation({
    // `crossOriginIsolated` is a boolean global in workers/documents; coerce
    // defensively in case a host realm leaves it undefined.
    crossOriginIsolated: globalThis.crossOriginIsolated,
    hasSharedArrayBuffer: typeof SharedArrayBuffer !== 'undefined',
  });
