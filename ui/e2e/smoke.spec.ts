import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

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

  test('folder history panel opens from the header', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('btn-folder-history').click();
    await expect(page.getByRole('heading', { name: 'Folder history' })).toBeVisible();
    await expect(page.getByText('No folders in history')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('heading', { name: 'Folder history' })).toBeHidden();
  });

  test('Escape dismisses custom projects', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'Open custom projects' }).click();
    await expect(page.getByRole('heading', { name: 'Custom projects' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('heading', { name: 'Custom projects' })).toBeHidden();
  });

  test('browser pack decodes BOM text and preserves Markdown fences', async ({ page }) => {
    await page.goto('/');
    const source = ts.transpileModule(readFileSync('src/browserFs.ts', 'utf8'), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    }).outputText;
    const result = await page.evaluate(async (source) => {
      const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
      const { generateBrowserOutput, readBrowserFilePreview } = await import(url);
      URL.revokeObjectURL(url);
      const text = 'Zażółć 😀';
      const bytes = [0xff, 0xfe];
      for (let i = 0; i < text.length; i++) bytes.push(text.charCodeAt(i) & 255, text.charCodeAt(i) >> 8);
      const utf16 = new File([new Uint8Array(bytes)], 'view.xaml');
      const content = '```\n~~~~\n``````\n';
      const project = { rootName: 'fixture', files: new Map([
        ['view.xaml', utf16], ['notes.md', new File([content], 'notes.md')],
      ]) };
      const json = JSON.parse(await generateBrowserOutput(project, ['view.xaml'], 'json'));
      const preview = await readBrowserFilePreview(project, 'view.xaml');
      const markdown = await generateBrowserOutput(project, ['notes.md'], 'markdown');
      return { decoded: json.files[0].content, preview: preview.content, binary: preview.binary, markdown };
    }, source);
    expect(result.decoded).toBe('Zażółć 😀');
    expect(result.preview).toBe('Zażółć 😀');
    expect(result.binary).toBe(false);
    expect(result.markdown).toContain('\n```````md\n');
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
