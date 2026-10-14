/**
 * A slow lookup that must not hold up what is shown with it: one run per key
 * at a time, and each caller waits at most `waitMs` before it takes what the
 * last finished run found. A run that outlasts the wait keeps going, and the
 * next caller gets its result.
 *
 * History uses it for the transparent lookup, which over nym can take
 * minutes; the shielded rows answer without it.
 */
export const lastOrWait = <T>(waitMs: number, onError: (e: unknown) => void) => {
  const last = new Map<string, T>();
  const running = new Map<string, Promise<void>>();
  return async (key: string, run: () => Promise<T>): Promise<T | undefined> => {
    let current = running.get(key);
    if (!current) {
      current = run()
        .then(v => void last.set(key, v))
        .catch(onError)
        .finally(() => running.delete(key));
      running.set(key, current);
    }
    await Promise.race([current, new Promise(r => setTimeout(r, waitMs))]);
    return last.get(key);
  };
};
