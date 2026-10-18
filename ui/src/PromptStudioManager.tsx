import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { Copy, Plus, Star, Trash2, X } from 'lucide-react';
import {
  BUILT_IN_PROMPTS,
  deleteCustomPrompt,
  duplicatePromptTemplate,
  loadPromptStudioStore,
  type PromptCategory,
  type PromptPlacement,
  type CustomPromptTemplate,
  upsertCustomPrompt,
  setGlobalDefaultPrompt,
  setWorkspaceDefaultPrompt,
  resolveDefaultPromptForWorkspace,
  MAX_PROMPT_CONTENT_LEN,
  MAX_PROMPT_NAME_LEN,
} from './projectPrefs';
import { redactSecrets, redactSecretsWithReport } from './secrets';
import { estimateTokens, formatTokens } from './treeModel';
import { useI18n, type TranslationKey } from './i18n';

const CATEGORIES: PromptCategory[] = [
  'architecture',
  'bugfix',
  'review',
  'refactoring',
  'security',
  'testing',
  'docs',
  'custom',
];

const PLACEMENTS: { id: PromptPlacement; labelKey: TranslationKey }[] = [
  { id: 'prefix', labelKey: 'ps.placement.prefix' },
  { id: 'suffix', labelKey: 'ps.placement.suffix' },
  { id: 'wrap', labelKey: 'ps.placement.wrap' },
];

const VARIABLE_CHIPS = [
  'PROJECT_NAME',
  'GIT_BRANCH',
  'SELECTED_FILES_COUNT',
  'TOKEN_BUDGET',
  'SKELETON_MODE',
  'DATE_ISO',
] as const;

export interface PromptStudioManagerProps {
  open: boolean;
  onClose: () => void;
  workspacePath?: string | null;
  onPromptsChanged: () => void;
  onSelectPrompt: (prompt: CustomPromptTemplate) => void;
  pushToast: (kind: 'success' | 'error' | 'info', message: string) => void;
}

export function PromptStudioManager({
  open,
  onClose,
  workspacePath,
  onPromptsChanged,
  onSelectPrompt,
  pushToast,
}: PromptStudioManagerProps) {
  const { t } = useI18n();
  const [tick, setTick] = useState(0);
  const store = useMemo(() => loadPromptStudioStore(), [tick, open]);
  const customPrompts = store.customPrompts;
  const defaultPrompt = resolveDefaultPromptForWorkspace(workspacePath);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [category, setCategory] = useState<PromptCategory>('custom');
  const [placement, setPlacement] = useState<PromptPlacement>('suffix');
  const [content, setContent] = useState('');
  const [description, setDescription] = useState('');
  const [setAsDefault, setSetAsDefault] = useState(false);
  const [defaultScope, setDefaultScope] = useState<'global' | 'workspace'>('global');
  const contentRef = useRef<HTMLTextAreaElement>(null);

  const refresh = () => {
    setTick((n) => n + 1);
    onPromptsChanged();
  };

  useEffect(() => {
    if (!open) return;
    if (!editingId) {
      setName('');
      setCategory('custom');
      setPlacement('suffix');
      setContent('');
      setDescription('');
      setSetAsDefault(false);
    }
  }, [open, editingId]);

  const secretReport = useMemo(() => redactSecretsWithReport(content), [content]);
  const tokenEst = estimateTokens(content);

  if (!open) return null;

  const startCreate = () => {
    setEditingId('new');
    setName('');
    setCategory('custom');
    setPlacement('suffix');
    setContent('');
    setDescription('');
    setSetAsDefault(false);
  };

  const startEdit = (p: CustomPromptTemplate) => {
    setEditingId(p.id);
    setName(p.name);
    setCategory(p.category);
    setPlacement(p.placement);
    setContent(p.content);
    setDescription(p.description);
    setSetAsDefault(defaultPrompt?.id === p.id);
  };

  const insertVariable = (key: string) => {
    const el = contentRef.current;
    const token = `{{${key}}}`;
    if (!el) {
      setContent((c) => c + token);
      return;
    }
    const start = el.selectionStart ?? content.length;
    const end = el.selectionEnd ?? content.length;
    const next = content.slice(0, start) + token + content.slice(end);
    setContent(next);
    requestAnimationFrame(() => {
      el.focus();
      const pos = start + token.length;
      el.setSelectionRange(pos, pos);
    });
  };

  const saveForm = () => {
    try {
      const saved = upsertCustomPrompt({
        id: editingId && editingId !== 'new' ? editingId : undefined,
        name,
        category,
        description,
        content,
        placement,
      });
      if (setAsDefault) {
        if (defaultScope === 'workspace' && workspacePath) {
          setWorkspaceDefaultPrompt(workspacePath, saved.id);
        } else {
          setGlobalDefaultPrompt(saved.id);
        }
      }
      pushToast('success', t('ps.saved', { name: saved.name }));
      setEditingId(null);
      refresh();
      onSelectPrompt(saved);
    } catch (e) {
      pushToast('error', e instanceof Error ? e.message : t('ps.saveFailed'));
    }
  };

  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      if (editingId) setEditingId(null);
      else onClose();
    }
  };

  const isDefault = (id: string) => defaultPrompt?.id === id;

  return (
    <div className="help-overlay" role="presentation" onClick={onClose} onKeyDown={onKeyDown}>
      <div
        className="prompt-studio-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="prompt-studio-modal-title"
        data-testid="prompt-studio-modal"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="prompt-studio-modal-header">
          <div>
            <h2 id="prompt-studio-modal-title">{t('ps.title')}</h2>
            <p className="meta-inline">{t('ps.subtitle')}</p>
          </div>
          <button
            type="button"
            className="btn btn-ghost btn-icon"
            onClick={onClose}
            aria-label={t('ps.closeAria')}
          >
            <X size={14} />
          </button>
        </div>

        <div className="prompt-studio-modal-toolbar">
          <button
            type="button"
            className="btn btn-primary"
            data-testid="create-custom-prompt-btn"
            onClick={startCreate}
          >
            <Plus size={14} aria-hidden /> {t('ps.add')}
          </button>
          <div className="prompt-default-scope" role="group" aria-label={t('ps.scopeAria')}>
            <label>
              <input
                type="radio"
                name="default-scope"
                checked={defaultScope === 'global'}
                onChange={() => setDefaultScope('global')}
              />{' '}
              {t('ps.scopeGlobal')}
            </label>
            <label>
              <input
                type="radio"
                name="default-scope"
                checked={defaultScope === 'workspace'}
                onChange={() => setDefaultScope('workspace')}
                disabled={!workspacePath}
              />{' '}
              {t('ps.scopeProject')}
            </label>
          </div>
        </div>

        <div className="prompt-studio-modal-layout">
          <div className="prompt-studio-list-col">
            <h3>{t('ps.myPrompts')}</h3>
            {customPrompts.length === 0 ? (
              <p className="meta-inline">{t('ps.noPrompts')}</p>
            ) : (
              <ul className="prompt-studio-card-list">
                {customPrompts.map((p) => (
                  <li key={p.id} className={`prompt-studio-card${editingId === p.id ? ' is-editing' : ''}`}>
                    <button type="button" className="prompt-studio-card-main" onClick={() => startEdit(p)}>
                      <strong>{p.name}</strong>
                      <span className="docs-tag">{p.category}</span>
                      {isDefault(p.id) && (
                        <span className="prompt-default-badge" data-testid="prompt-default-badge">
                          {t('ps.badge')}
                        </span>
                      )}
                    </button>
                    <div className="prompt-studio-card-actions">
                      <button
                        type="button"
                        className={`btn btn-icon btn-star-default${isDefault(p.id) ? ' active' : ''}`}
                        data-testid="toggle-default-prompt-btn"
                        aria-label={isDefault(p.id) ? t('ps.clearDefault') : t('ps.setDefault')}
                        title={isDefault(p.id) ? t('ps.defaultOn') : t('ps.defaultOff')}
                        onClick={() => {
                          try {
                            if (isDefault(p.id)) {
                              if (defaultScope === 'workspace' && workspacePath) {
                                setWorkspaceDefaultPrompt(workspacePath, null);
                              } else {
                                setGlobalDefaultPrompt(null);
                              }
                            } else if (defaultScope === 'workspace' && workspacePath) {
                              setWorkspaceDefaultPrompt(workspacePath, p.id);
                            } else {
                              setGlobalDefaultPrompt(p.id);
                            }
                            refresh();
                          } catch (err) {
                            pushToast('error', String(err));
                          }
                        }}
                      >
                        {isDefault(p.id) ? '★' : '☆'}
                      </button>
                      <button
                        type="button"
                        className="btn btn-icon"
                        aria-label={t('ps.duplicateAria', { name: p.name })}
                        onClick={() => {
                          try {
                            duplicatePromptTemplate(p.id);
                            refresh();
                            pushToast('success', t('ps.duplicated'));
                          } catch (err) {
                            pushToast('error', String(err));
                          }
                        }}
                      >
                        <Copy size={13} />
                      </button>
                      <button
                        type="button"
                        className="btn btn-icon danger"
                        data-testid="delete-custom-prompt-btn"
                        aria-label={t('ps.deleteAria', { name: p.name })}
                        onClick={() => {
                          deleteCustomPrompt(p.id);
                          if (editingId === p.id) setEditingId(null);
                          refresh();
                          pushToast('info', t('ps.deleted', { name: p.name }));
                        }}
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}

            <h3>{t('ps.builtIn')}</h3>
            <ul className="prompt-studio-card-list built-in">
              {BUILT_IN_PROMPTS.map((p) => (
                <li key={p.id} className="prompt-studio-card">
                  <button
                    type="button"
                    className="prompt-studio-card-main"
                    onClick={() => onSelectPrompt(p)}
                  >
                    <strong>{p.name}</strong>
                    <span className="docs-tag">{p.category}</span>
                    {isDefault(p.id) && <span className="prompt-default-badge">{t('ps.badge')}</span>}
                  </button>
                  <div className="prompt-studio-card-actions">
                    <button
                      type="button"
                      className={`btn btn-icon btn-star-default${isDefault(p.id) ? ' active' : ''}`}
                      data-testid="toggle-default-prompt-btn"
                      aria-label={isDefault(p.id) ? t('ps.clearDefault') : t('ps.setDefault')}
                      onClick={() => {
                        try {
                          if (isDefault(p.id)) {
                            setGlobalDefaultPrompt(null);
                          } else if (defaultScope === 'workspace' && workspacePath) {
                            setWorkspaceDefaultPrompt(workspacePath, p.id);
                          } else {
                            setGlobalDefaultPrompt(p.id);
                          }
                          refresh();
                        } catch (err) {
                          pushToast('error', String(err));
                        }
                      }}
                    >
                      {isDefault(p.id) ? '★' : '☆'}
                    </button>
                    <button
                      type="button"
                      className="btn btn-icon"
                      aria-label={t('ps.duplicateAria', { name: p.name })}
                      title={t('ps.duplicateAsCustom')}
                      onClick={() => {
                        try {
                          const copy = duplicatePromptTemplate(p.id);
                          refresh();
                          startEdit(copy);
                          pushToast('success', t('ps.copyCreated', { name: copy.name }));
                        } catch (err) {
                          pushToast('error', String(err));
                        }
                      }}
                    >
                      <Copy size={13} />
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </div>

          <div className="prompt-studio-editor-col">
            {editingId ? (
              <>
                <h3>{editingId === 'new' ? t('ps.newPrompt') : t('ps.editPrompt')}</h3>
                <label className="prompt-field-label" htmlFor="custom-prompt-name-input">
                  {t('ps.name')}
                </label>
                <input
                  id="custom-prompt-name-input"
                  className="select"
                  data-testid="custom-prompt-name-input"
                  value={name}
                  maxLength={MAX_PROMPT_NAME_LEN}
                  onChange={(e) => setName(e.target.value)}
                  aria-label={t('ps.nameAria')}
                />

                <label className="prompt-field-label" htmlFor="custom-prompt-category">
                  {t('ps.category')}
                </label>
                <select
                  id="custom-prompt-category"
                  className="select"
                  data-testid="custom-prompt-category-select"
                  value={category}
                  onChange={(e) => setCategory(e.target.value as PromptCategory)}
                  aria-label={t('ps.categoryAria')}
                >
                  {CATEGORIES.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>

                <label className="prompt-field-label" htmlFor="custom-prompt-placement">
                  {t('ps.placement')}
                </label>
                <select
                  id="custom-prompt-placement"
                  className="select"
                  data-testid="custom-prompt-placement-select"
                  value={placement}
                  onChange={(e) => setPlacement(e.target.value as PromptPlacement)}
                  aria-label={t('ps.placementAria')}
                >
                  {PLACEMENTS.map((p) => (
                    <option key={p.id} value={p.id}>
                      {t(p.labelKey)}
                    </option>
                  ))}
                </select>

                <label className="prompt-field-label" htmlFor="custom-prompt-desc">
                  {t('ps.description')}
                </label>
                <input
                  id="custom-prompt-desc"
                  className="select"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  aria-label={t('ps.descriptionAria')}
                />

                <div className="variable-chips-bar" data-testid="variable-chips-bar" role="group" aria-label={t('ps.variablesAria')}>
                  {VARIABLE_CHIPS.map((key) => (
                    <button
                      key={key}
                      type="button"
                      className="variable-chip"
                      data-testid={`variable-chip-${key}`}
                      onClick={() => insertVariable(key)}
                    >
                      + {`{{${key}}}`}
                    </button>
                  ))}
                </div>

                <label className="prompt-field-label" htmlFor="custom-prompt-content-input">
                  {t('ps.content')}
                </label>
                <textarea
                  id="custom-prompt-content-input"
                  ref={contentRef}
                  className="prompt-studio-textarea"
                  data-testid="custom-prompt-content-input"
                  value={content}
                  maxLength={MAX_PROMPT_CONTENT_LEN}
                  onChange={(e) => setContent(e.target.value)}
                  aria-label={t('ps.contentAria')}
                  rows={12}
                />
                <div className="prompt-content-meta">
                  <span>
                    {t('ps.chars', {
                      count: content.length.toLocaleString(),
                      max: MAX_PROMPT_CONTENT_LEN.toLocaleString(),
                    })}
                  </span>
                  <span>{t('ps.tokens', { tokens: formatTokens(tokenEst) })}</span>
                </div>

                {secretReport.summary.totalRedactions > 0 && (
                  <div className="prompt-secret-warning" role="status" data-testid="prompt-secret-warning">
                    <span>
                      {t('ps.secretWarning', { count: secretReport.summary.totalRedactions })}
                    </span>
                    <button
                      type="button"
                      className="btn btn-ghost"
                      data-testid="redact-prompt-secret-btn"
                      onClick={() => setContent(redactSecrets(content))}
                    >
                      {t('ps.redactSecret')}
                    </button>
                  </div>
                )}

                <label className="prompt-checkbox-row">
                  <input
                    type="checkbox"
                    data-testid="custom-prompt-set-default-checkbox"
                    checked={setAsDefault}
                    onChange={(e) => setSetAsDefault(e.target.checked)}
                  />
                  {t('ps.setDefaultOnSave')}
                </label>

                <div className="prompt-studio-editor-actions">
                  <button type="button" className="btn btn-ghost" onClick={() => setEditingId(null)}>
                    {t('ps.cancel')}
                  </button>
                  <button
                    type="button"
                    className="btn btn-primary"
                    data-testid="save-custom-prompt-btn"
                    onClick={saveForm}
                  >
                    {t('ps.save')}
                  </button>
                </div>
              </>
            ) : (
              <div className="prompt-studio-editor-empty">
                <Star size={22} aria-hidden />
                <p>{t('ps.emptyEditor')}</p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
