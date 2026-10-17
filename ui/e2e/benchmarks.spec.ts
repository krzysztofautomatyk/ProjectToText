import { expect, test } from '@playwright/test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

async function openBrowserFolder(page: import('@playwright/test').Page, dir: string) {
  await page.addInitScript(() => {
    (window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker = undefined;
  });
  await page.goto('/');
  const chooser = page.waitForEvent('filechooser');
  await page.getByTestId('btn-open-folder-empty').click();
  await (await chooser).setFiles(dir);
}

function makeFolder(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'ptt-benchmarks-'));
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), body);
  }
  return dir;
}

test('benchmark artifacts stay visible but are unchecked by selection presets', async ({ page }) => {
  const dir = makeFolder({
    'src/main.rs': 'fn main() {}\n',
    'benchmarks/context-v1/source.rs': 'fn generated_benchmark() {}\n',
    'benchmarks/context-v1/previous.xml': '<project_context/>\n',
  });
  try {
    await openBrowserFolder(page, dir);
    await expect(page.getByRole('button', { name: 'All clean' })).toBeEnabled();
    await expect(page.locator('[role="treeitem"][data-path="benchmarks"]')).toBeVisible();
    await expect(page.getByRole('checkbox', { name: 'Select folder benchmarks' })).not.toBeChecked();
    await expect(page.getByRole('checkbox', { name: 'Select file previous.xml' })).toBeVisible();
    await expect(page.getByRole('checkbox', { name: 'Select file source.rs' })).not.toBeChecked();
    await expect(page.getByRole('checkbox', { name: 'Select file main.rs' })).toBeChecked();

    const presets = ['Source', '+ Docs', 'All clean', 'Core Full + Rest Skeleton'];
    for (const preset of presets) {
      await page.getByRole('button', { name: preset, exact: true }).click();
      await expect(page.getByRole('checkbox', { name: 'Select file previous.xml' })).not.toBeChecked();
      await expect(page.getByRole('checkbox', { name: 'Select file source.rs' })).not.toBeChecked();
      await expect(page.getByRole('checkbox', { name: 'Select file main.rs' })).toBeChecked();
      await expect(page.getByRole('checkbox', { name: 'Select folder benchmarks' })).not.toBeChecked();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
