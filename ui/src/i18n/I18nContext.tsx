import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  I18N_STORAGE_KEY,
  I18N_UPDATED_EVENT,
  MAX_CUSTOM_LANGUAGE_PACKS,
  createTranslator,
  defaultI18nState,
  isLocaleAvailable,
  listLocales,
  loadI18nState,
  sameI18nState,
  sanitizeI18nState,
  saveI18nState,
} from './core';
import type { I18nState, LanguagePack, LocaleInfo, TranslateFn, TranslationKey, TranslationVars } from './types';

export {
  ALL_TRANSLATION_KEYS,
  DEFAULT_LOCALE,
  I18N_STORAGE_KEY,
  I18N_UPDATED_EVENT,
  LANGUAGE_CODE_RE,
  MAX_CUSTOM_LANGUAGE_PACKS,
  MAX_LANGUAGE_PACK_BYTES,
  MAX_TRANSLATION_VALUE_LEN,
  TEMPLATE_FILE_NAME,
  buildTemplatePack,
  computeCoverage,
  createTranslator,
  getBuiltInLocales,
  interpolate,
  isBuiltInLocale,
  isLocaleAvailable,
  languagePackFileName,
  listLocales,
  loadI18nState,
  mergeLanguagePacks,
  sanitizeI18nState,
  saveI18nState,
  serializeLanguagePack,
  validateAndSanitizeLanguagePack,
} from './core';

/* ─── rich text (<strong>, <code>) ─────────────────────── */

export type RichTagRenderers = Partial<
  Record<'strong' | 'code', (children: string, key: number) => ReactNode>
>;

const RICH_TAG_RE = /<(strong|code)>([\s\S]*?)<\/\1>/g;

const DEFAULT_RICH_TAGS: Required<RichTagRenderers> = {
  strong: (children, key) => <strong key={key}>{children}</strong>,
  code: (children, key) => <code key={key}>{children}</code>,
};

/**
 * Turns `<strong>…</strong>` / `<code>…</code>` in a translated string into React elements.
 * Only these two tags are recognised, so translations can never inject arbitrary markup.
 */
export function renderRichText(text: string, tags?: RichTagRenderers): ReactNode[] {
  const renderers = { ...DEFAULT_RICH_TAGS, ...tags };
  const nodes: ReactNode[] = [];
  let last = 0;
  let index = 0;
  for (const match of text.matchAll(RICH_TAG_RE)) {
    const start = match.index ?? 0;
    if (start > last) nodes.push(text.slice(last, start));
    const tag = match[1] as 'strong' | 'code';
    nodes.push(renderers[tag](match[2], index));
    index += 1;
    last = start + match[0].length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

/* ─── context ──────────────────────────────────────────── */

export interface I18nContextValue {
  /** Active locale code (lower-case), e.g. `en`, `pl`, `es`. */
  locale: string;
  customPacks: LanguagePack[];
  locales: LocaleInfo[];
  t: TranslateFn;
  tRich: (key: TranslationKey, vars?: TranslationVars, tags?: RichTagRenderers) => ReactNode;
  setLocale: (code: string) => void;
  /** Insert or replace (by code) a custom pack. Returns false when the pack limit is reached. */
  upsertCustomPack: (pack: LanguagePack) => boolean;
  removeCustomPack: (code: string) => void;
}

function buildValue(
  state: I18nState,
  actions: Pick<I18nContextValue, 'setLocale' | 'upsertCustomPack' | 'removeCustomPack'>,
): I18nContextValue {
  const t = createTranslator(state.activeLocale, state.customPacks);
  return {
    locale: state.activeLocale,
    customPacks: state.customPacks,
    locales: listLocales(state),
    t,
    tRich: (key, vars, tags) => renderRichText(t(key, vars), tags),
    ...actions,
  };
}

const FALLBACK_VALUE = buildValue(defaultI18nState(), {
  setLocale: () => {},
  upsertCustomPack: () => false,
  removeCustomPack: () => {},
});

const I18nContext = createContext<I18nContextValue>(FALLBACK_VALUE);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<I18nState>(() => loadI18nState());
  const stateRef = useRef(state);
  stateRef.current = state;

  const commit = useCallback((next: I18nState) => {
    stateRef.current = next;
    setState(next);
    saveI18nState(next);
  }, []);

  const setLocale = useCallback(
    (code: string) => {
      const lower = code.trim().toLowerCase();
      const current = stateRef.current;
      if (!isLocaleAvailable(lower, current.customPacks)) return;
      if (lower === current.activeLocale) return;
      commit({ ...current, activeLocale: lower });
    },
    [commit],
  );

  const upsertCustomPack = useCallback(
    (pack: LanguagePack) => {
      const current = stateRef.current;
      const exists = current.customPacks.some((p) => p.code === pack.code);
      if (!exists && current.customPacks.length >= MAX_CUSTOM_LANGUAGE_PACKS) return false;
      const customPacks = exists
        ? current.customPacks.map((p) => (p.code === pack.code ? pack : p))
        : [...current.customPacks, pack];
      commit({ ...current, customPacks });
      return true;
    },
    [commit],
  );

  const removeCustomPack = useCallback(
    (code: string) => {
      const lower = code.toLowerCase();
      const current = stateRef.current;
      const customPacks = current.customPacks.filter((p) => p.code !== lower);
      const activeLocale = isLocaleAvailable(current.activeLocale, customPacks)
        ? current.activeLocale
        : 'en';
      commit({ activeLocale, customPacks });
    },
    [commit],
  );

  // Imports (prefTransfer) and other tabs write through saveI18nState / localStorage.
  useEffect(() => {
    const adopt = (next: I18nState) => {
      if (sameI18nState(stateRef.current, next)) return;
      stateRef.current = next;
      setState(next);
    };
    const onUpdated = (event: Event) => {
      const detail = (event as CustomEvent<unknown>).detail;
      adopt(detail ? sanitizeI18nState(detail) : loadI18nState());
    };
    const onStorage = (event: StorageEvent) => {
      if (event.key === I18N_STORAGE_KEY || event.key === null) adopt(loadI18nState());
    };
    window.addEventListener(I18N_UPDATED_EVENT, onUpdated);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener(I18N_UPDATED_EVENT, onUpdated);
      window.removeEventListener('storage', onStorage);
    };
  }, []);

  useEffect(() => {
    document.documentElement.setAttribute('lang', state.activeLocale);
  }, [state.activeLocale]);

  const value = useMemo(
    () => buildValue(state, { setLocale, upsertCustomPack, removeCustomPack }),
    [state, setLocale, upsertCustomPack, removeCustomPack],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  return useContext(I18nContext);
}
