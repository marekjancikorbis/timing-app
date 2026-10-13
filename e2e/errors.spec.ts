// Error monitoring (Phase 5): an uncaught error lands in Settings → Error log, without coordinates.
import { expect, test } from './fixtures';

test('uncaught errors are logged on the device with locations removed', async ({
  page,
  problems,
}) => {
  await page.goto('/settings');
  await expect(page.getByTestId('error-count')).toHaveText('No errors recorded on this device.');

  await page.evaluate(() => {
    setTimeout(() => {
      throw new Error('test failure near 50.0812345, 14.4212345');
    });
  });
  await expect(page.getByTestId('error-count')).toHaveText(
    '1 error recorded. Locations are removed.',
  );
  await page.getByRole('button', { name: 'Show' }).click();
  await expect(page.getByText('test failure near [coord], [coord]')).toBeVisible();

  // Survives a reload; Clear empties it.
  await page.reload();
  await expect(page.getByTestId('error-count')).toContainText('1 error');
  await page.getByRole('button', { name: 'Clear' }).click();
  await expect(page.getByTestId('error-count')).toHaveText('No errors recorded on this device.');

  // The error was thrown on purpose: don't fail the test on it.
  problems.splice(0, problems.length);
});
