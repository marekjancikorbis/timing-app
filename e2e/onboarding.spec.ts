// First run (Phase 5): the welcome and the safety terms come before anything else, once.
import { expect, test } from './fixtures';

test.use({ onboarded: false });

test('a new user must accept the closed-roads terms once', async ({ page }) => {
  await page.goto('/drive/some-route');
  await expect(page.getByRole('heading', { name: 'Lap Timer' })).toBeVisible();
  const start = page.getByRole('button', { name: 'Start' });
  await expect(start).toBeDisabled();
  await page.getByLabel(/closed tracks and closed roads/).check();
  await start.click();
  // The page that was asked for appears.
  await expect(page.getByText('This route no longer exists.')).toBeVisible();

  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Routes' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Routes' })).toBeVisible();
});
