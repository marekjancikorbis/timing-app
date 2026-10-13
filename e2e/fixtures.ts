import { test as base, expect, type Page } from '@playwright/test';

/** The only host whose failures are expected: map tiles are blocked so tests stay offline. */
const TILE_HOST = 'tiles.openfreemap.org';

/** A minimal map style, so MapLibre (and Terra Draw) start without the internet. */
const LOCAL_STYLE = {
  version: 8,
  sources: {},
  layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#1f2937' } }],
};

interface Fixtures {
  /** Serve LOCAL_STYLE instead of aborting the style request. */
  localMapStyle: boolean;
  /** Problems seen during the test; the test fails if any remain. */
  problems: string[];
}

export const test = base.extend<Fixtures>({
  localMapStyle: [false, { option: true }],
  problems: [
    async ({ page, localMapStyle }, use) => {
      const problems: string[] = [];
      await page.route(`**/${TILE_HOST}/**`, (route) =>
        localMapStyle && route.request().url().includes('/styles/')
          ? route.fulfill({ json: LOCAL_STYLE })
          : route.abort(),
      );
      const fromTiles = (url: string) => new URL(url).host === TILE_HOST;
      page.on('pageerror', (e) => problems.push(`page error: ${e.message}`));
      page.on('requestfailed', (r) => {
        if (!fromTiles(r.url())) problems.push(`request failed: ${r.url()} (${r.failure()?.errorText})`);
      });
      page.on('response', (r) => {
        if (r.status() >= 400 && !fromTiles(r.url())) problems.push(`HTTP ${r.status()}: ${r.url()}`);
      });
      page.on('console', (m) => {
        if (m.type() !== 'error') return;
        const text = m.text();
        // Network failures are checked precisely above, by URL; the console only repeats them
        // without the URL. MapLibre logs the blocked tile/style fetches with the host in the text.
        if (/^Failed to load resource/.test(text) || text.includes(TILE_HOST)) return;
        problems.push(`console error: ${text}`);
      });
      await use(problems);
      expect(problems, 'unexpected errors during the test').toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };

/** "23 sectors, last sector 130 m" → 23 */
export async function sectorCount(page: Page): Promise<number> {
  const text = (await page.getByRole('status').filter({ hasText: /sector/ }).textContent()) ?? '';
  return Number(/^(\d+) sector/.exec(text)?.[1]);
}
