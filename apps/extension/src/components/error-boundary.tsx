import { Component, type ReactNode } from 'react';
import { useRouteError } from 'react-router-dom';
import { Button } from '@repo/ui/components/ui/button';
import { CopyButton } from '@repo/ui/components/ui/copy-button';
import { Mark } from '@repo/ui/components/ui/mark';

/**
 * App-wide crash recovery.
 *
 * The extension is entirely lazy()-routed, so when Chrome auto-updates the
 * extension while a popup or the long-lived side panel is open, the old chunk
 * URLs 404 and import() throws a ChunkLoadError. Together with any other
 * uncaught render/loader throw that would otherwise dead-end on React Router's
 * bare default error screen, this module turns those into a recoverable UI:
 *
 *  - RouteErrorScreen: the route errorElement/ErrorBoundary - catches loader,
 *    action and render throws inside the router (incl. lazy chunk failures).
 *  - AppErrorBoundary: a class boundary for throws ABOVE RouterProvider (the
 *    root render, provider construction) that a route handler can never see.
 *
 * A stale-chunk error triggers a single guarded auto-reload (the fresh load
 * pulls the new chunks); the sessionStorage guard makes sure we never loop.
 */

const isChunkLoadError = (err: unknown): boolean => {
  const m = err instanceof Error ? `${err.name} ${err.message}` : String(err);
  return /ChunkLoadError|Loading chunk|dynamically imported module|Importing a module script failed/i.test(
    m,
  );
};

const RELOAD_GUARD = 'zafu:chunk-reload';

// Returns true when it has kicked off a reload (caller should render nothing).
const reloadOnceForStaleChunk = (err: unknown): boolean => {
  if (!isChunkLoadError(err)) {
    return false;
  }
  try {
    if (sessionStorage.getItem(RELOAD_GUARD)) {
      return false; // already tried once - fall through to the manual screen
    }
    sessionStorage.setItem(RELOAD_GUARD, '1');
  } catch {
    // private mode / storage blocked: fall through to the manual screen
    return false;
  }
  window.location.reload();
  return true;
};

// Telemetry seam - console.error today; wire real reporting here later without
// touching any boundary.
export const reportRenderError = (
  error: unknown,
  info?: { componentStack?: string | null },
): void => {
  // deliberate crash-reporting seam - swap console for real telemetry later.
  console.error('[zafu] render error:', error, info?.componentStack);
};

// Approval popups serve a pending dapp request in a dedicated window; "go home"
// there silently abandons the request, so on those paths we offer "close"
// instead. Hash-routed, so match on location.hash.
const isApprovalHash = (): boolean =>
  /#\/?(transaction-approval|origin-approval|sign-approval|capability-approval|zcash-send-approval|keplr-approval)/i.test(
    typeof location === 'undefined' ? '' : location.hash,
  );

// set once the guarded auto-reload has run, so the screen can say so
const triedOnce = (): boolean => {
  try {
    return !!sessionStorage.getItem(RELOAD_GUARD);
  } catch {
    return false;
  }
};

// a fresh load of the default route: clears router errors and stale chunks alike
const beginAgain = () => {
  window.location.hash = '';
  window.location.reload();
};

/** The ErrReload board: one calm pause, one way forward, details on request. */
const ErrorScreen = ({ error }: { error: unknown }) => {
  const message = error instanceof Error ? error.message : String(error);
  const details = [
    `message: ${message}`,
    `stack: ${error instanceof Error ? error.stack : 'n/a'}`,
    `version: ${chrome.runtime.getManifest().version}`,
    `hash: ${location.hash}`,
  ].join('\n');
  const approval = isApprovalHash();

  return (
    <div className='relative isolate flex h-full min-h-[628px] flex-col justify-center gap-4 bg-canvas px-7 text-fg'>
      <img
        src='/media/emblem.webp'
        alt=''
        aria-hidden='true'
        className='pointer-events-none absolute left-1/2 top-[70px] -z-10 size-[280px] -translate-x-1/2 opacity-[0.08]'
      />
      <Mark variant='seal' glyph='間' size={50} className='-rotate-6' />
      <h1 className='font-display text-[28px] text-fg-high'>a brief pause</h1>
      <p className='text-data leading-[1.6] text-fg-muted'>
        something broke on our side, not yours.
        <br />
        nothing was lost.
      </p>
      <Button
        className='mt-2 h-[52px] text-[15px]'
        onClick={approval ? () => window.close() : beginAgain}
      >
        {approval ? 'close' : 'begin again'}
      </Button>
      <span className='h-[18px] text-[11px] text-fg-dim'>
        {triedOnce() ? 'zafu already tried once on its own' : ''}
      </span>
      <CopyButton text={details} label='send us what happened' className='self-center' />
    </div>
  );
};

/**
 * Route-level error handler (errorElement / ErrorBoundary) for both routers.
 * Catches loader, action, and render errors - including lazy-chunk failures -
 * in its route subtree.
 */
export const RouteErrorScreen = () => {
  const error = useRouteError();

  if (reloadOnceForStaleChunk(error)) {
    return null; // reloading for a stale chunk
  }

  reportRenderError(error);
  return <ErrorScreen error={error} />;
};

/**
 * Outermost net - render/lifecycle errors thrown ABOVE RouterProvider (the root
 * render, provider construction). No router in scope here, so recovery is a
 * hard reset to the default route.
 */
export class AppErrorBoundary extends Component<{ children: ReactNode }, { error: unknown }> {
  override state = { error: null as unknown };

  static getDerivedStateFromError(error: unknown) {
    return { error };
  }

  override componentDidCatch(error: unknown, info: { componentStack?: string | null }) {
    if (reloadOnceForStaleChunk(error)) {
      return;
    }
    reportRenderError(error, info);
  }

  override render() {
    if (this.state.error) {
      return <ErrorScreen error={this.state.error} />;
    }
    return this.props.children;
  }
}
