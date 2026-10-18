/**
 * Framework-free i18n core: dictionaries, translation cascade, language-pack
 * validation and persistence. Nothing here imports React, so `prefTransfer.ts`
 * and tests can use it directly.
 *
 * Cascade for `t(key)`: custom pack for the active locale → built-in dictionary
 * for the active locale → English → the key itself.
 */

import { redactSecretsWithReport } from '../secrets';
import { en } from './locales/en';
import { pl } from './locales/pl';
import type {
  I18nState,
  LanguageCoverage,
  LanguagePack,
  LanguagePackValidation,
  LocaleInfo,
  TranslateFn,
  TranslationDictionary,
  TranslationKey,
  TranslationVars,
} from './types';

export const I18N_STORAGE_KEY = 'ptt.i18n.v1';
export const I18N_UPDATED_EVENT = 'ptt:i18n-updated';
export const DEFAULT_LOCALE = 'en';
export const MAX_LANGUAGE_PACK_BYTES = 2 * 1024 * 1024;
export const MAX_TRANSLATION_VALUE_LEN = 10_000;
export const MAX_CUSTOM_LANGUAGE_PACKS = 24;
export const MAX_LANGUAGE_NAME_LEN = 80;
export const MAX_LANGUAGE_AUTHOR_LEN = 120;
export const LANGUAGE_CODE_RE = /^[a-z]{2,8}(-[a-z0-9]{2,8})?$/i;

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export const ALL_TRANSLATION_KEYS = Object.keys(en) as TranslationKey[];
const KEY_SET = new Set<string>(ALL_TRANSLATION_KEYS);

const BUILT_IN_META: { code: string; name: string; nativeName: string; translations: TranslationDictionary }[] = [
  { code: 'en', name: 'English', nativeName: 'English', translations: en },
  { code: 'pl', name: 'Polish', nativeName: 'Polski', translations: pl },
];

export interface BuiltInLocale {
  code: string;
  name: string;
  nativeName: string;
  isBuiltIn: true;
  translations: TranslationDictionary;
}

export function getBuiltInLocales(): BuiltInLocale[] {
  return BUILT_IN_META.map((l) => ({ ...l, isBuiltIn: true as const }));
}

export function isBuiltInLocale(code: string): boolean {
  const lower = code.toLowerCase();
  return BUILT_IN_META.some((l) => l.code === lower);
}

function getBuiltInDictionary(code: string): TranslationDictionary | undefined {
  return BUILT_IN_META.find((l) => l.code === code)?.translations;
}

export function isTranslationKey(key: string): key is TranslationKey {
  return KEY_SET.has(key);
}

/* ─── translation ──────────────────────────────────────── */

export function interpolate(template: string, vars?: TranslationVars): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : match,
  );
}

function usable(value: string | undefined): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function createTranslator(
  activeLocale: string,
  customPacks: readonly LanguagePack[] = [],
): TranslateFn {
  const code = activeLocale.toLowerCase();
  const custom = customPacks.find((p) => p.code === code)?.translations;
  const builtIn = getBuiltInDictionary(code);
  return (key, vars) =>
    interpolate(usable(custom?.[key]) ?? usable(builtIn?.[key]) ?? usable(en[key]) ?? key, vars);
}

/* ─── coverage / listing ───────────────────────────────── */

export function computeCoverage(
  translations: Partial<Record<TranslationKey, string>> | Readonly<Record<string, string>>,
): LanguageCoverage {
  const source = translations as Record<string, string | undefined>;
  const missing: TranslationKey[] = [];
  let translated = 0;
  for (const key of ALL_TRANSLATION_KEYS) {
    if (usable(source[key])) translated += 1;
    else missing.push(key);
  }
  const total = ALL_TRANSLATION_KEYS.length;
  const percent = translated >= total ? 100 : Math.floor((translated / total) * 100);
  return { total, translated, percent, missing };
}

export function listLocales(state: I18nState): LocaleInfo[] {
  const builtIn: LocaleInfo[] = BUILT_IN_META.map((l) => ({
    code: l.code,
    name: l.name,
    nativeName: l.nativeName,
    isBuiltIn: true,
    coverage: computeCoverage(l.translations),
  }));
  const custom: LocaleInfo[] = [...state.customPacks]
    .sort((a, b) => a.code.localeCompare(b.code))
    .map((p) => ({
      code: p.code,
      name: p.name,
      nativeName: p.nativeName,
      isBuiltIn: false,
      coverage: computeCoverage(p.translations),
    }));
  return [...builtIn, ...custom];
}

export function isLocaleAvailable(code: string, customPacks: readonly LanguagePack[]): boolean {
  const lower = code.toLowerCase();
  return isBuiltInLocale(lower) || customPacks.some((p) => p.code === lower);
}

/* ─── validation ───────────────────────────────────────── */

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function utf8Length(text: string): number {
  return new TextEncoder().encode(text).length;
}

function summarizeKeys(keys: string[]): string {
  const shown = keys.slice(0, 5).join(', ');
  return keys.length > 5 ? `${shown} … (+${keys.length - 5} more)` : shown;
}

/**
 * Validate untrusted input (parsed object or raw JSON text) and return a sanitized pack.
 * Hard errors (bad shape, forbidden keys, oversized values) reject the pack; softer issues
 * (unknown keys, secret-like values) become warnings and the offending data is dropped/masked.
 */
export function validateAndSanitizeLanguagePack(raw: unknown): LanguagePackValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  const unknownKeys: string[] = [];
  const fail = (): LanguagePackValidation => ({
    ok: false,
    pack: null,
    errors,
    warnings,
    unknownKeys,
    coverage: null,
  });

  let value: unknown = raw;
  if (typeof raw === 'string') {
    if (utf8Length(raw) > MAX_LANGUAGE_PACK_BYTES) {
      errors.push(`Language pack is larger than ${MAX_LANGUAGE_PACK_BYTES / (1024 * 1024)} MB`);
      return fail();
    }
    try {
      value = JSON.parse(raw);
    } catch {
      errors.push('Not a valid JSON file');
      return fail();
    }
  }

  if (!isPlainObject(value)) {
    errors.push('File does not contain a language pack object');
    return fail();
  }

  for (const key of Object.keys(value)) {
    if (FORBIDDEN_KEYS.has(key)) {
      errors.push(`Forbidden key “${key}” in language pack`);
      return fail();
    }
  }

  if (value.schemaVersion !== 1) {
    errors.push('Unsupported schemaVersion (expected 1)');
  }

  const code = typeof value.code === 'string' ? value.code.trim().toLowerCase() : '';
  if (!LANGUAGE_CODE_RE.test(code)) {
    errors.push('Invalid language code (expected e.g. “es” or “pt-br”)');
  }

  const name = typeof value.name === 'string' ? value.name.trim() : '';
  if (!name) errors.push('Language name is required');
  else if (name.length > MAX_LANGUAGE_NAME_LEN) {
    errors.push(`Language name is longer than ${MAX_LANGUAGE_NAME_LEN} characters`);
  }

  const nativeNameRaw = typeof value.nativeName === 'string' ? value.nativeName.trim() : '';
  if (nativeNameRaw.length > MAX_LANGUAGE_NAME_LEN) {
    errors.push(`Native name is longer than ${MAX_LANGUAGE_NAME_LEN} characters`);
  }

  let author: string | undefined;
  if (typeof value.author === 'string' && value.author.trim()) {
    author = value.author.trim();
    if (author.length > MAX_LANGUAGE_AUTHOR_LEN) {
      errors.push(`Author is longer than ${MAX_LANGUAGE_AUTHOR_LEN} characters`);
    }
  }

  const updatedAt =
    typeof value.updatedAt === 'string' && !Number.isNaN(Date.parse(value.updatedAt))
      ? value.updatedAt
      : new Date().toISOString();

  const translations: Partial<Record<TranslationKey, string>> = {};
  if (!isPlainObject(value.translations)) {
    errors.push('“translations” must be an object');
  } else {
    const incoming = value.translations;
    const secretKeys: string[] = [];
    for (const key of Object.keys(incoming)) {
      if (FORBIDDEN_KEYS.has(key)) {
        errors.push(`Forbidden translation key “${key}”`);
        return fail();
      }
      const entry = incoming[key];
      if (!isTranslationKey(key)) {
        unknownKeys.push(key);
        continue;
      }
      if (typeof entry !== 'string') {
        warnings.push(`Value for “${key}” is not a string and was ignored`);
        continue;
      }
      if (entry.length > MAX_TRANSLATION_VALUE_LEN) {
        errors.push(`Value for “${key}” exceeds ${MAX_TRANSLATION_VALUE_LEN} characters`);
        continue;
      }
      if (!entry.trim()) continue;
      const scan = redactSecretsWithReport(entry);
      if (scan.summary.totalRedactions > 0) {
        secretKeys.push(key);
        translations[key] = scan.text;
      } else {
        translations[key] = entry;
      }
    }
    if (unknownKeys.length > 0) {
      warnings.push(`Unknown keys ignored (${unknownKeys.length}): ${summarizeKeys(unknownKeys)}`);
    }
    if (secretKeys.length > 0) {
      warnings.push(
        `Secret-like content was masked in ${secretKeys.length} value(s): ${summarizeKeys(secretKeys)}`,
      );
    }
  }

  if (errors.length > 0) return fail();

  const pack: LanguagePack = {
    schemaVersion: 1,
    code,
    name,
    nativeName: nativeNameRaw || name,
    ...(author ? { author } : {}),
    updatedAt,
    translations,
  };
  return { ok: true, pack, errors, warnings, unknownKeys, coverage: computeCoverage(translations) };
}

/* ─── templates / serialization ────────────────────────── */

/** A fully populated pack (every key pre-filled from `baseLocale`) for translators to edit. */
export function buildTemplatePack(
  baseLocale: string = DEFAULT_LOCALE,
  customPacks: readonly LanguagePack[] = [],
): LanguagePack {
  const base = isLocaleAvailable(baseLocale, customPacks) ? baseLocale : DEFAULT_LOCALE;
  const t = createTranslator(base, customPacks);
  const translations: Partial<Record<TranslationKey, string>> = {};
  for (const key of ALL_TRANSLATION_KEYS) translations[key] = t(key);
  return {
    schemaVersion: 1,
    code: 'xx',
    name: 'New language',
    nativeName: 'New language',
    author: '',
    updatedAt: new Date().toISOString(),
    translations,
  };
}

export function serializeLanguagePack(pack: LanguagePack): string {
  return JSON.stringify(pack, null, 2);
}

export function languagePackFileName(code: string): string {
  return `ptt-language-${code.toLowerCase()}.json`;
}

export const TEMPLATE_FILE_NAME = 'ptt-language-template.json';

/* ─── pack collections ─────────────────────────────────── */

/** Merge by code; translations are `{...local, ...imported}`; metadata follows the newer pack. */
export function mergeLanguagePacks(
  local: readonly LanguagePack[],
  imported: readonly LanguagePack[],
): LanguagePack[] {
  const byCode = new Map<string, LanguagePack>(local.map((p) => [p.code, p]));
  for (const incoming of imported) {
    const existing = byCode.get(incoming.code);
    if (!existing) {
      byCode.set(incoming.code, incoming);
      continue;
    }
    const incomingNewer = Date.parse(incoming.updatedAt) >= Date.parse(existing.updatedAt);
    const meta = incomingNewer ? incoming : existing;
    byCode.set(incoming.code, {
      ...meta,
      translations: { ...existing.translations, ...incoming.translations },
      updatedAt: incomingNewer ? incoming.updatedAt : existing.updatedAt,
    });
  }
  return [...byCode.values()].slice(0, MAX_CUSTOM_LANGUAGE_PACKS);
}

/* ─── persisted state ──────────────────────────────────── */

export function defaultI18nState(): I18nState {
  return { activeLocale: DEFAULT_LOCALE, customPacks: [] };
}

/** Tolerant parser: invalid packs are dropped, an unknown active locale falls back to English. */
export function sanitizeI18nState(raw: unknown): I18nState {
  if (!isPlainObject(raw)) return defaultI18nState();
  const byCode = new Map<string, LanguagePack>();
  if (Array.isArray(raw.customPacks)) {
    for (const candidate of raw.customPacks) {
      const result = validateAndSanitizeLanguagePack(candidate);
      if (result.ok && result.pack) byCode.set(result.pack.code, result.pack);
    }
  }
  const customPacks = [...byCode.values()].slice(0, MAX_CUSTOM_LANGUAGE_PACKS);
  const requested =
    typeof raw.activeLocale === 'string' ? raw.activeLocale.trim().toLowerCase() : DEFAULT_LOCALE;
  const activeLocale = isLocaleAvailable(requested, customPacks) ? requested : DEFAULT_LOCALE;
  return { activeLocale, customPacks };
}

export function loadI18nState(): I18nState {
  try {
    const raw = localStorage.getItem(I18N_STORAGE_KEY);
    if (!raw) return defaultI18nState();
    return sanitizeI18nState(JSON.parse(raw));
  } catch {
    return defaultI18nState();
  }
}

/** Persist and broadcast. Returns false when storage is unavailable (state still applies in-memory). */
export function saveI18nState(state: I18nState): boolean {
  const clean = sanitizeI18nState(state);
  let ok = true;
  try {
    localStorage.setItem(
      I18N_STORAGE_KEY,
      JSON.stringify({ activeLocale: clean.activeLocale, customPacks: clean.customPacks }),
    );
  } catch {
    ok = false;
  }
  try {
    window.dispatchEvent(new CustomEvent<I18nState>(I18N_UPDATED_EVENT, { detail: clean }));
  } catch {
    /* non-browser environment */
  }
  return ok;
}

export function sameI18nState(a: I18nState, b: I18nState): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
