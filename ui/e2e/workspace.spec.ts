import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const calls: { command: string; args?: Record<string, unknown> }[] = [];
    let revision = 0;
    let failGeneration = false;
    const fullOutput = 'BEGIN\n' + 'context line\n'.repeat(14_000) + 'END_COMPLETE_OUTPUT';
    const fixture = window as unknown as {
      __TAURI_INTERNALS__: unknown;
      bridgeFixture: { calls: typeof calls; copied: string; saved: string; fail: () => void };
    };
    fixture.bridgeFixture = { calls, copied: '', saved: '', fail: () => { failGeneration = true; } };
    fixture.__TAURI_INTERNALS__ = {
      transformCallback: () => 1,
      unregisterCallback: () => {},
      invoke: async (command: string, args?: Record<string, unknown>) => {
        calls.push({ command, args });
        if (command === 'startup_folder') return '/fixture/project';
        if (command === 'scan_folder') return {
          root: '/fixture/project',
          revision: ++revision,
          junkDirs: ['.git', 'node_modules', 'target'],
          gitContext: {
            isGitRepo: true,
            currentBranch: 'main',
            baseBranch: 'main',
            fileStatuses: { 'src/main.rs': 'M' },
            modifiedFiles: ['src/main.rs'],
            branchChangedFiles: ['src/main.rs'],
            recentCommits: ['abc1234 initial commit'],
          },
          nodes: [
            { path: 'src', name: 'src', is_dir: true, selected: false },
            { path: 'src/main.rs', name: 'main.rs', is_dir: false, size: 200, selected: false, git_status: 'M' },
            { path: 'src/lib.rs', name: 'lib.rs', is_dir: false, size: 20, selected: false },
          ],
        };
        if (command === 'generate_output') {
          if (args?.revision !== revision) throw new Error('Wrong workspace revision');
          if (failGeneration) throw new Error('Ignore rules changed; refresh the project before packing');
          const opts = (args?.options ?? {}) as { full_preview?: boolean; redact_secrets?: boolean };
          const wantFull = !!opts.full_preview;
          const redactOn = opts.redact_secrets !== false;
          return {
            preview: wantFull ? fullOutput : fullOutput.slice(0, 100_000),
            truncatedPreview: !wantFull,
            totalBytes: fullOutput.length,
            totalChars: fullOutput.length,
            totalTokens: 48_000,
            filesPacked: Array.isArray(args?.selectedPaths) ? args.selectedPaths.length : 2,
            fileTokens: [
              { path: 'src/main.rs', bytes: 200, tokens: 45_000, mode: 'full' },
              { path: 'src/lib.rs', bytes: 20, tokens: 3_000, mode: 'full' },
            ],
            redactions: redactOn
              ? { totalRedactions: 2, kinds: [['OPENAI_API_KEY', 2]] }
              : { totalRedactions: 0, kinds: [] },
          };
        }
        if (command === 'get_full_packed_preview') {
          return fullOutput;
        }
        if (command === 'copy_packed_output') {
          fixture.bridgeFixture.copied = fullOutput;
          return;
        }
        if (command === 'save_packed_output') {
          fixture.bridgeFixture.saved = fullOutput;
          return true;
        }
        if (command === 'copy_to_clipboard') {
          fixture.bridgeFixture.copied = String(args?.text);
          return;
        }
        if (command === 'save_to_file') {
          fixture.bridgeFixture.saved = String(args?.text);
          return true;
        }
        if (command === 'plugin:updater|check') return null;
        if (command === 'plugin:event|listen') return 1;
        return null;
      },
    };
  });
});

test('startup folder scans once; selection uses revision; preview is bounded but copy is complete', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.path-chip')).toHaveText('/fixture/project');
  const output = page.locator('#panel-packed .output-text');
  await expect(output).toContainText('BEGIN');
  await expect(output).not.toContainText('END_COMPLETE_OUTPUT');
  expect((await output.innerText()).length).toBe(100_000);
  await page.getByRole('button', { name: /Show full preview/ }).click();
  await expect(output).toContainText('END_COMPLETE_OUTPUT');
  await page.getByRole('button', { name: 'Limit preview' }).click();
  await expect(output).not.toContainText('END_COMPLETE_OUTPUT');
  await page.getByRole('checkbox', { name: 'Select file lib.rs', exact: true }).uncheck();
  await expect.poll(async () => page.evaluate(() => {
    const { calls } = (window as unknown as { bridgeFixture: { calls: { command: string }[] } }).bridgeFixture;
    return calls.filter(call => call.command === 'generate_output').length;
  })).toBe(2);
  const scans = await page.evaluate(() => (window as unknown as { bridgeFixture: { calls: { command: string }[] } }).bridgeFixture.calls.filter(call => call.command === 'scan_folder').length);
  expect(scans).toBe(1);
  await page.getByRole('button', { name: /Copy packed/ }).click();
  await expect.poll(async () => page.evaluate(() => (window as unknown as { bridgeFixture: { copied: string } }).bridgeFixture.copied)).toContain('END_COMPLETE_OUTPUT');
  await page.getByRole('button', { name: 'Save packed output' }).click();
  await expect.poll(async () => page.evaluate(() => (window as unknown as { bridgeFixture: { saved: string } }).bridgeFixture.saved)).toContain('END_COMPLETE_OUTPUT');
  await page.getByRole('button', { name: 'Refresh' }).click();
  await expect.poll(async () => page.evaluate(() => (window as unknown as { bridgeFixture: { calls: { command: string }[] } }).bridgeFixture.calls.filter(call => call.command === 'scan_folder').length)).toBe(2);
  await expect.poll(async () => page.evaluate(() => {
    const calls = (window as unknown as { bridgeFixture: { calls: { command: string; args?: { revision: number } }[] } }).bridgeFixture.calls;
    return calls.filter(call => call.command === 'generate_output').at(-1)?.args?.revision;
  })).toBe(2);
});

test('tree shows estimated token totals and a token sort toggle', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.path-chip')).toHaveText('/fixture/project');
  // main.rs: 200 bytes ÷ 3.8 ≈ 53 tokens; lib.rs: 20 bytes ≈ 5; src sums both ≈ 58.
  await expect(page.locator('.tree-tokens', { hasText: '~58 tok' })).toBeVisible();
  await page.getByRole('button', { name: 'Expand' }).click();
  await expect(page.locator('.tree-tokens', { hasText: '~53 tok' })).toBeVisible();
  await expect(page.locator('.tree-tokens', { hasText: '~5 tok' })).toBeVisible();
  // Name order puts lib.rs first; token order puts the heavier main.rs first.
  const fileNames = () => page.locator('.tree-name', { hasText: /\.rs$/ }).allTextContents();
  await expect.poll(fileNames).toEqual(['lib.rs', 'main.rs']);
  await page.getByRole('button', { name: 'Sort: name' }).click();
  await expect(page.getByRole('button', { name: 'Sort: tokens' })).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(fileNames).toEqual(['main.rs', 'lib.rs']);
});

test('shows redaction badge, context budget bar, git badges, and prompt studio', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('redaction-badge')).toContainText('2 secrets masked');
  await expect(page.getByTestId('context-budget-bar')).toBeVisible();
  await expect(page.getByTestId('budget-progress-label')).toContainText('48k / 128k tokens');
  await expect(page.getByTestId('git-badge-src/main.rs')).toHaveText('M');

  await page.getByTestId('btn-top-consumers').click();
  await expect(page.getByTestId('top-consumers-drawer')).toBeVisible();

  await page.getByTestId('btn-prompt-studio').click();
  await expect(page.getByTestId('prompt-studio-panel')).toBeVisible();
});

test('failed freshness check removes previously generated context', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#panel-packed .output-text')).toContainText('BEGIN');
  await page.evaluate(() => (window as unknown as { bridgeFixture: { fail: () => void } }).bridgeFixture.fail());
  await page.getByRole('checkbox', { name: 'Select file lib.rs', exact: true }).uncheck();
  await expect(page.getByText(/Failed to generate packed output:.*Ignore rules changed/)).toBeVisible();
  await expect(page.locator('#panel-packed .output-text')).toBeHidden();
});
