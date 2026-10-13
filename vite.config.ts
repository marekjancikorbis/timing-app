import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react(), tailwindcss()],
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
