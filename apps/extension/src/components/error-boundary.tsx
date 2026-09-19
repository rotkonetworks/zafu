import { Component, type ReactNode } from 'react';
import { isRouteErrorResponse, useRouteError, useNavigate } from 'react-router-dom';
import { Button } from '@repo/ui/components/ui/button';

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

interface ErrorScreenProps {
  error: unknown;
  notFound?: boolean;
  onGoHome: () => void;
}

const ErrorScreen = ({ error, notFound, onGoHome }: ErrorScreenProps) => {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : 'an unexpected error occurred';

  const approval = isApprovalHash();

  const copyDetails = () => {
    const details = [
      `message: ${message}`,
      `stack: ${error instanceof Error ? error.stack : 'n/a'}`,
      `version: ${chrome.runtime.getManifest().version}`,
      `hash: ${location.hash}`,
    ].join('\n');
    void navigator.clipboard.writeText(details).catch(() => {});
  };

  return (
    <div className='flex h-full flex-col items-center justify-center gap-4 p-6 text-center bg-canvas text-fg'>
      <span
        className={`${notFound ? 'i-lucide-compass' : 'i-lucide-alert-triangle'} h-8 w-8 text-fg-dim`}
      />
      <div className='flex flex-col gap-1'>
        <p className='text-fg-high lowercase'>{notFound ? 'page not found' : 'something broke'}</p>
        <p className='text-data text-fg-dim break-words'>{message}</p>
      </div>
      <div className='flex flex-wrap items-center justify-center gap-2'>
        {approval && !notFound ? (
          <Button size='sm' variant='secondary' onClick={() => window.close()}>
            <span className='i-lucide-x mr-1 h-3 w-3' /> close
          </Button>
        ) : (
          <Button size='sm' variant='secondary' onClick={onGoHome}>
            <span className='i-lucide-home mr-1 h-3 w-3' /> go home
          </Button>
        )}
        <Button size='sm' variant='secondary' onClick={() => window.location.reload()}>
          <span className='i-lucide-refresh-cw mr-1 h-3 w-3' /> reload
        </Button>
        {!notFound && (
          <Button size='sm' variant='ghost' onClick={copyDetails}>
            <span className='i-lucide-clipboard-copy mr-1 h-3 w-3' /> copy details
          </Button>
        )}
      </div>
      {!notFound && (
        <button
          type='button'
          className='text-data text-fg-dim underline-offset-4 hover:underline lowercase'
          onClick={() => chrome.runtime.reload()}
        >
          restart extension
        </button>
      )}
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
  const navigate = useNavigate();

  if (reloadOnceForStaleChunk(error)) {
    return null; // reloading for a stale chunk
  }

  reportRenderError(error);
  const notFound = isRouteErrorResponse(error) && error.status === 404;
  // navigating clears the RR route error without a full reload
  return <ErrorScreen error={error} notFound={notFound} onGoHome={() => navigate('/')} />;
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
      return (
        <ErrorScreen
          error={this.state.error}
          onGoHome={() => {
            window.location.hash = '';
            window.location.reload();
          }}
        />
      );
    }
    return this.props.children;
  }
}
