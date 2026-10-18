import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';

const I18N_KEY = 'ptt.i18n.v1';

const ES_DOCS_LABEL = '📖 Documentación y Guía';

function esPack(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    code: 'es',
    name: 'Spanish',
    nativeName: 'Español',
    author: 'E2E',
    updatedAt: '2026-01-01T00:00:00.000Z',
    translations: {
      'footer.docs': ES_DOCS_LABEL,
      'status.about': 'Acerca de',
    },
    ...overrides,
  };
}

async function openLanguageStudio(page: Page) {
  await page.getByTestId('open-language-studio-btn').click();
  await expect(page.getByTestId('language-studio-modal')).toBeVisible();
}

async function importEsPack(page: Page, pack: unknown = esPack()) {
  await page.getByTestId('import-translation-pack-input').setInputFiles({
    name: 'ptt-language-es.json',
    mimeType: 'application/json',
    buffer: Buffer.from(typeof pack === 'string' ? pack : JSON.stringify(pack)),
  });
}

test.describe('i18n', () => {
  test('defaults to English and switching to Polish persists across reload', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('language-switcher-select')).toHaveValue('en');
    await expect(page.getByTestId('footer-docs-howto-btn')).toContainText('Documentation & How-To');

    await page.getByTestId('language-switcher-select').selectOption('pl');
    await expect(page.getByTestId('footer-docs-howto-btn')).toContainText('Dokumentacja i How-To');
    await expect(page.locator('html')).toHaveAttribute('lang', 'pl');

    await page.getByTestId('btn-prompt-studio').click();
    await expect(page.getByTestId('prompt-studio-panel')).toBeVisible();
    await expect(page.getByTestId('open-prompt-studio-btn')).toContainText('Zarządzaj promptami');
    await page.getByTestId('open-prompt-studio-btn').click();
    await expect(page.getByTestId('prompt-studio-modal')).toContainText('Zarządzaj promptami');
    await expect(page.getByTestId('create-custom-prompt-btn')).toContainText('Dodaj');
    await page.keyboard.press('Escape');

    await page.reload();
    await expect(page.getByTestId('language-switcher-select')).toHaveValue('pl');
    await expect(page.getByTestId('footer-docs-howto-btn')).toContainText('Dokumentacja i How-To');

    const stored = await page.evaluate((key) => localStorage.getItem(key), I18N_KEY);
    expect(JSON.parse(stored ?? '{}').activeLocale).toBe('pl');
  });

  test('documentation modal locale buttons drive the global language', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('footer-docs-howto-btn').click();
    await expect(page.getByTestId('docs-howto-modal')).toBeVisible();
    await expect(page.getByTestId('docs-howto-section')).toContainText('Open a Project & Path Hygiene');

    await page.getByTestId('docs-locale-pl').click();
    await expect(page.getByTestId('docs-locale-pl')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('docs-howto-section')).toContainText('Wczytanie Projektu i Higiena Ścieżek');
    await expect(page.getByTestId('language-switcher-select')).toHaveValue('pl');

    await page.getByTestId('docs-tab-examples').click();
    await expect(page.getByTestId('docs-example-card')).toHaveCount(7);
    await expect(page.getByTestId('docs-example-card').first()).toContainText('Głęboki Audyt Architektury');

    await page.getByTestId('docs-locale-en').click();
    await expect(page.getByTestId('docs-example-card').first()).toContainText('Deep Architecture');
  });

  test('imports a custom pack, activates it, and the footer shows the translation', async ({ page }) => {
    await page.goto('/');
    await openLanguageStudio(page);

    await importEsPack(page);
    await expect(page.getByTestId('language-row-es')).toBeVisible();
    await expect(page.getByTestId('language-coverage-es')).toContainText('2/');

    await page.getByTestId('activate-language-es').click();
    await page.getByTestId('language-studio-close-btn').click();
    await expect(page.getByTestId('language-studio-modal')).toBeHidden();

    await expect(page.getByTestId('language-switcher-select')).toHaveValue('es');
    await expect(page.getByTestId('footer-docs-howto-btn')).toContainText(ES_DOCS_LABEL);
    // Untranslated keys fall back to English.
    await expect(page.getByRole('button', { name: 'Open custom projects' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Acerca de' })).toBeVisible();

    await page.reload();
    await expect(page.getByTestId('footer-docs-howto-btn')).toContainText(ES_DOCS_LABEL);
  });

  test('creates a language, edits translations in the app editor, saves and exports it', async ({ page }) => {
    await page.goto('/');
    await openLanguageStudio(page);

    await page.getByTestId('new-language-code-input').fill('pl');
    await page.getByTestId('new-language-name-input').fill('Polish copy');
    await page.getByTestId('create-language-btn').click();
    await expect(page.getByTestId('create-language-error')).toBeVisible();

    await page.getByTestId('new-language-code-input').fill('es');
    await page.getByTestId('new-language-name-input').fill('Spanish');
    await page.getByTestId('new-language-native-input').fill('Español');
    await page.getByTestId('create-language-btn').click();
    await expect(page.getByTestId('language-row-es')).toBeVisible();

    await page.getByTestId('translation-editor-search').fill('footer.docs');
    const input = page.getByTestId('translation-input-footer.docs');
    await expect(input).toBeVisible();
    await input.fill(ES_DOCS_LABEL);
    await page.getByTestId('save-custom-language-btn').click();
    await expect(page.getByTestId('language-coverage-es')).toContainText('1/');

    await page.getByTestId('translation-editor-search').fill('footer.docs');
    await page.getByTestId('translation-editor-untranslated-filter').check();
    await expect(page.getByTestId('translation-input-footer.docs')).toHaveCount(0);
    await expect(page.getByTestId('translation-input-footer.docsBadge')).toBeVisible();

    const downloadPromise = page.waitForEvent('download');
    await page.getByTestId('export-single-language-btn').click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe('ptt-language-es.json');
    const exported = JSON.parse(readFileSync(await download.path(), 'utf8'));
    expect(exported.code).toBe('es');
    expect(exported.translations['footer.docs']).toBe(ES_DOCS_LABEL);

    await page.getByTestId('activate-language-es').click();
    await expect(page.getByTestId('footer-docs-howto-btn')).toContainText(ES_DOCS_LABEL);

    // Delete requires a second click, then falls back to English.
    await page.getByTestId('delete-custom-language-btn').click();
    await expect(page.getByTestId('language-row-es')).toBeVisible();
    await page.getByTestId('delete-custom-language-btn').click();
    await expect(page.getByTestId('language-row-es')).toHaveCount(0);
    await expect(page.getByTestId('footer-docs-howto-btn')).toContainText('Documentation & How-To');
    await expect(page.getByTestId('language-switcher-select')).toHaveValue('en');
  });

  test('template download is complete and importing hostile packs is rejected', async ({ page }) => {
    await page.goto('/');
    await openLanguageStudio(page);

    const downloadPromise = page.waitForEvent('download');
    await page.getByTestId('download-translation-template-btn').click();
    const template = JSON.parse(readFileSync(await (await downloadPromise).path(), 'utf8'));
    expect(template.schemaVersion).toBe(1);
    expect(template.translations['footer.docs']).toBe('📖 Documentation & How-To');
    expect(Object.keys(template.translations).length).toBeGreaterThan(300);

    // Prototype-pollution keys are refused outright.
    await importEsPack(page, '{"schemaVersion":1,"code":"zz","name":"Evil","nativeName":"Evil","updatedAt":"2026-01-01T00:00:00.000Z","translations":{"__proto__":{"polluted":"yes"}}}');
    await expect(page.getByTestId('language-issues')).toContainText('Forbidden');
    await expect(page.getByTestId('language-row-zz')).toHaveCount(0);

    // Invalid code.
    await importEsPack(page, esPack({ code: 'not a code!' }));
    await expect(page.getByTestId('language-issues')).toContainText('Invalid language code');

    // Unknown keys become warnings and are dropped.
    await importEsPack(page, esPack({ translations: { 'footer.docs': ES_DOCS_LABEL, 'does.not.exist': 'x' } }));
    await expect(page.getByTestId('language-issues')).toContainText('Unknown keys ignored');
    await expect(page.getByTestId('language-row-es')).toBeVisible();

    // Oversized value.
    await importEsPack(page, esPack({ code: 'fr', translations: { 'footer.docs': 'x'.repeat(10_001) } }));
    await expect(page.getByTestId('language-issues')).toContainText('exceeds 10000');
    await expect(page.getByTestId('language-row-fr')).toHaveCount(0);
    expect(await page.evaluate(() => ({} as Record<string, unknown>).polluted === undefined)).toBe(true);
  });

  test('exported prefs carry language packs and a merge import restores them', async ({ page }) => {
    await page.goto('/');
    await page.evaluate(
      ({ key, pack }) => {
        localStorage.setItem(key, JSON.stringify({ activeLocale: 'es', customPacks: [pack] }));
      },
      { key: I18N_KEY, pack: esPack() },
    );
    await page.reload();
    await expect(page.getByTestId('footer-docs-howto-btn')).toContainText(ES_DOCS_LABEL);

    // Export all preferences from the Custom projects panel.
    await page.getByTestId('btn-custom-projects').click();
    const downloadPromise = page.waitForEvent('download');
    await page.getByTestId('export-prefs-btn').click();
    const snapshotPath = await (await downloadPromise).path();
    const snapshot = JSON.parse(readFileSync(snapshotPath, 'utf8'));
    expect(snapshot.i18n.activeLocale).toBe('es');
    expect(snapshot.i18n.customPacks[0].code).toBe('es');
    await page.keyboard.press('Escape');

    // Wipe the language state and reload: back to English with no custom pack.
    await page.evaluate((key) => localStorage.removeItem(key), I18N_KEY);
    await page.reload();
    await expect(page.getByTestId('language-switcher-select')).toHaveValue('en');
    await expect(page.getByTestId('language-switcher-select').locator('option[value="es"]')).toHaveCount(0);

    // Import with Merge: the pack is restored, the local (English) locale is kept.
    await page.getByTestId('btn-custom-projects').click();
    const chooser = page.waitForEvent('filechooser');
    await page.getByTestId('import-prefs-btn').click();
    await (await chooser).setFiles(snapshotPath);
    await expect(page.getByTestId('import-prefs-dialog')).toBeVisible();
    await expect(page.getByTestId('import-i18n-packs')).toContainText('1');
    await page.getByTestId('import-mode-merge').check();
    await page.getByTestId('confirm-import-btn').click();
    await expect(page.getByTestId('import-prefs-dialog')).toBeHidden();

    await expect(page.getByTestId('language-switcher-select').locator('option[value="es"]')).toHaveCount(1);
    await expect(page.getByTestId('language-switcher-select')).toHaveValue('en');
    await page.getByTestId('language-switcher-select').selectOption('es');
    await expect(page.getByTestId('footer-docs-howto-btn')).toContainText(ES_DOCS_LABEL);

    const stored = await page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? '{}'), I18N_KEY);
    expect(stored.customPacks.map((p: { code: string }) => p.code)).toEqual(['es']);
  });

  test('merge import combines translations by code and keeps the local active locale', async ({ page }) => {
    await page.goto('/');
    await page.evaluate(
      ({ key, pack }) => {
        localStorage.setItem(key, JSON.stringify({ activeLocale: 'pl', customPacks: [pack] }));
      },
      { key: I18N_KEY, pack: esPack({ translations: { 'status.about': 'Acerca de local' } }) },
    );
    await page.reload();

    const incoming = {
      app: 'ptt',
      version: 2,
      exportedAt: new Date().toISOString(),
      projects: [],
      history: [],
      i18n: {
        activeLocale: 'es',
        customPacks: [esPack({ updatedAt: '2027-01-01T00:00:00.000Z', translations: { 'footer.docs': ES_DOCS_LABEL } })],
      },
    };

    await page.getByTestId('btn-custom-projects').click();
    const chooser = page.waitForEvent('filechooser');
    await page.getByTestId('import-prefs-btn').click();
    await (await chooser).setFiles({
      name: 'prefs.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(incoming)),
    });
    await page.getByTestId('import-mode-merge').check();
    await page.getByTestId('confirm-import-btn').click();
    await expect(page.getByTestId('import-prefs-dialog')).toBeHidden();

    const stored = await page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? '{}'), I18N_KEY);
    expect(stored.activeLocale).toBe('pl');
    expect(stored.customPacks).toHaveLength(1);
    expect(stored.customPacks[0].translations).toEqual({
      'status.about': 'Acerca de local',
      'footer.docs': ES_DOCS_LABEL,
    });
  });
});
