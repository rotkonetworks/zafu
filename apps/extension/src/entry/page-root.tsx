import { createRoot } from 'react-dom/client';
import { RouterProvider } from 'react-router-dom';
import { pageRouter } from '../routes/page/router';
import { StrictMode, useState, useEffect } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import '@repo/ui/styles/globals.css';

const MainPage = () => {
  const [queryClient] = useState(() => new QueryClient());
  const [wasmReady, setWasmReady] = useState(false);

  useEffect(() => {
    // initialize wasm module before rendering routes
    // all wasm functions (keys, transactions, etc.) now use wasm-parallel
    import('@penumbra-zone/wasm/init')
      .then(wasmInit => wasmInit.default())
      .then(() => setWasmReady(true))
      .catch(err => {
        console.error('failed to init wasm:', err);
        setWasmReady(true); // continue anyway, some routes don't need wasm
      });
  }, []);

  if (!wasmReady) {
    return (
      <div className='flex h-screen items-center justify-center bg-background text-foreground'>
        <span className='text-sm text-muted-foreground'>loading...</span>
      </div>
    );
  }

  return (
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <RouterProvider
          router={pageRouter}
          future={{ v7_startTransition: true }}
        />
      </QueryClientProvider>
    </StrictMode>
  );
};

const rootElement = document.getElementById('root') as HTMLDivElement;
createRoot(rootElement).render(<MainPage />);
