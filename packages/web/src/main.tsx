import React from 'react';
import ReactDOM from 'react-dom/client';
import { RouterProvider } from '@tanstack/react-router';
import { QueryClientProvider } from '@tanstack/react-query';
import { router } from './router';
import { queryClient } from './services/query-client';
// Bundled, not fetched from a CDN. This app is self-hosted and works offline;
// pulling webfonts from Google would make every page load phone home from a
// tool whose whole premise is that the library is yours.
// Urbanist (thin display), Figtree (body and controls), JetBrains Mono (paths,
// tag keys, diffs): the Google Fonts faces of the design system, self-hosted
// through @fontsource so an offline homelab still gets them. Urbanist ships
// only the thin weights: it is applied through the --type-* tokens
// (PageShell, Card, EmptyState), never to bare headings, so no page heading
// with a bold weight can fall into it and get a synthesised bold. Figtree
// covers 400 to 700 because page CSS still asks for 700 in places.
import '@fontsource/urbanist/200.css';
import '@fontsource/urbanist/300.css';
import '@fontsource/urbanist/400.css';
import '@fontsource/figtree/400.css';
import '@fontsource/figtree/500.css';
import '@fontsource/figtree/600.css';
import '@fontsource/figtree/700.css';
import '@fontsource/jetbrains-mono/400.css';
import './styles/index.css';
import { applyTheme, readThemePreference } from './theme';
import { ConfirmHost } from './components/ui/ConfirmDialog';
import { ToastHost } from './components/ui/Toast';
import { startDiagnostics } from './services/diagnostics';
import { installChunkErrorReload } from './services/buildCheck';
import { NewBuildNotice } from './components/NewBuildNotice';
import { registerServiceWorker } from './services/serviceWorker';

applyTheme(readThemePreference());
// off unless switched on in the console (services/diagnostics.ts)
startDiagnostics();
// a lazy page whose file is gone (the app was updated): one reload into the new build
installChunkErrorReload();
// installable on a phone, the app shell kept for a fast start (built bundles only)
registerServiceWorker();

const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('Failed to find the root element');

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
      <ConfirmHost />
      <ToastHost />
      <NewBuildNotice />
    </QueryClientProvider>
  </React.StrictMode>
);
