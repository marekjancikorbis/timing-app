import { RouterProvider } from '@tanstack/react-router';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { registerPwa } from './app/pwa';
import { router } from './app/router';
import './index.css';

const root = document.getElementById('root');
if (!root) throw new Error('#root missing from index.html');
void registerPwa();
createRoot(root).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
