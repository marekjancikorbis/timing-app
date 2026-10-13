// Accessibility (Phase 5): axe-core finds no serious or critical WCAG A/AA problems on the main
// screens, in every theme. The map canvas is excluded (MapLibre's own controls are checked).
import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';

async function scan(page: Page, what: string) {
  const r = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .exclude('canvas')
    .analyze();
  const bad = r.violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map(
      (v) =>
        `${what}: ${v.id} (${v.impact}) ${v.nodes.map((n) => `${n.target.join(' ')} [${n.any[0]?.message ?? ''}]`).join(' | ')}`,
    );
  return bad;
}

async function routeWithRun(page: Page) {
  await page.goto('/');
  await page.getByLabel('Import GPX').setInputFiles('tests/fixtures/gpx/stage-track.gpx');
  await page.getByRole('button', { name: 'Save route' }).click();
  await expect(page).toHaveURL(/\/routes\/[0-9a-f-]{36}$/);
}

for (const theme of ['dark', 'light', 'sunlight'] as const) {
  test(`main screens pass axe in the ${theme} theme`, async ({ page }) => {
    test.setTimeout(90_000);
    const problems: string[] = [];
    await page.goto('/settings');
    await page.getByLabel('Theme').selectOption(theme);
    if (theme !== 'dark') await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    problems.push(...(await scan(page, 'settings')));

    await routeWithRun(page);
    problems.push(...(await scan(page, 'editor')));
    const routeId = page.url().split('/').at(-1) as string;

    await page.goto('/');
    await expect(page.getByText('Forest stage')).toBeVisible();
    problems.push(...(await scan(page, 'routes')));

    await page.goto(`/routes/${routeId}/history`);
    await expect(page.getByTestId('best')).toBeVisible();
    problems.push(...(await scan(page, 'history')));

    await page.goto(`/drive/${routeId}`);
    await expect(page.getByRole('button', { name: 'Arm timer' })).toBeVisible();
    problems.push(...(await scan(page, 'drive')));

    await page.goto('/logger');
    problems.push(...(await scan(page, 'logger')));
    expect(problems).toEqual([]);
  });
}

test.describe('first run', () => {
  test.use({ onboarded: false });
  test('the welcome screen passes axe', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('button', { name: 'Start' })).toBeVisible();
    expect(await scan(page, 'onboarding')).toEqual([]);
  });
});
