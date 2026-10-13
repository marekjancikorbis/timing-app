// Every test fails on page errors, console errors, failed requests or HTTP errors, except for the
// map tiles, which are blocked so the tests never need the internet (see fixtures.ts).
import { expect, sectorCount as sectors, test } from './fixtures';

test('import a GPX route, change the interval, save, and find it after a reload', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText('No routes yet')).toBeVisible();

  // Import → the editor opens with the track
  await page.getByLabel('Import GPX').setInputFiles('tests/fixtures/gpx/stage-track.gpx');
  await expect(page).toHaveURL(/\/routes\/new$/);
  await expect(page.getByPlaceholder('e.g. Hill climb')).toHaveValue('Forest stage');
  await expect(page.getByTestId('route-length')).toContainText('source: gpx');

  // 100 m default: ~16 sectors; 500 m: 3
  const before = await sectors(page);
  expect(before).toBeGreaterThan(10);
  const box = page.getByLabel('Sector interval in metres');
  await box.fill('500');
  await box.press('Enter');
  await expect.poll(() => sectors(page)).toBe(3);

  // Save → the URL gets the new id
  await page.getByRole('button', { name: 'Save route' }).click();
  await expect(page).toHaveURL(/\/routes\/[0-9a-f-]{36}$/);
  await expect(page.getByText('Unsaved changes')).toBeHidden();

  // Reload: everything came from IndexedDB
  await page.reload();
  await expect(page.getByPlaceholder('e.g. Hill climb')).toHaveValue('Forest stage');
  await expect(page.getByLabel('Sector interval in metres')).toHaveValue('500');
  await expect.poll(() => sectors(page)).toBe(3);

  await page.getByRole('link', { name: 'Routes', exact: true }).click();
  await expect(page.getByText('Forest stage')).toBeVisible();
  await expect(page.getByText(/Stage · 1\.\d\d km · 500 m sectors/)).toBeVisible();
});

test('a broken GPX file shows an error and stays on the list', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Import GPX').setInputFiles('tests/fixtures/gpx/bad-truncated.gpx');
  await expect(page.getByRole('alert')).toContainText('not valid XML');
  await expect(page).toHaveURL(/\/$/);
});

test('every page renders without errors', async ({ page }) => {
  for (const path of ['/', '/routes/new', '/record', '/logger', '/settings']) {
    await page.goto(path);
    await expect(page.getByRole('navigation')).toBeVisible();
  }
});

test.describe('drawing on the map', () => {
  test.use({ localMapStyle: true });

  test('click points, press Enter: the route length and sectors appear', async ({ page }) => {
    await page.goto('/routes/new');
    await expect(page.getByText('Click to add points along the route')).toBeVisible();
    const canvas = page.locator('[data-testid="map"] canvas');
    await expect(canvas).toBeVisible();
    // Wait for the style and Terra Draw: in line mode Terra Draw sets a crosshair cursor.
    await expect.poll(() => canvas.evaluate((c) => getComputedStyle(c).cursor)).toBe('crosshair');
    const box = (await canvas.boundingBox()) as { x: number; y: number; width: number; height: number };
    const at = (fx: number, fy: number) => ({ x: box.x + box.width * fx, y: box.y + box.height * fy });
    for (const p of [at(0.2, 0.3), at(0.4, 0.6), at(0.6, 0.4), at(0.8, 0.7)]) {
      await page.mouse.click(p.x, p.y);
    }
    await page.keyboard.press('Enter');

    await expect(page.getByTestId('route-length')).toContainText(
      /Length \d+(\.\d+)? (km|m) · source: drawn/,
    );
    expect(await sectors(page)).toBeGreaterThan(1);
    await expect(page.getByText('Drag points to adjust the line')).toBeVisible();
    await expect(page.getByText('Unsaved changes')).toBeVisible();

    // Edit: drag the second vertex further down; the line gets longer.
    const lengthText = () => page.getByTestId('route-length').textContent();
    const before = await lengthText();
    const from = at(0.4, 0.6);
    const to = at(0.4, 0.95);
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 10 });
    await page.mouse.up();
    await expect.poll(lengthText).not.toBe(before);
  });
});
