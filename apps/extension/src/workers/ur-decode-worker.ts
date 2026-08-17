/**
 * UR fountain (BC-UR) decode worker
 *
 * Off-loads `ur_decode_frames` from the popup main thread. The fountain
 * decoder is NOT incremental — every new part re-decodes the whole
 * accumulated set, which is O(n) per part and O(n^2) over a multi-part
 * airgap scan. Running that in the ZXing scan callback on the UI thread
 * drops camera frames and janks the progress bar. Here it runs in an
 * isolated worker; the main thread just posts the newly-seen part string
 * and receives back progress / done messages.
 *
 * Protocol
 *   main -> worker: { type: 'part', text, urType }
 *   worker -> main: { type: 'ready' }
 *                   { type: 'progress', size }   // decode not yet complete
 *                   { type: 'done', bytes, urType } // buffer transferred
 *                   { type: 'error', message }
 *
 * The main thread guarantees each posted `part` is unique (it dedups,
 * enforces MAX_UR_PARTS / MAX_UR_PART_BYTES, and the type filter) so this
 * worker only accumulates and decodes.
 */

/// <reference lib="webworker" />

const workerSelf = globalThis as unknown as DedicatedWorkerGlobalScope;

interface UrWasm {
  default: (opts?: { module_or_path?: string }) => Promise<unknown>;
  ur_decode_frames: (parts: string, type: string) => string;
}

// Accumulated raw frame strings. Uniqueness is enforced on the main thread,
// so this is a plain array (append-only). The whole set is re-fed to
// ur_decode_frames on each decode pass — that is the fountain decoder's
// contract, and the point of this file is that the cost lands here.
const parts: string[] = [];
let urType = '';

// Coalescing: a decode pass can outlast the inter-frame interval near the end
// of a large scan (exactly the case this worker exists for). Without
// coalescing, `part` messages queue and each triggers a full decode over a
// stale subset, leaving the worker permanently behind. Instead, `onmessage`
// only appends + marks dirty; the actual decode is scheduled once. Parts that
// arrive while a decode runs are appended and folded into the next single
// pass.
let dirty = false;
let decodeScheduled = false;
// latch: once a complete payload is posted, ignore any further parts/decodes.
// The main thread also drops late messages via completedRef; this just avoids
// wasted decodes in the brief window before terminate() lands.
let finished = false;

// wasm init. Mirrors the zcash worker: load the served glue from the extension
// root (webpackIgnore keeps it external so this self-contained worker bundle
// stays tiny) and await bindgen's default() before any export call. Stored as
// a promise so init runs once; on failure the promise is nulled so the next
// `part` retries — matching the component's prior retry-on-next-frame behavior.
let wasmPromise: Promise<UrWasm> | null = null;

const initWasm = (): Promise<UrWasm> => {
  if (!wasmPromise) {
    wasmPromise = (async () => {
      // @ts-expect-error — runtime dynamic import, resolved from extension root
      const mod = (await import(/* webpackIgnore: true */ '/zafu-wasm/zafu_wasm.js')) as UrWasm;
      await mod.default({ module_or_path: '/zafu-wasm/zafu_wasm_bg.wasm' });
      return mod;
    })().catch(err => {
      wasmPromise = null; // allow retry on the next part
      throw err;
    });
  }
  return wasmPromise;
};

const runDecode = async (): Promise<void> => {
  decodeScheduled = false;
  if (finished || !dirty) {
    return;
  }
  dirty = false;

  let wasm: UrWasm;
  try {
    wasm = await initWasm();
  } catch (err) {
    workerSelf.postMessage({
      type: 'error',
      message: `wasm init failed: ${err instanceof Error ? err.message : String(err)}`,
    });
    return;
  }

  // snapshot size at the moment of this pass — parts appended during the
  // async init above are already included, and any that arrive after are
  // folded into a freshly-scheduled pass (dirty was reset before this ran).
  const size = parts.length;
  const partsJson = JSON.stringify(parts);

  try {
    const hex = wasm.ur_decode_frames(partsJson, urType);
    // success -> reconstructed payload as hex
    const bytes = new Uint8Array(hex.length >> 1);
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
    }
    finished = true;
    workerSelf.postMessage({ type: 'done', bytes, urType }, [bytes.buffer]);
  } catch (e) {
    // sample errors so a real decode bug surfaces without spam
    if (size % 8 === 0) {
      console.warn(
        `[ur-decode-worker] decode failed at ${size} parts (${urType}): ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
    workerSelf.postMessage({ type: 'progress', size });
    // a part may have been appended while we were decoding — pick it up
    if (dirty) {
      scheduleDecode();
    }
  }
};

const scheduleDecode = (): void => {
  if (decodeScheduled) {
    return;
  }
  decodeScheduled = true;
  // yield to the message loop so N parts queued during a running decode
  // collapse into a single subsequent pass
  setTimeout(() => void runDecode(), 0);
};

workerSelf.onmessage = (e: MessageEvent<{ type: 'part'; text: string; urType: string }>) => {
  const msg = e.data;
  if (finished || msg?.type !== 'part') {
    return;
  }
  if (urType === '') {
    urType = msg.urType;
  }
  parts.push(msg.text);
  dirty = true;
  scheduleDecode();
};

// warm the wasm in parallel with camera startup — the component created this
// worker on mount precisely so init overlaps the user aiming the camera
void initWasm()
  .then(() => workerSelf.postMessage({ type: 'ready' }))
  .catch(() => {
    /* reported per-part on the first decode attempt */
  });
