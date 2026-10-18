import type { en } from './locales/en';

/** Every translatable string key — derived from the English dictionary (source of truth). */
export type TranslationKey = keyof typeof en;

/** A complete dictionary: every key must be present (enforced for built-in locales). */
export type TranslationDictionary = Record<TranslationKey, string>;

/** Values substituted into `{name}` placeholders by `t()`. */
export type TranslationVars = Record<string, string | number>;

export type TranslateFn = (key: TranslationKey, vars?: TranslationVars) => string;

/** Importable / exportable translation pack. Custom packs may be partial; gaps fall back to English. */
export interface LanguagePack {
  schemaVersion: 1;
  /** Validated against /^[a-z]{2,8}(-[a-z0-9]{2,8})?$/i and stored lower-case. */
  code: string;
  name: string;
  nativeName: string;
  author?: string;
  updatedAt: string;
  isBuiltIn?: boolean;
  translations: Partial<Record<TranslationKey, string>>;
}

/** Persisted i18n state (`localStorage['ptt.i18n.v1']`). */
export interface I18nState {
  activeLocale: string;
  customPacks: LanguagePack[];
}

export interface LanguageCoverage {
  total: number;
  translated: number;
  /** 0–100; 100 only when every key is translated. */
  percent: number;
  missing: TranslationKey[];
}

export interface LanguagePackValidation {
  ok: boolean;
  pack: LanguagePack | null;
  errors: string[];
  warnings: string[];
  /** Keys present in the file that this app version does not know (dropped). */
  unknownKeys: string[];
  coverage: LanguageCoverage | null;
}

export interface LocaleInfo {
  code: string;
  name: string;
  nativeName: string;
  isBuiltIn: boolean;
  coverage: LanguageCoverage;
}
