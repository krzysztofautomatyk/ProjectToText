import { expect, test, type Page } from '@playwright/test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import ts from 'typescript';

/** Opens a real folder through the app's `<input webkitdirectory>` fallback, as Firefox/Safari users would. */
async function openBrowserFolder(page: Page, dir: string) {
  await page.addInitScript(() => {
    (window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker = undefined;
  });
  await page.goto('/');
  const chooser = page.waitForEvent('filechooser');
  await page.getByTestId('btn-open-folder-empty').click();
  await (await chooser).setFiles(dir);
}

function makeFolder(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'ptt-badge-'));
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), body);
  }
  return dir;
}

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

  test('browser task prompt is masked when redaction is on and counted in the report, like native output', async ({
    page,
  }) => {
    await page.goto('/');
    const transpile = (file: string) =>
      ts.transpileModule(readFileSync(file, 'utf8'), {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
      }).outputText;
    const source = transpile('src/browserFs.ts');
    const secretsSource = transpile('src/secrets.ts');
    const token = ['sk-', 'abcdefghijklmnopqrstuvwx'].join('');
    const result = await page.evaluate(
      async ({ source, secretsSource, token }) => {
        const secretsUrl = URL.createObjectURL(new Blob([secretsSource], { type: 'text/javascript' }));
        const rewritten = source.replace(/from\s*(["'])\.\/secrets\1/, `from "${secretsUrl}"`);
        const url = URL.createObjectURL(new Blob([rewritten], { type: 'text/javascript' }));
        const { generateBrowserOutputWithStats } = await import(url);
        URL.revokeObjectURL(url);
        URL.revokeObjectURL(secretsUrl);

        const project = {
          rootName: 'fixture',
          files: new Map<string, File>([['src/main.rs', new File(['fn main() {}\n'], 'main.rs')]]),
        };
        const prompt = `Why does this key fail: ${token} ?`;
        const masked = await generateBrowserOutputWithStats(project, ['src/main.rs'], 'xml', {
          redactSecrets: true,
          taskPrompt: prompt,
        });
        const verbatim = await generateBrowserOutputWithStats(project, ['src/main.rs'], 'xml', {
          redactSecrets: false,
          taskPrompt: prompt,
        });
        return {
          maskedText: masked.text as string,
          maskedCount: masked.redactions.totalRedactions as number,
          verbatimText: verbatim.text as string,
        };
      },
      { source, secretsSource, token },
    );
    expect(result.maskedText).not.toContain(token);
    expect(result.maskedText).toContain('[REDACTED: OPENAI_API_KEY]');
    expect(result.maskedCount).toBeGreaterThanOrEqual(1);
    expect(result.verbatimText).toContain(token);
  });

  test('browser ignore semantics match native .gitignore and .pttignore fixtures (nested rules, negation, parent pruning, fail-closed)', async ({
    page,
  }) => {
    await page.goto('/');
    const transpile = (file: string) =>
      ts.transpileModule(readFileSync(file, 'utf8'), {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
      }).outputText;
    const source = transpile('src/browserFs.ts');
    const secretsSource = transpile('src/secrets.ts');
    const result = await page.evaluate(async ({ source, secretsSource }) => {
      const secretsUrl = URL.createObjectURL(new Blob([secretsSource], { type: 'text/javascript' }));
      const rewritten = source.replace(/from\s*(["'])\.\/secrets\1/, `from "${secretsUrl}"`);
      const url = URL.createObjectURL(new Blob([rewritten], { type: 'text/javascript' }));
      const { applyIgnoreSemanticsToFileMap } = await import(url);
      URL.revokeObjectURL(url);
      URL.revokeObjectURL(secretsUrl);

      // Fixture 1: nested_rules_match_git_and_fallback_with_parent_pruning + .gitignore
      const raw1 = new Map<string, File>([
        ['.gitignore', new File(['secret.env\n'], '.gitignore')],
        ['.pttignore', new File(['*.log\nblocked/\n'], '.pttignore')],
        ['src/.pttignore', new File(['!keep.log\nprivate/\n!private/key.txt\n'], '.pttignore')],
        ['src/keep.log', new File(['fixture'], 'keep.log')],
        ['src/noise.log', new File(['fixture'], 'noise.log')],
        ['src/private/key.txt', new File(['fixture'], 'key.txt')],
        ['blocked/key.txt', new File(['fixture'], 'key.txt')],
        ['secret.env', new File(['KEY=1'], 'secret.env')],
        ['normal.rs', new File(['fixture'], 'normal.rs')],
      ]);
      const res1 = await applyIgnoreSemanticsToFileMap(raw1);
      const kept1 = Array.from(res1.files.keys()).sort();

      // Fixture 2: malformed foreign .gitignore does NOT abort walk
      const raw2 = new Map<string, File>([
        ['sub/.gitignore', new File(['[\n\\\n**[\n!\n'], '.gitignore')],
        ['sub/ok.txt', new File(['ok'], 'ok.txt')],
      ]);
      const res2 = await applyIgnoreSemanticsToFileMap(raw2);
      const kept2 = Array.from(res2.files.keys()).sort();

      // Fixture 3: malformed .pttignore fails closed
      let pttFailedClosed = false;
      try {
        const raw3 = new Map<string, File>([
          ['.pttignore', new File(['\\\n'], '.pttignore')],
          ['ok.txt', new File(['ok'], 'ok.txt')],
        ]);
        await applyIgnoreSemanticsToFileMap(raw3);
      } catch {
        pttFailedClosed = true;
      }

      return {
        kept1,
        skippedReasons: res1.skipped.map((s: { path: string; reason: string }) => `${s.path}:${s.reason}`).sort(),
        kept2,
        pttFailedClosed,
      };
    }, { source, secretsSource });

    expect(result.kept1).toEqual([
      '.gitignore',
      '.pttignore',
      'normal.rs',
      'src/.pttignore',
      'src/keep.log',
    ]);
    expect(result.skippedReasons).toContain('blocked:pttignore');
    expect(result.skippedReasons).toContain('src/private:pttignore');
    expect(result.skippedReasons).toContain('src/noise.log:pttignore');
    expect(result.skippedReasons).toContain('secret.env:gitignore');
    expect(result.kept2).toEqual(['sub/.gitignore', 'sub/ok.txt']);
    expect(result.pttFailedClosed).toBe(true);
  });

  test('redaction badge shows scanned and skipped counts for a clean folder and a folder with a secret', async ({
    page,
  }) => {
    const token = ['sk-', 'abcdefghijklmnopqrstuvwx'].join('');
    const clean = makeFolder({ 'src/main.rs': 'fn main() {}\n', 'README.md': '# demo\n' });
    const dirty = makeFolder({ 'src/main.rs': `const KEY = "${token}";\n`, 'README.md': '# demo\n' });
    try {
      const badge = page.getByTestId('redaction-badge');

      await openBrowserFolder(page, clean);
      await expect(badge).toContainText('0 secrets masked');
      await expect(badge).toContainText('2 scanned');
      await expect(badge).toContainText('0 skipped');

      await openBrowserFolder(page, dirty);
      await expect(badge).toContainText('1 secrets masked');
      await expect(badge).toContainText('2 scanned');
      await expect(badge).toContainText('0 skipped');
    } finally {
      rmSync(clean, { recursive: true, force: true });
      rmSync(dirty, { recursive: true, force: true });
    }
  });
});
