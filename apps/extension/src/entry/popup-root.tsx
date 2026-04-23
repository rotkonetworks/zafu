import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode, useState, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from 'react-router-dom';
import { popupRouter } from '../routes/popup/router';
import { isSidePanel } from '../utils/popup-detection';

import '@repo/ui/styles/globals.css';
import '@repo/ui/styles/icons.css';

const MainPopup = () => {
  const [queryClient] = useState(() => new QueryClient());
  const [wasmReady, setWasmReady] = useState(false);

  useEffect(() => {
    // initialize standard wasm module for keys, addresses
    // parallel wasm will be initialized on-demand when needed for tx building
    import('@rotko/penumbra-wasm/init')
      .then(({ initWasm }) => initWasm())
      .then(() => setWasmReady(true))
      .catch(err => {
        console.error('failed to init wasm:', err);
        setWasmReady(true); // continue anyway, some routes don't need wasm
      });
  }, []);

  // check for pending side panel navigation
  useEffect(() => {
    if (isSidePanel()) {
      chrome.storage.local.get('sidePanelNavigateTo').then(result => {
        const path = result['sidePanelNavigateTo'] as string | undefined;
        if (path) {
          // clear the stored path
          void chrome.storage.local.remove('sidePanelNavigateTo');
          // navigate to the stored path
          popupRouter.navigate(path);
        }
      }).catch(() => {
        // ignore errors
      });
    }
  }, []);

  if (!wasmReady) {
    return (
      <div className='flex h-full items-center justify-center bg-canvas text-fg'>
        <span className='text-[13px] text-fg-dim lowercase tracking-[0.04em]'>loading...</span>
      </div>
    );
  }

  return (
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <RouterProvider
          router={popupRouter}
          future={{ v7_startTransition: true }}
        />
      </QueryClientProvider>
    </StrictMode>
  );
};

const rootElement = document.getElementById('popup-root') as HTMLDivElement;
createRoot(rootElement).render(<MainPopup />);
