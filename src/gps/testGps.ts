import { ManualGps } from './manualGps';

declare global {
  interface Window {
    /** Dev builds only, with ?gps=test: lets Playwright push fixes (§8 e2e). */
    __lapTimerGps?: ManualGps;
  }
}

/** A pushable GPS source when running the dev server with `?gps=test`; otherwise null. */
export function testGpsFromUrl(): ManualGps | null {
  if (!import.meta.env.DEV || typeof window === 'undefined') return null;
  if (new URLSearchParams(window.location.search).get('gps') !== 'test') return null;
  const gps = new ManualGps();
  window.__lapTimerGps = gps;
  return gps;
}
