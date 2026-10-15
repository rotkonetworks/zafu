/**
 * A slow lookup that must not hold up what is shown with it, asked once per
 * key: each caller waits at most `waitMs`, and a run that outlasts the wait
 * keeps going for the next caller. Once a run has answered, its answer stands
 * for that key; a failed run is asked again.
 *
 * History uses it for the transparent lookup, keyed by the transparent
 * check it follows: asked when the person checks, never per block, and over
 * nym it can take minutes while the shielded rows answer without it.
 */
export const lastOrWait = <T>(waitMs: number, onError: (e: unknown) => void) => {
  const last = new Map<string, T>();
  const running = new Map<string, Promise<void>>();
  return async (key: string, run: () => Promise<T>): Promise<T | undefined> => {
    let current = running.get(key);
    if (!current && !last.has(key)) {
      current = run()
        .then(v => void last.set(key, v))
        .catch(onError)
        .finally(() => running.delete(key));
      running.set(key, current);
    }
    if (current) {
      await Promise.race([current, new Promise(r => setTimeout(r, waitMs))]);
    }
    return last.get(key);
  };
};
