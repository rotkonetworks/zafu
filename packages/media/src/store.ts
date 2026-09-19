/**
 * A minimal framework-agnostic reactive value.
 *
 * `Readable<T>` is BOTH a getter (`value()`) - so it drops straight into a
 * SolidJS template like a signal - AND a `.subscribe(fn)` source, so a React
 * consumer can bridge it with `useSyncExternalStore` and plain JS can just
 * listen. No framework is imported here; consumers adapt it to theirs.
 */

export interface Readable<T> {
  (): T;
  subscribe(fn: (value: T) => void): () => void;
}

export type Writable<T> = [read: Readable<T>, write: (value: T) => void];

export function writable<T>(initial: T): Writable<T> {
  let value = initial;
  const subscribers = new Set<(value: T) => void>();

  const read = (() => value) as Readable<T>;
  read.subscribe = (fn: (value: T) => void) => {
    subscribers.add(fn);
    return () => subscribers.delete(fn);
  };

  const write = (next: T) => {
    // Skip notify when nothing changed - matches signal-style de-duping and
    // avoids redundant re-renders in bridged frameworks.
    if (Object.is(next, value)) {
      return;
    }
    value = next;
    for (const fn of subscribers) {
      fn(value);
    }
  };

  return [read, write];
}
