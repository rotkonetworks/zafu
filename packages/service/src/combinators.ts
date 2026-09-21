/**
 * The two combinators from the pattern's futures half that are not already a
 * call in the language, kept here so call sites read the way the design does.
 *
 * There is deliberately no `collect` and no `flatMap`: `Promise.all` and `await`
 * ARE those, and a wrapper that only renames a builtin is a call to a function
 * whose body the reader then has to go and read. `select` and `rescue` are here
 * because they add semantics of their own (an empty-input refusal, and recovery
 * from a rejection without a nested `try`).
 */

/**
 * The first promise to settle - success OR failure - which is what makes this
 * useful for backup requests: issue the same call twice and take whichever
 * returns, rather than waiting for the slowest. The losers are not cancelled; a
 * promise cannot be, so the caller owns the AbortController that can.
 */
export const select = <T>(promises: readonly Promise<T>[]): Promise<T> => {
  const [first] = promises;
  if (first === undefined) {
    return Promise.reject(new Error('select: no promises given'));
  }
  return Promise.race(promises);
};

/**
 * Recover from a failure. The handler is a total function because TypeScript has
 * no partial-function literals; it decides what it recognises and rethrows the
 * rest, which keeps that decision at the call site instead of in the combinator.
 */
export const rescue = async <T>(
  promise: Promise<T>,
  handler: (error: unknown) => Promise<T> | T,
): Promise<T> => {
  try {
    return await promise;
  } catch (error) {
    return await handler(error);
  }
};
