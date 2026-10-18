import { useState, type ChangeEvent, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { Download, Languages, Plus, Trash2, X } from 'lucide-react';
import { downloadText } from './browserFs';
import {
  ALL_TRANSLATION_KEYS,
  LANGUAGE_CODE_RE,
  MAX_CUSTOM_LANGUAGE_PACKS,
  MAX_LANGUAGE_PACK_BYTES,
  MAX_TRANSLATION_VALUE_LEN,
  TEMPLATE_FILE_NAME,
  buildTemplatePack,
  en,
  isBuiltInLocale,
  languagePackFileName,
  serializeLanguagePack,
  useI18n,
  validateAndSanitizeLanguagePack,
  type LanguagePack,
  type LanguagePackValidation,
  type TranslationKey,
} from './i18n';

const PAGE_SIZE = 60;

type Issue = { kind: 'error' | 'warning'; text: string };

export interface LanguageManagerModalProps {
  open: boolean;
  onClose: () => void;
  pushToast: (kind: 'success' | 'error' | 'info', message: string) => void;
}

export function LanguageManagerModal({ open, onClose, pushToast }: LanguageManagerModalProps) {
  const { t, locale, locales, customPacks, setLocale, upsertCustomPack, removeCustomPack } = useI18n();

  const [selectedCode, setSelectedCode] = useState<string | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [meta, setMeta] = useState({ name: '', nativeName: '', author: '' });
  const [dirty, setDirty] = useState(false);
  const [search, setSearch] = useState('');
  const [onlyUntranslated, setOnlyUntranslated] = useState(false);
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [issues, setIssues] = useState<Issue[]>([]);
  const [newCode, setNewCode] = useState('');
  const [newName, setNewName] = useState('');
  const [newNative, setNewNative] = useState('');
  const [createError, setCreateError] = useState<string | null>(null);

  if (!open) return null;

  const selectedPack = customPacks.find((p) => p.code === selectedCode);

  const selectPack = (pack: LanguagePack) => {
    setSelectedCode(pack.code);
    setDraft({ ...(pack.translations as Record<string, string>) });
    setMeta({ name: pack.name, nativeName: pack.nativeName, author: pack.author ?? '' });
    setDirty(false);
    setSearch('');
    setOnlyUntranslated(false);
    setLimit(PAGE_SIZE);
    setConfirmDelete(false);
  };

  const toIssues = (result: LanguagePackValidation): Issue[] => [
    ...result.errors.map((text) => ({ kind: 'error' as const, text })),
    ...result.warnings.map((text) => ({ kind: 'warning' as const, text })),
  ];

  /** Build and validate the pack currently shown in the editor (saved or not). */
  const validateDraft = (): LanguagePackValidation | null => {
    if (!selectedPack) return null;
    const translations: Record<string, string> = {};
    for (const key of ALL_TRANSLATION_KEYS) {
      const value = draft[key];
      if (typeof value === 'string' && value.trim()) translations[key] = value;
    }
    return validateAndSanitizeLanguagePack({
      schemaVersion: 1,
      code: selectedPack.code,
      name: meta.name,
      nativeName: meta.nativeName,
      author: meta.author,
      updatedAt: new Date().toISOString(),
      translations,
    });
  };

  const saveDraft = () => {
    const result = validateDraft();
    if (!result) return;
    setIssues(toIssues(result));
    if (!result.ok || !result.pack) {
      pushToast('error', t('langstudio.editor.saveFailed', { error: result.errors[0] ?? '' }));
      return;
    }
    upsertCustomPack(result.pack);
    setDraft({ ...(result.pack.translations as Record<string, string>) });
    setDirty(false);
    pushToast('success', t('langstudio.editor.saved', { name: result.pack.name }));
  };

  const exportDraft = () => {
    const result = validateDraft();
    if (!result) return;
    setIssues(toIssues(result));
    if (!result.ok || !result.pack) {
      pushToast('error', t('langstudio.editor.saveFailed', { error: result.errors[0] ?? '' }));
      return;
    }
    downloadText(languagePackFileName(result.pack.code), serializeLanguagePack(result.pack));
    pushToast('success', t('langstudio.editor.exported', { name: result.pack.name }));
  };

  const deleteSelected = () => {
    if (!selectedPack) return;
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    removeCustomPack(selectedPack.code);
    pushToast('info', t('langstudio.editor.deleted', { name: selectedPack.name }));
    setSelectedCode(null);
    setDraft({});
    setDirty(false);
    setConfirmDelete(false);
    setIssues([]);
  };

  const downloadTemplate = () => {
    downloadText(TEMPLATE_FILE_NAME, serializeLanguagePack(buildTemplatePack('en', customPacks)));
    pushToast('success', t('langstudio.templateDownloaded'));
  };

  const onImportFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const input = e.target;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    const fail = (error: string) => {
      setIssues([{ kind: 'error', text: error }]);
      pushToast('error', t('langstudio.import.failed', { error }));
    };
    if (file.size > MAX_LANGUAGE_PACK_BYTES) {
      fail(`File is larger than ${MAX_LANGUAGE_PACK_BYTES / (1024 * 1024)} MB`);
      return;
    }
    try {
      const result = validateAndSanitizeLanguagePack(await file.text());
      if (!result.ok || !result.pack) {
        setIssues(toIssues(result));
        pushToast('error', t('langstudio.import.failed', { error: result.errors[0] ?? '' }));
        return;
      }
      if (
        !customPacks.some((p) => p.code === result.pack!.code) &&
        customPacks.length >= MAX_CUSTOM_LANGUAGE_PACKS
      ) {
        fail(t('langstudio.create.limit', { max: MAX_CUSTOM_LANGUAGE_PACKS }));
        return;
      }
      upsertCustomPack(result.pack);
      selectPack(result.pack);
      setIssues(toIssues(result));
      pushToast(
        'success',
        t('langstudio.import.success', {
          name: result.pack.name,
          code: result.pack.code,
          percent: result.coverage?.percent ?? 0,
        }),
      );
    } catch (err) {
      fail(err instanceof Error ? err.message : String(err));
    }
  };

  const createLanguage = () => {
    const code = newCode.trim().toLowerCase();
    const name = newName.trim();
    if (!LANGUAGE_CODE_RE.test(code)) {
      setCreateError(t('langstudio.create.codeInvalid'));
      return;
    }
    if (isBuiltInLocale(code)) {
      setCreateError(t('langstudio.create.codeBuiltIn', { code }));
      return;
    }
    if (customPacks.some((p) => p.code === code)) {
      setCreateError(t('langstudio.create.codeExists', { code }));
      return;
    }
    if (!name) {
      setCreateError(t('langstudio.create.nameRequired'));
      return;
    }
    if (customPacks.length >= MAX_CUSTOM_LANGUAGE_PACKS) {
      setCreateError(t('langstudio.create.limit', { max: MAX_CUSTOM_LANGUAGE_PACKS }));
      return;
    }
    const result = validateAndSanitizeLanguagePack({
      schemaVersion: 1,
      code,
      name,
      nativeName: newNative.trim() || name,
      updatedAt: new Date().toISOString(),
      translations: {},
    });
    if (!result.ok || !result.pack) {
      setCreateError(result.errors[0] ?? t('langstudio.create.codeInvalid'));
      return;
    }
    upsertCustomPack(result.pack);
    selectPack(result.pack);
    setIssues([]);
    setCreateError(null);
    setNewCode('');
    setNewName('');
    setNewNative('');
  };

  const query = search.trim().toLowerCase();
  const savedTranslations = (selectedPack?.translations ?? {}) as Record<string, string | undefined>;
  const visibleKeys: TranslationKey[] = selectedPack
    ? ALL_TRANSLATION_KEYS.filter((key) => {
        if (onlyUntranslated && savedTranslations[key]?.trim()) return false;
        if (!query) return true;
        return (
          key.toLowerCase().includes(query) ||
          en[key].toLowerCase().includes(query) ||
          (draft[key] ?? '').toLowerCase().includes(query)
        );
      })
    : [];
  const shownKeys = visibleKeys.slice(0, limit);

  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      onClose();
    }
  };

  return (
    <div className="help-overlay" role="presentation" onClick={onClose} onKeyDown={onKeyDown}>
      <div
        className="prompt-studio-modal language-studio-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="language-studio-title"
        data-testid="language-studio-modal"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="prompt-studio-modal-header">
          <div>
            <h2 id="language-studio-title">
              <Languages size={16} aria-hidden /> {t('langstudio.title')}
            </h2>
            <p className="meta-inline">{t('langstudio.subtitle')}</p>
          </div>
          <button
            type="button"
            className="btn btn-ghost btn-icon"
            onClick={onClose}
            aria-label={t('langstudio.closeAria')}
            data-testid="language-studio-close-btn"
          >
            <X size={14} />
          </button>
        </div>

        <div className="prompt-studio-modal-layout">
          <div className="prompt-studio-list-col">
            <h3>{t('langstudio.listHeading')}</h3>
            <ul className="prompt-studio-card-list" data-testid="language-list">
              {locales.map((l) => (
                <li
                  key={`${l.isBuiltIn ? 'built-in' : 'custom'}-${l.code}`}
                  className={`prompt-studio-card${l.isBuiltIn ? '' : selectedCode === l.code ? ' is-editing' : ''}`}
                  data-testid={`language-row-${l.code}`}
                >
                  <div className="language-row-main">
                    <strong>
                      {l.nativeName} <span className="meta-inline">({l.code})</span>
                    </strong>
                    <span className="docs-tag">
                      {l.isBuiltIn ? t('langstudio.builtIn') : t('langstudio.custom')}
                    </span>
                    {locale === l.code && (
                      <span className="prompt-default-badge">{t('langstudio.active')}</span>
                    )}
                    <span
                      className="meta-inline"
                      data-testid={`language-coverage-${l.code}`}
                    >
                      {t('langstudio.coverage', {
                        percent: l.coverage.percent,
                        translated: l.coverage.translated,
                        total: l.coverage.total,
                      })}
                    </span>
                  </div>
                  <div className="prompt-studio-card-actions">
                    <button
                      type="button"
                      className="btn btn-ghost"
                      disabled={locale === l.code}
                      data-testid={`activate-language-${l.code}`}
                      aria-label={t('langstudio.activateAria', { name: l.name })}
                      onClick={() => setLocale(l.code)}
                    >
                      {t('langstudio.activate')}
                    </button>
                    {!l.isBuiltIn && (
                      <button
                        type="button"
                        className="btn btn-ghost"
                        data-testid={`edit-language-${l.code}`}
                        aria-label={t('langstudio.editAria', { name: l.name })}
                        onClick={() => {
                          const pack = customPacks.find((p) => p.code === l.code);
                          if (pack) selectPack(pack);
                        }}
                      >
                        {t('langstudio.edit')}
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ul>

            <div className="language-tools">
              <button
                type="button"
                className="btn"
                data-testid="download-translation-template-btn"
                onClick={downloadTemplate}
              >
                <Download size={14} aria-hidden /> {t('langstudio.template.download')}
              </button>
              <p className="meta-inline">{t('langstudio.template.hint')}</p>

              <label className="prompt-field-label" htmlFor="import-translation-pack-input">
                {t('langstudio.import.label')}
              </label>
              <input
                id="import-translation-pack-input"
                type="file"
                accept="application/json,.json"
                className="language-import-input"
                data-testid="import-translation-pack-input"
                onChange={(e) => void onImportFile(e)}
              />
            </div>

            {issues.length > 0 && (
              <ul className="language-issues" role="status" data-testid="language-issues">
                {issues.map((issue, i) => (
                  <li key={i} className={`language-issue is-${issue.kind}`}>
                    {issue.text}
                  </li>
                ))}
              </ul>
            )}

            <h3>{t('langstudio.create.heading')}</h3>
            <div className="language-create-form" data-testid="create-language-form">
              <input
                className="select"
                value={newCode}
                maxLength={17}
                placeholder={t('langstudio.create.code')}
                aria-label={t('langstudio.create.code')}
                data-testid="new-language-code-input"
                onChange={(e) => setNewCode(e.target.value)}
              />
              <input
                className="select"
                value={newName}
                maxLength={80}
                placeholder={t('langstudio.create.name')}
                aria-label={t('langstudio.create.name')}
                data-testid="new-language-name-input"
                onChange={(e) => setNewName(e.target.value)}
              />
              <input
                className="select"
                value={newNative}
                maxLength={80}
                placeholder={t('langstudio.create.native')}
                aria-label={t('langstudio.create.native')}
                data-testid="new-language-native-input"
                onChange={(e) => setNewNative(e.target.value)}
              />
              {createError && (
                <p className="language-issue is-error" role="alert" data-testid="create-language-error">
                  {createError}
                </p>
              )}
              <button
                type="button"
                className="btn btn-primary"
                data-testid="create-language-btn"
                onClick={createLanguage}
              >
                <Plus size={14} aria-hidden /> {t('langstudio.create.button')}
              </button>
            </div>
          </div>

          <div className="prompt-studio-editor-col" data-testid="translation-editor">
            {selectedPack ? (
              <>
                <h3>{t('langstudio.editor.heading', { name: selectedPack.name })}</h3>

                <div className="language-meta-grid">
                  <label className="prompt-field-label" htmlFor="language-meta-name">
                    {t('langstudio.editor.name')}
                  </label>
                  <input
                    id="language-meta-name"
                    className="select"
                    value={meta.name}
                    maxLength={80}
                    data-testid="language-meta-name-input"
                    onChange={(e) => {
                      setMeta((m) => ({ ...m, name: e.target.value }));
                      setDirty(true);
                    }}
                  />
                  <label className="prompt-field-label" htmlFor="language-meta-native">
                    {t('langstudio.editor.native')}
                  </label>
                  <input
                    id="language-meta-native"
                    className="select"
                    value={meta.nativeName}
                    maxLength={80}
                    data-testid="language-meta-native-input"
                    onChange={(e) => {
                      setMeta((m) => ({ ...m, nativeName: e.target.value }));
                      setDirty(true);
                    }}
                  />
                  <label className="prompt-field-label" htmlFor="language-meta-author">
                    {t('langstudio.editor.author')}
                  </label>
                  <input
                    id="language-meta-author"
                    className="select"
                    value={meta.author}
                    maxLength={120}
                    data-testid="language-meta-author-input"
                    onChange={(e) => {
                      setMeta((m) => ({ ...m, author: e.target.value }));
                      setDirty(true);
                    }}
                  />
                </div>

                <div className="language-editor-toolbar">
                  <input
                    type="search"
                    className="select language-editor-search"
                    value={search}
                    placeholder={t('langstudio.editor.searchPlaceholder')}
                    aria-label={t('langstudio.editor.searchAria')}
                    data-testid="translation-editor-search"
                    onChange={(e) => {
                      setSearch(e.target.value);
                      setLimit(PAGE_SIZE);
                    }}
                  />
                  <label className="prompt-checkbox-row language-filter-row">
                    <input
                      type="checkbox"
                      checked={onlyUntranslated}
                      data-testid="translation-editor-untranslated-filter"
                      onChange={(e) => {
                        setOnlyUntranslated(e.target.checked);
                        setLimit(PAGE_SIZE);
                      }}
                    />
                    {t('langstudio.editor.onlyUntranslated')}
                  </label>
                  <div className="language-editor-actions">
                    {dirty && <span className="meta-inline">{t('langstudio.editor.dirty')}</span>}
                    <button
                      type="button"
                      className="btn btn-primary"
                      data-testid="save-custom-language-btn"
                      onClick={saveDraft}
                    >
                      {t('langstudio.editor.save')}
                    </button>
                    <button
                      type="button"
                      className="btn"
                      data-testid="export-single-language-btn"
                      onClick={exportDraft}
                    >
                      <Download size={14} aria-hidden /> {t('langstudio.editor.export')}
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost danger"
                      data-testid="delete-custom-language-btn"
                      onClick={deleteSelected}
                    >
                      <Trash2 size={14} aria-hidden />{' '}
                      {confirmDelete ? t('langstudio.editor.confirmDelete') : t('langstudio.editor.delete')}
                    </button>
                  </div>
                </div>

                <p className="meta-inline" data-testid="translation-editor-count">
                  {t('langstudio.editor.showing', { shown: shownKeys.length, total: visibleKeys.length })}
                </p>

                {shownKeys.length === 0 ? (
                  <p className="meta-inline">{t('langstudio.editor.noMatches')}</p>
                ) : (
                  <ul className="language-editor-list">
                    {shownKeys.map((key) => (
                      <li key={key} className="language-editor-row" data-testid={`translation-row-${key}`}>
                        <code className="language-editor-key">{key}</code>
                        <span className="language-editor-en" title={t('langstudio.editor.english')}>
                          {en[key]}
                        </span>
                        <textarea
                          className="prompt-studio-textarea language-editor-input"
                          rows={2}
                          value={draft[key] ?? ''}
                          maxLength={MAX_TRANSLATION_VALUE_LEN}
                          placeholder={en[key]}
                          aria-label={t('langstudio.editor.inputAria', { key })}
                          data-testid={`translation-input-${key}`}
                          onChange={(e) => {
                            const value = e.target.value;
                            setDraft((d) => ({ ...d, [key]: value }));
                            setDirty(true);
                          }}
                        />
                      </li>
                    ))}
                  </ul>
                )}

                {visibleKeys.length > shownKeys.length && (
                  <button
                    type="button"
                    className="btn btn-ghost"
                    data-testid="translation-editor-show-more"
                    onClick={() => setLimit((n) => n + PAGE_SIZE)}
                  >
                    {t('langstudio.editor.showMore')}
                  </button>
                )}
              </>
            ) : (
              <div className="prompt-studio-editor-empty">
                <Languages size={22} aria-hidden />
                <p>{t('langstudio.editor.none')}</p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
