import '@fontsource/ibm-plex-sans/400.css';
import '@fontsource/ibm-plex-sans/500.css';
import '@fontsource/ibm-plex-sans/600.css';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/500.css';
import '@fontsource/ibm-plex-mono/600.css';
import './styles/index.css';

import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';

import { createQueryClient, createTrpcClient, trpc } from './lib/trpc';
import { router } from './router';

function App() {
  const [queryClient] = useState(createQueryClient);
  const [trpcClient] = useState(createTrpcClient);
  return (
    <trpc.Provider client={trpcClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </trpc.Provider>
  );
}

const el = document.getElementById('root');
if (el === null) throw new Error('Missing #root element');
createRoot(el).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
