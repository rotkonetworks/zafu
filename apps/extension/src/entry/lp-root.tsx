// egress guard first: nothing may capture fetch or open a socket before it
import '../net/egress-install';
import '../install-console-quieting';
import { lazy, StrictMode, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { localExtStorage } from '@repo/storage-chrome/local';
import { AppErrorBoundary, reportRenderError } from '../components/error-boundary';
import { trackActivity } from '../state/idle-activity';

import '@repo/ui/styles/globals.css';
import '@repo/ui/styles/icons.css';

/**
 * lp.html: the zec liquidity page loads in its own chunk, so this entry is the
 * seal and a stylesheet.
 */
const LpPage = lazy(() =>
  import(/* webpackChunkName: "lp-page" */ '../routes/lp').then(m => ({ default: m.LpPage })),
);

// the person using this page is what keeps the wallet unlocked (auto-lock)
trackActivity();

void localExtStorage.get('zafuTheme').then(v => {
  if (v === 'washi') {
    document.documentElement.dataset['theme'] = v;
  }
});

createRoot(document.getElementById('root') as HTMLDivElement, {
  onCaughtError: (error, info) => reportRenderError(error, info),
  onUncaughtError: (error, info) => reportRenderError(error, info),
}).render(
  <StrictMode>
    <AppErrorBoundary>
      <Suspense fallback={<div className='min-h-screen bg-canvas' />}>
        <LpPage />
      </Suspense>
    </AppErrorBoundary>
  </StrictMode>,
);
