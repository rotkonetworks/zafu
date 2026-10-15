/**
 * One pass at a time. Asking while a pass runs is not dropped and not
 * doubled: exactly one more pass follows when it settles, so whatever
 * changed meanwhile is read.
 */
export const queuedPass = (start: () => Promise<unknown>): (() => void) => {
  let running = false;
  let again = false;
  const go = () => {
    if (running) {
      again = true;
      return;
    }
    running = true;
    void start()
      .catch(() => undefined)
      .finally(() => {
        running = false;
        if (again) {
          again = false;
          go();
        }
      });
  };
  return go;
};
