// Themes (Phase 5): the setting recolours the whole app and survives a reload from the first paint.
import { expect, test } from './fixtures';

const bodyBg = (page: import('@playwright/test').Page) =>
  page.evaluate(() => getComputedStyle(document.body).backgroundColor);

test('switch to sunlight and light themes; the choice is applied before the app loads', async ({
  page,
}) => {
  await page.goto('/settings');
  const dark = await bodyBg(page);
  await page.getByLabel('Theme').selectOption('sunlight');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'sunlight');
  await expect.poll(() => bodyBg(page)).not.toBe(dark);
  expect(await bodyBg(page)).toMatch(/oklch\(1 0 0\)|rgb\(255, 255, 255\)/);

  // Reload: the inline script applies it before React starts.
  await page.reload();
  expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe('sunlight');

  await page.getByLabel('Theme').selectOption('light');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.getByLabel('Theme').selectOption('dark');
  await expect(page.locator('html')).not.toHaveAttribute('data-theme', /.+/);
  expect(await bodyBg(page)).toBe(dark);
});
