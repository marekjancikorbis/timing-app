import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { defineConfig } from 'vitest/config';

const DAY_S = 24 * 60 * 60;

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    // Service worker + manifest (§9.4, Phase 5). 'prompt': a new version waits until the user
    // reloads; an automatic reload in the middle of a timed run would lose it.
    VitePWA({
      registerType: 'prompt',
      injectRegister: false, // registered from src/app/pwa.ts
      includeAssets: ['favicon-48x48.png', 'apple-touch-icon-180x180.png'],
      manifest: {
        name: 'Lap Timer',
        short_name: 'Lap Timer',
        description: 'GPS lap and stage timer with sectors and a live delta.',
        theme_color: '#0a0a0a',
        background_color: '#0a0a0a',
        display: 'standalone',
        orientation: 'any',
        start_url: '/',
        scope: '/',
        icons: [
          { src: 'pwa-192x192.png', sizes: '192x192', type: 'image/png' },
          { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png' },
          {
            src: 'maskable-512x512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,mjs,css,html,png,svg,webmanifest}'],
        // The main chunk (MapLibre) is ~1.8 MB; the default 2 MiB limit is too close.
        maximumFileSizeToCacheInBytes: 6 * 1024 * 1024,
        navigateFallback: 'index.html',
        cleanupOutdatedCaches: true,
        runtimeCaching: [
          {
            // Map style, sprites and fonts: small, change rarely.
            urlPattern: ({ url }) =>
              url.host === 'tiles.openfreemap.org' && !/\/planet\/|\.pbf$/.test(url.pathname),
            handler: 'StaleWhileRevalidate',
            options: {
              cacheName: 'map-style',
              expiration: { maxEntries: 200, maxAgeSeconds: 30 * DAY_S },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            // Vector tiles: cached as they are viewed, so a saved route's map works offline.
            urlPattern: ({ url }) => url.host === 'tiles.openfreemap.org',
            handler: 'CacheFirst',
            options: {
              cacheName: 'map-tiles',
              expiration: { maxEntries: 3000, maxAgeSeconds: 30 * DAY_S, purgeOnQuotaError: true },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
    }),
  ],
  build: {
    // MapLibre alone is ~1.2 MB and only loads with the map pages (lazy routes in router.tsx).
    chunkSizeWarningLimit: 1300,
  },
  test: {
    include: ['src/**/*.test.{ts,tsx}', 'tests/**/*.test.ts'],
    // The simulation-heavy suites (properties, accuracy) take several seconds per test when the
    // whole suite runs in parallel; 5 s made them flaky.
    testTimeout: 60_000,
    coverage: {
      // Pure logic only. React components (*.tsx) and thin browser/map adapters are left out.
      include: [
        'src/engine/**',
        'src/data/**',
        'src/features/**/*.ts',
        'src/workers/**',
        'src/gps/simulator.ts',
        'src/gps/manualGps.ts',
        'src/feedback/callouts.ts',
      ],
      exclude: ['**/*.test.ts', 'src/data/db.ts', 'src/workers/*.worker.ts'],
    },
  },
});
