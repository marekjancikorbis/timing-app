// The installable, offline-capable app (Phase 5). Runs against the production build, because the
// service worker is only generated there.
import { PREVIEW_PORT } from '../playwright.config';
import { expect, test } from './fixtures';

test.use({ baseURL: `http://localhost:${PREVIEW_PORT}` });

test('has a web app manifest with icons', async ({ page, request }) => {
  await page.goto('/');
  const href = await page.locator('link[rel="manifest"]').getAttribute('href');
  expect(href).toBeTruthy();
  const manifest = await (await request.get(href as string)).json();
  expect(manifest).toMatchObject({ name: 'Lap Timer', display: 'standalone', start_url: '/' });
  const sizes = manifest.icons.map((i: { sizes: string }) => i.sizes);
  expect(sizes).toEqual(expect.arrayContaining(['192x192', '512x512']));
  for (const icon of manifest.icons) {
    const res = await request.get(`/${icon.src}`);
    expect(res.headers()['content-type']).toBe('image/png');
  }
});

test('works offline once the service worker has cached the app', async ({ page, context }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Routes' })).toBeVisible();
  // The worker installs and precaches the app. In 'prompt' mode it doesn't take over the open
  // page (that could interrupt a run); the next load is served by it.
  await expect(page.getByRole('status').filter({ hasText: 'works offline' })).toBeVisible();
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();
  expect(await page.evaluate(() => navigator.serviceWorker.controller !== null)).toBe(true);

  await context.setOffline(true);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Routes' })).toBeVisible();
  // A deep link is served from the cached app shell too.
  await page.goto('/settings');
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
  await context.setOffline(false);
});
