/**
 * Silence the penumbra transport's dev-only client logs.
 *
 * `@penumbra-zone/transport-chrome`'s `CRSessionClient` logs every reported
 * error, every abort signal, and every connect failure at console level, gated
 * on `globalThis.__DEV__` (session-client.js). In a dev build anything that
 * probes the wallet on a loop - cosmos-kit looking for a Keplr provider while
 * keplrCompat is off, a poller treating not-found as an error, or a page left
 * orphaned by a reload - turns that into hundreds of identical lines and makes
 * the console unusable for actual debugging.
 *
 * The noise also carries no useful information: `reportError` prints the raw
 * message object, which renders as `[object Object]`. The underlying errors are
 * untouched - they still propagate to callers, and the orphaned-context case is
 * surfaced by `noteContextInvalidated` instead.
 *
 * `installGracefulNetworkErrorHandler` cannot help here: it works by
 * preventDefault()-ing `error`/`unhandledrejection` events, and these are bare
 * console calls inside a dependency, with no event to cancel.
 *
 * Scoped as tightly as possible - exact first argument, warn/error only, dev
 * only - so nothing else is ever swallowed. A production build does not emit
 * these logs at all, so this is a no-op there.
 */
const NOISE_PREFIXES: Record<string, true> = {
  'session-client reportError': true,
  'session-client signal': true,
  'session-client connect error': true,
};

export const silenceSessionClientNoise = (): void => {
  if (!globalThis.__DEV__) {
    return;
  }
  const nativeWarn = console.warn.bind(console);
  const nativeError = console.error.bind(console);
  console.warn = (...args: unknown[]) => {
    if (typeof args[0] === 'string' && NOISE_PREFIXES[args[0]] === true) {
      return;
    }
    nativeWarn(...args);
  };
  console.error = (...args: unknown[]) => {
    if (typeof args[0] === 'string' && NOISE_PREFIXES[args[0]] === true) {
      return;
    }
    nativeError(...args);
  };
};
