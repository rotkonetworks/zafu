/**
 * Run an async initializer at most once, sharing the in-flight promise.
 *
 * A plain `if (module) return;` guard is NOT enough for wasm init: the flag is
 * only set after the await chain finishes, so two messages arriving in the same
 * tick both see `null` and both run the initializer. For a wasm-bindgen module
 * that means `wasm.default()` runs twice on one instance and `initThreadPool()`
 * is called a second time — which throws `unwrap_throw() on an Err value`, is
 * caught by the "degrade to sequential" handler, and silently leaves scanning
 * single-threaded. The re-init also detaches the live memory views, which
 * surfaces later as `RuntimeError: memory access out of bounds`.
 *
 * A rejected initializer clears the memo so the next caller may retry; a
 * resolved one is never run again.
 */
export const once = <T>(init: () => Promise<T>): (() => Promise<T>) => {
  let inflight: Promise<T> | null = null;
  let done = false;
  let value: T;

  return async (): Promise<T> => {
    if (done) {
      return value;
    }
    if (!inflight) {
      inflight = init().then(
        v => {
          done = true;
          value = v;
          inflight = null;
          return v;
        },
        e => {
          inflight = null;
          throw e;
        },
      );
    }
    return inflight;
  };
};
