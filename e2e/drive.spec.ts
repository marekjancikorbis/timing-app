// Plan §8 e2e: arm → countdown → replayed GPS → run saved → appears in history.
// Time is Playwright's fake clock; GPS fixes are pushed through the dev-only `?gps=test` source.

import type { Page } from '@playwright/test';
import { createProjection } from '../src/engine/geo';
import { expect, test } from './fixtures';

const proj = createProjection(14.42, 50.08);
const ll = (x: number) => proj.toLonLat({ x, y: 0 });

/** A straight 1 km stage heading east, as a GPX file. */
function straightGpx(): Buffer {
  const pts = [0, 500, 1000].map((x) => {
    const [lon, lat] = ll(x);
    return `<trkpt lat="${lat.toFixed(8)}" lon="${lon.toFixed(8)}"/>`;
  });
  return Buffer.from(
    `<?xml version="1.0"?><gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1"><trk><name>Test straight</name><trkseg>${pts.join('')}</trkseg></trk></gpx>`,
  );
}

/** Push one fix at x metres along the stage, stamped with the page's (fake) clock. */
async function fix(page: Page, x: number, spd: number) {
  const [lon, lat] = ll(x);
  await page.evaluate(
    ([lon, lat, spd]) => {
      const now = performance.timeOrigin + performance.now();
      window.__lapTimerGps?.push({ t: now, receivedAt: now, lat, lon, acc: 4, spd });
    },
    [lon, lat, spd] as const,
  );
}

test('standing start: arm, count down, drive, and the run is saved to history', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-10-12T10:00:00Z') });

  // A saved route to drive.
  await page.goto('/');
  await page.getByLabel('Import GPX').setInputFiles({
    name: 'straight.gpx',
    mimeType: 'application/gpx+xml',
    buffer: straightGpx(),
  });
  await page.getByRole('button', { name: 'Save route' }).click();
  await expect(page).toHaveURL(/\/routes\/[0-9a-f-]{36}$/);
  await page.getByRole('link', { name: 'Drive' }).click();
  await expect(page).toHaveURL(/\/drive\//);
  await page.goto(`${page.url()}?gps=test`);
  await expect(page.getByText('No runs yet.')).toBeVisible();

  // From here on, time only moves when the test says so.
  await page.clock.pauseAt(new Date('2026-10-12T10:01:00Z'));

  await page.getByRole('button', { name: 'Standing start' }).click();
  await page.getByRole('button', { name: 'Arm timer' }).click();
  const start = page.getByRole('button', { name: 'START' });
  await expect(start).toBeDisabled();

  // Parked 5 m behind the line for 3 s: staged.
  for (let i = 0; i < 3; i++) {
    await fix(page, -5, 0);
    await page.clock.runFor(1000);
  }
  await expect(start).toBeEnabled();
  await start.click();

  // 5-second countdown with lights, then GO.
  const countdown = page.getByTestId('countdown');
  await expect(countdown).toHaveText('5');
  await expect(page.getByRole('list', { name: '5 seconds' }).getByRole('listitem')).toHaveCount(5);
  await page.clock.runFor(1000);
  await expect(countdown).toHaveText('4');
  await page.clock.runFor(4000);

  // Live screen; drive 1 km at 30 m/s, one fix per second.
  await expect(page.getByTestId('timer')).toBeVisible();
  for (let x = -5; x <= 1060; x += 30) {
    await fix(page, x, x === -5 ? 0 : 30);
    await page.clock.runFor(1000);
  }

  await expect(page.getByTestId('result-status')).toHaveText(/^Valid run/);
  const history = page.getByRole('list', { name: 'History' });
  await expect(history.getByRole('listitem')).toHaveCount(1);
  await expect(history).toContainText('standing');

  // It's in IndexedDB: still there after a reload. (Let time flow again first: a paused fake
  // clock carries over the reload and would stall the new page's timers.)
  await page.clock.resume();
  await page.reload();
  await expect(page.getByRole('list', { name: 'History' }).getByRole('listitem')).toHaveCount(1);

  // Full history: the run is the best standing run; its detail page shows sectors and charts.
  await page.getByRole('link', { name: 'Full history and analysis' }).click();
  await expect(page).toHaveURL(/\/history$/);
  await expect(page.getByRole('button', { name: 'Standing' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(page.getByTestId('best')).toHaveText(/^0:3\d\.\d\d$/);
  const best = (await page.getByTestId('best').textContent()) ?? '';
  await expect(page.getByTestId('run-row')).toHaveCount(1);
  await page.getByRole('button', { name: best, exact: true }).click();
  await expect(page).toHaveURL(/\/runs\//);
  await expect(page.getByTestId('run-time')).toHaveText(best);
  await expect(page.getByTestId('sector-row')).toHaveCount(10); // 1 km in 100 m sectors
  await expect(page.getByRole('img', { name: 'km/h' })).toBeVisible();
});
