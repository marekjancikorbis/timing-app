import { RouterProvider } from '@tanstack/react-router';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { initRemoteReporting, installGlobalHandlers, recordError } from './app/errors';
import { registerPwa } from './app/pwa';
import { router } from './app/router';
import './index.css';

const root = document.getElementById('root');
if (!root) throw new Error('#root missing from index.html');
installGlobalHandlers();
void initRemoteReporting();
void registerPwa();
createRoot(root, {
  // Render errors: caught ones are shown by the route's error screen, uncaught ones blank the page.
  onCaughtError: (error) => recordError(error, 'render'),
  onUncaughtError: (error) => recordError(error, 'render'),
}).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
