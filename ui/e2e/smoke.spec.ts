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
    const transpile = (file: string) =>
      ts.transpileModule(readFileSync(file, 'utf8'), {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
      }).outputText;
    const source = transpile('src/browserFs.ts');
    const secretsSource = transpile('src/secrets.ts');
    const result = await page.evaluate(async ({ source, secretsSource }) => {
      // browserFs.ts imports ./secrets; load that module from its own blob and point the import at it.
      const secretsUrl = URL.createObjectURL(new Blob([secretsSource], { type: 'text/javascript' }));
      const rewritten = source.replace(/from\s*(["'])\.\/secrets\1/, `from "${secretsUrl}"`);
      const url = URL.createObjectURL(new Blob([rewritten], { type: 'text/javascript' }));
      const { generateBrowserOutput, readBrowserFilePreview } = await import(url);
      URL.revokeObjectURL(url);
      URL.revokeObjectURL(secretsUrl);
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
    }, { source, secretsSource });
    expect(result.decoded).toBe('Zażółć 😀');
    expect(result.preview).toBe('Zażółć 😀');
    expect(result.binary).toBe(false);
    expect(result.markdown).toContain('\n```````md\n');
  });

  test('browser pack emits source before docs and keeps the directory listing alphabetical', async ({
    page,
  }) => {
    await page.goto('/');
    const transpile = (file: string) =>
      ts.transpileModule(readFileSync(file, 'utf8'), {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
      }).outputText;
    const source = transpile('src/browserFs.ts');
    const secretsSource = transpile('src/secrets.ts');
    const xml = await page.evaluate(async ({ source, secretsSource }) => {
      const secretsUrl = URL.createObjectURL(new Blob([secretsSource], { type: 'text/javascript' }));
      const rewritten = source.replace(/from\s*(["'])\.\/secrets\1/, `from "${secretsUrl}"`);
      const url = URL.createObjectURL(new Blob([rewritten], { type: 'text/javascript' }));
      const { generateBrowserOutput } = await import(url);
      URL.revokeObjectURL(url);
      URL.revokeObjectURL(secretsUrl);
      const paths = ['README.md', '.github/workflows/ci.yml', 'src/main.rs', 'tests/smoke.rs', 'Cargo.toml'];
      const project = {
        rootName: 'fixture',
        files: new Map(paths.map((p) => [p, new File([`// ${p}\n`], p.split('/').pop() ?? p)])),
      };
      return generateBrowserOutput(project, paths, 'xml');
    }, { source, secretsSource });
    const filePaths = [...xml.matchAll(/<file path="([^"]+)"/g)].map((m) => m[1]);
    expect(filePaths).toEqual([
      'src/main.rs',
      'Cargo.toml',
      'tests/smoke.rs',
      '.github/workflows/ci.yml',
      'README.md',
    ]);
    const structure = xml.slice(xml.indexOf('<directory_structure>'), xml.indexOf('</directory_structure>'));
    const listed = structure
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.includes('/') || line.includes('.'));
    expect(listed).toEqual([
      '.github/workflows/ci.yml',
      'Cargo.toml',
      'README.md',
      'src/main.rs',
      'tests/smoke.rs',
    ]);
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
