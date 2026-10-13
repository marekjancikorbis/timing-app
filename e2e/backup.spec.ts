// Backup → delete everything → restore: the route comes back. Also checks route/history exports.
import { readFileSync } from 'node:fs';
import { expect, test } from './fixtures';

test('download a backup, delete the route, restore it from the file', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Import GPX').setInputFiles('tests/fixtures/gpx/stage-track.gpx');
  await page.getByRole('button', { name: 'Save route' }).click();
  await expect(page).toHaveURL(/\/routes\/[0-9a-f-]{36}$/);

  // The route's history page exports its line as GPX.
  await page.getByRole('link', { name: 'Routes', exact: true }).click();
  await page.getByRole('button', { name: 'History' }).click();
  const gpxDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Route GPX' }).click();
  const gpx = await gpxDownload;
  expect(gpx.suggestedFilename()).toBe('Forest stage.gpx');
  expect(readFileSync(await gpx.path(), 'utf8')).toContain('<trkpt');

  // Back up.
  await page.getByRole('link', { name: 'Settings' }).click();
  const backupDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download backup' }).click();
  const backup = await backupDownload;
  expect(backup.suggestedFilename()).toMatch(/^laptimer-backup-\d{4}-\d\d-\d\d\.json\.gz$/);
  const file = await backup.path();
  await expect(page.getByText('Backup downloaded.')).toBeVisible();

  // Delete the route.
  await page.getByRole('link', { name: 'Routes', exact: true }).click();
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  await page.getByRole('button', { name: 'Delete with all runs' }).click();
  await expect(page.getByText('No routes yet')).toBeVisible();

  // Restore: a wrong file is refused, the backup brings the route back.
  await page.getByRole('link', { name: 'Settings' }).click();
  await page.getByLabel('Restore backup file').setInputFiles('tests/fixtures/gpx/stage-track.gpx');
  await expect(page.getByRole('alert')).toHaveText('This is not a Lap Timer backup (not JSON).');
  await page.getByLabel('Restore backup file').setInputFiles(file);
  await expect(page.getByRole('dialog')).toContainText('1 routes, 0 runs');
  await page.getByRole('button', { name: 'Replace all my data' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Restored' })).toHaveText(
    'Restored 1 route, 0 runs and 0 GPS logs.',
  );
  await page.getByRole('link', { name: 'Routes', exact: true }).click();
  await expect(page.getByText('Forest stage')).toBeVisible();
});
