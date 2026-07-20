import { expect, test } from '@playwright/test';

test.describe('ProjectToText browser shell', () => {
  test('loads empty state and brand chrome', async ({ page }) => {
    await page.goto('/');

    await expect(page.getByTestId('app-root')).toBeVisible();
    await expect(page.getByTestId('brand')).toContainText('ProjectToText');
    await expect(page.getByTestId('empty-open-project')).toBeVisible();
    await expect(page.getByTestId('empty-open-project')).toContainText('Open a project');
    await expect(page.getByTestId('btn-open-folder')).toBeVisible();
    await expect(page.getByTestId('btn-open-folder-empty')).toBeVisible();
  });

  test('theme toggle cycles without crashing', async ({ page }) => {
    await page.goto('/');
    const themeBtn = page.getByRole('button', { name: /Theme/i });
    await expect(themeBtn).toBeVisible();
    await themeBtn.click();
    await themeBtn.click();
    await expect(page.getByTestId('app-root')).toBeVisible();
    await expect(page.getByTestId('brand')).toContainText('ptt');
  });

  test('help shortcut opens shortcuts dialog', async ({ page }) => {
    await page.goto('/');
    await page.keyboard.press('?');
    // Dialog title from help overlay
    await expect(page.getByText(/keyboard|shortcut|help/i).first()).toBeVisible({
      timeout: 5000,
    });
  });
});
