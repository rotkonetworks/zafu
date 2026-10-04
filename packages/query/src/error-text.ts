/**
 * One line of text for a thrown value: "name: message".
 *
 * An error object handed straight to console.* renders well in DevTools, but
 * the extension's error list (and anything else that turns arguments into
 * text) prints a DOMException or an event as "[object DOMException]" or
 * "[object MessageEvent]", which says nothing. Log `errText(e)` instead.
 */
export const errText = (e: unknown): string => {
  if (typeof e === 'string') {
    return e;
  }
  if (e && typeof e === 'object') {
    const { name, message, type } = e as { name?: unknown; message?: unknown; type?: unknown };
    if (typeof message === 'string') {
      const n = typeof name === 'string' && name ? name : 'Error';
      return message ? `${n}: ${message}` : n;
    }
    // an Event: its type is all it has to say
    if (typeof type === 'string') {
      return `${e.constructor.name} '${type}'`;
    }
  }
  try {
    return String(e);
  } catch {
    return Object.prototype.toString.call(e);
  }
};

/**
 * What a failed IndexedDB call means for a loop that keeps retrying it.
 *
 * - 'reopen': the connection is gone or the call was cut short (the browser
 *   closed it, another realm asked for a version change, the backing store
 *   hiccuped). The same connection never works again, so retrying over it
 *   counts failures forever; a fresh connection usually does.
 * - 'fatal': retrying cannot help until something outside the loop changes:
 *   the disk is full (QuotaExceededError), the database is from a newer build
 *   than this one (VersionError), or a store this build expects is missing
 *   (NotFoundError). Stop and say so.
 * - undefined: not a storage failure (a network error, a node that is down).
 */
export type StorageFailure = 'reopen' | 'fatal';

// AbortError and TimeoutError are left out on purpose: a fetch cut short by
// its signal throws them too, and that is the network, not storage
const REOPEN = new Set(['InvalidStateError', 'TransactionInactiveError', 'UnknownError']);
const FATAL = new Set(['QuotaExceededError', 'VersionError', 'NotFoundError', 'DataCloneError']);

export const storageFailure = (e: unknown): StorageFailure | undefined => {
  if (typeof DOMException === 'undefined') {
    return undefined;
  }
  // the DOMException itself, or one a wrapper kept as its cause
  const cause = e instanceof Error ? e.cause : undefined;
  const dom = [e, cause].find((x): x is DOMException => x instanceof DOMException);
  if (!dom) {
    return undefined;
  }
  if (FATAL.has(dom.name)) {
    return 'fatal';
  }
  return REOPEN.has(dom.name) ? 'reopen' : undefined;
};
