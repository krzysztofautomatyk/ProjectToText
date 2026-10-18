import { useEffect, useRef, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';
import { ExternalLink, File, FileCode2, Folder, FolderOpen, History as HistoryIcon, Info, Monitor, Moon, Pin, PinOff, SlidersHorizontal, MessageSquare, Download, Sun, Upload, Star, Trash2, X, AlertCircle, CheckCircle2 } from 'lucide-react';
import { formatShortcut } from './platform';
import { folderHistoryKey, type FolderHistoryEntry } from './folderHistory';
import { projectPrefKey, type ProjectPref } from './projectPrefs';
import APP_VERSION from './version';
import './index.css';
import { type VisibleTreeRow, type ToastItem, formatBytes, formatTokens, type SubtreeStats } from './treeModel';
import { type ThemePref, type WorkspaceState } from './useWorkspace';
import { createTranslator, useI18n, type TranslateFn } from './i18n';

export { DocumentationAndHowToModal } from './DocumentationModal';
export { PromptStudioManager } from './PromptStudioManager';

export function highlightMatch(text: string, query: string): ReactNode {
  if (!query.trim()) return text;
  const q = query.trim();
  const lower = text.toLowerCase();
  const idx = lower.indexOf(q.toLowerCase());
  if (idx === -1) return text;
  return (
    <>
      {text.slice(0, idx)}
      <mark className="mark">{text.slice(idx, idx + q.length)}</mark>
      {text.slice(idx + q.length)}
    </>
  );
}


export const ABOUT_REPO_URL = 'https://github.com/krzysztofautomatyk/ProjectToText';
export const ABOUT_AUTHOR = 'Krzysztof Wozniczak';
export const ABOUT_FRONTEND_LIBS = [
  '@tauri-apps/api',
  '@tauri-apps/plugin-dialog',
  '@tauri-apps/plugin-process',
  '@tauri-apps/plugin-updater',
  'react',
  'react-dom',
  'lucide-react',
  'highlight.js',
];
export const ABOUT_BACKEND_LIBS = [
  'tauri',
  'tauri-plugin-dialog',
  'tauri-plugin-process',
  'tauri-plugin-updater',
  'serde',
  'serde_json',
  'ignore',
  'content_inspector',
  'encoding_rs',
  'tokio',
  'arboard',
  'open',
  'dunce',
  'regex',
  'rayon',
  'notify',
  'tiktoken-rs',
  'globset',
  'tree-sitter',
];

export function AboutDialog({
  onClose,
  onOpenRepo,
}: {
  onClose: () => void;
  onOpenRepo: () => void;
}) {
  const { t, tRich } = useI18n();
  const libList = { display: 'flex', flexWrap: 'wrap', gap: 6, listStyle: 'none', padding: 0, margin: 0 } as const;
  return (
    <div className="help-overlay" role="presentation" onClick={onClose}>
      <div
        className="help-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="about-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="help-header">
          <h2 id="about-title">{t('about.title')}</h2>
          <button
            type="button"
            className="btn btn-ghost btn-icon"
            onClick={onClose}
            aria-label={t('about.closeAria')}
          >
            <X size={14} />
          </button>
        </div>
        <p>
          {t('about.version', { version: APP_VERSION })}
        </p>
        <p>{tRich('about.author', { author: ABOUT_AUTHOR })}</p>
        <p>
          <button type="button" className="panel-link" onClick={onOpenRepo}>
            <ExternalLink size={12} aria-hidden /> {ABOUT_REPO_URL}
          </button>
        </p>
        <h3>{t('about.frontend')}</h3>
        <ul style={libList}>
          {ABOUT_FRONTEND_LIBS.map((lib) => (
            <li key={lib} className="kbd">{lib}</li>
          ))}
        </ul>
        <h3>{t('about.backend')}</h3>
        <ul style={libList}>
          {ABOUT_BACKEND_LIBS.map((lib) => (
            <li key={lib} className="kbd">{lib}</li>
          ))}
        </ul>
      </div>
    </div>
  );
}

export function ToastViewport({
  toasts,
  onDismiss,
}: {
  toasts: ToastItem[];
  onDismiss: (id: number) => void;
}) {
  const { t } = useI18n();
  return (
    <div className="toast-viewport" aria-live="polite" aria-relevant="additions">
      {toasts.map((toast) => (
        <div key={toast.id} className={`toast ${toast.kind}`} role="status">
          <span className="toast-icon" aria-hidden>
            {toast.kind === 'success' ? (
              <CheckCircle2 size={15} />
            ) : toast.kind === 'error' ? (
              <AlertCircle size={15} />
            ) : (
              <Info size={15} />
            )}
          </span>
          <span>{toast.message}</span>
          <button
            className="btn btn-ghost btn-icon"
            style={{ marginLeft: 'auto', height: 22, width: 22 }}
            onClick={() => onDismiss(toast.id)}
            aria-label={t('toast.dismiss')}
          >
            <X size={12} />
          </button>
        </div>
      ))}
    </div>
  );
}

export function formatHistoryDate(
  timestamp: number,
  t: TranslateFn = createTranslator('en'),
  locale?: string,
): string {
  if (!timestamp) return t('history.previouslyOpened');
  const options: Intl.DateTimeFormatOptions = {
    month: 'short',
    day: 'numeric',
    year: timestamp > Date.now() - 365 * 24 * 60 * 60 * 1000 ? undefined : 'numeric',
  };
  let date: string;
  try {
    date = new Intl.DateTimeFormat(locale, options).format(timestamp);
  } catch {
    date = new Intl.DateTimeFormat(undefined, options).format(timestamp);
  }
  return t('history.opened', { date });
}

export function ImportPrefsDialog({ ws }: { ws: WorkspaceState }) {
  const {
    cancelImportPrefs,
    confirmImportPrefs,
    importApplyDefault,
    importMode,
    importPreview,
    setImportApplyDefault,
    setImportMode,
  } = ws;
  const { t } = useI18n();
  if (!importPreview) return null;
  return (
    <div className="help-overlay import-prefs-overlay" role="presentation" onClick={cancelImportPrefs}>
      <div
        className="help-card import-prefs-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="import-prefs-title"
        data-testid="import-prefs-dialog"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') cancelImportPrefs();
        }}
      >
        <div className="help-header">
          <h2 id="import-prefs-title">{t('import.title')}</h2>
          <button
            type="button"
            className="btn btn-ghost btn-icon"
            onClick={cancelImportPrefs}
            aria-label={t('import.cancelAria')}
          >
            <X size={14} />
          </button>
        </div>
        <ul className="import-preview-stats" data-testid="import-preview-stats">
          <li>
            {t('import.projects')} <strong>{importPreview.projectsCount}</strong>
          </li>
          <li>
            {t('import.history')} <strong>{importPreview.historyCount}</strong>
          </li>
          <li>
            {t('import.promptsNew')} <strong data-testid="import-prompts-new">{importPreview.promptsNew}</strong>,{' '}
            {t('import.promptsUpdated')}{' '}
            <strong data-testid="import-prompts-updated">{importPreview.promptsUpdated}</strong>,{' '}
            {t('import.promptsDupes')}{' '}
            <strong data-testid="import-prompts-dupes">{importPreview.promptsDuplicates}</strong>
          </li>
          {importPreview.hasI18n && (
            <li data-testid="import-i18n-packs">
              {t('import.languages')} <strong>{importPreview.i18nPacksCount}</strong>
              {importPreview.i18nActiveLocale && (
                <>
                  {' '}
                  · {t('import.activeLanguage')} <strong>{importPreview.i18nActiveLocale}</strong>
                </>
              )}
            </li>
          )}
          {importPreview.defaultPromptName && (
            <li data-testid="import-default-prompt-name">
              {t('import.defaultPrompt')} <strong>{importPreview.defaultPromptName}</strong>
            </li>
          )}
        </ul>
        {importPreview.secretWarnings.length > 0 && (
          <div
            className="import-secret-banner"
            role="alert"
            data-testid="import-secret-warning"
          >
            {t('import.secretWarning')}
            <ul>
              {importPreview.secretWarnings.map((w) => (
                <li key={w.promptName}>
                  {w.promptName} ({w.findingsCount})
                </li>
              ))}
            </ul>
          </div>
        )}
        <fieldset className="import-mode-fieldset">
          <legend>{t('import.modeLegend')}</legend>
          <label>
            <input
              type="radio"
              name="import-mode"
              data-testid="import-mode-merge"
              checked={importMode === 'merge'}
              onChange={() => setImportMode('merge')}
            />{' '}
            {t('import.modeMerge')}
          </label>
          <label>
            <input
              type="radio"
              name="import-mode"
              data-testid="import-mode-replace"
              checked={importMode === 'replace'}
              onChange={() => setImportMode('replace')}
            />{' '}
            {t('import.modeReplace')}
          </label>
        </fieldset>
        {importPreview.defaultPromptId && (
          <label className="prompt-checkbox-row">
            <input
              type="checkbox"
              data-testid="import-apply-default-checkbox"
              checked={importApplyDefault}
              onChange={(e) => setImportApplyDefault(e.target.checked)}
            />
            {t('import.applyDefault')}
          </label>
        )}
        <div className="import-prefs-actions">
          <button type="button" className="btn btn-ghost" onClick={cancelImportPrefs}>
            {t('import.cancel')}
          </button>
          <button
            type="button"
            className="btn btn-primary"
            data-testid="confirm-import-btn"
            onClick={confirmImportPrefs}
          >
            {t('import.confirm')}
          </button>
        </div>
      </div>
    </div>
  );
}

export function CustomProjectsPanel({
  entries,
  currentPath,
  scanning,
  onClose,
  onOpen,
  onToggleFavorite,
  onNoteChange,
  onClearDeselect,
  onRemove,
  onExport,
  onImport,
  onExportPrompts,
}: {
  entries: ProjectPref[];
  currentPath: string;
  scanning: boolean;
  onClose: () => void;
  onOpen: (entry: ProjectPref) => void;
  onToggleFavorite: (entry: ProjectPref) => void;
  onNoteChange: (entry: ProjectPref, note: string) => void;
  onClearDeselect: (entry: ProjectPref) => void;
  onRemove: (entry: ProjectPref) => void;
  onExport: () => void;
  onImport: () => void;
  onExportPrompts?: () => void;
}) {
  const { t } = useI18n();
  return (
    <div className="history-overlay" role="presentation" onClick={onClose}>
      <section
        className="history-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="custom-projects-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="history-header">
          <div>
            <h2 id="custom-projects-title">{t('custom.title')}</h2>
            <p>{t('custom.desc')}</p>
          </div>
          <button
            type="button"
            className="btn btn-ghost btn-icon"
            onClick={onClose}
            aria-label={t('custom.closeAria')}
          >
            <X size={14} />
          </button>
        </div>

        <div className="history-toolbar custom-transfer" data-testid="custom-transfer">
          <button type="button" className="panel-link" onClick={onExport} data-testid="export-prefs-btn">
            <Download size={12} aria-hidden /> {t('custom.exportAll')}
          </button>
          {onExportPrompts && (
            <button
              type="button"
              className="panel-link"
              onClick={onExportPrompts}
              data-testid="export-prompts-only-btn"
            >
              <Download size={12} aria-hidden /> {t('custom.exportPrompts')}
            </button>
          )}
          <button type="button" className="panel-link" onClick={onImport} data-testid="import-prefs-btn">
            <Upload size={12} aria-hidden /> {t('custom.import')}
          </button>
          <span className="custom-transfer-hint">{t('custom.hint')}</span>
        </div>

        {entries.length > 0 ? (
          <div className="history-list">
            {entries.map((entry) => {
              const isCurrent =
                !!currentPath &&
                projectPrefKey(currentPath) === projectPrefKey(entry.path);
              return (
                <div
                  className={`history-item custom-item${isCurrent ? ' is-current' : ''}`}
                  key={projectPrefKey(entry.path)}
                >
                  <div className="custom-item-body">
                    <button
                      type="button"
                      className="history-entry"
                      onClick={() => onOpen(entry)}
                      disabled={scanning}
                      title={entry.path}
                    >
                      <FolderOpen size={16} className="history-entry-icon" aria-hidden />
                      <span className="history-entry-copy">
                        <strong>{entry.name}</strong>
                        <span>{entry.path}</span>
                      </span>
                      {isCurrent && <span className="history-current">{t('common.current')}</span>}
                    </button>

                    {entry.deselectPaths.length > 0 && (
                      <div className="custom-deselect" data-testid="custom-deselect">
                        <span className="custom-deselect-label" aria-hidden>
                          <X size={11} /> {t('custom.deselected', { count: entry.deselectPaths.length })}
                        </span>
                        <button
                          type="button"
                          className="panel-link"
                          onClick={() => onClearDeselect(entry)}
                          aria-label={t('custom.clearDeselectAria', { name: entry.name })}
                        >
                          {t('custom.clearDeselect')}
                        </button>
                      </div>
                    )}

                    <div className="custom-note-row" data-testid="custom-note">
                      <MessageSquare size={12} className="icon-muted" aria-hidden />
                      <textarea
                        className="custom-note-input"
                        rows={1}
                        placeholder={t('custom.notePlaceholder')}
                        value={entry.note}
                        onChange={(e) => onNoteChange(entry, e.target.value)}
                        aria-label={t('custom.noteAria', { name: entry.name })}
                      />
                    </div>
                  </div>

                  <div className="history-item-actions">
                    <button
                      type="button"
                      className={`btn btn-icon history-action${entry.favorite ? ' is-pinned' : ''}`}
                      onClick={() => onToggleFavorite(entry)}
                      aria-label={
                        entry.favorite
                          ? t('custom.unfavoriteAria', { name: entry.name })
                          : t('custom.favoriteAria', { name: entry.name })
                      }
                      title={entry.favorite ? t('custom.unfavoriteTitle') : t('custom.favoriteTitle')}
                    >
                      {entry.favorite ? (
                        <Star size={14} fill="currentColor" />
                      ) : (
                        <Star size={14} />
                      )}
                    </button>
                    <button
                      type="button"
                      className="btn btn-icon history-action danger"
                      onClick={() => onRemove(entry)}
                      aria-label={t('custom.removeAria', { name: entry.name })}
                      title={t('custom.removeTitle')}
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="history-empty">
            <SlidersHorizontal size={22} aria-hidden />
            <strong>{t('custom.emptyTitle')}</strong>
            <span>{t('custom.emptyDesc')}</span>
          </div>
        )}
      </section>
    </div>
  );
}

export function FolderHistoryPanel({
  entries,
  currentPath,
  scanning,
  onClose,
  onOpen,
  onTogglePin,
  onRemove,
  onClear,
}: {
  entries: FolderHistoryEntry[];
  currentPath: string;
  scanning: boolean;
  onClose: () => void;
  onOpen: (entry: FolderHistoryEntry) => void;
  onTogglePin: (entry: FolderHistoryEntry) => void;
  onRemove: (entry: FolderHistoryEntry) => void;
  onClear: () => void;
}) {
  const { t, locale } = useI18n();
  return (
    <div className="history-overlay" role="presentation" onClick={onClose}>
      <section
        className="history-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="folder-history-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="history-header">
          <div>
            <h2 id="folder-history-title">{t('history.title')}</h2>
            <p>{t('history.desc')}</p>
          </div>
          <button
            type="button"
            className="btn btn-ghost btn-icon"
            onClick={onClose}
            aria-label={t('history.closeAria')}
          >
            <X size={14} />
          </button>
        </div>

        {entries.length > 0 ? (
          <>
            <div className="history-toolbar">
              <span>
                {t(entries.length === 1 ? 'history.savedOne' : 'history.savedMany', {
                  count: entries.length,
                })}
              </span>
              <button type="button" className="panel-link" onClick={onClear}>
                {t('history.clear')}
              </button>
            </div>
            <div className="history-list">
              {entries.map((entry) => {
                const isCurrent =
                  !!currentPath && folderHistoryKey(currentPath) === folderHistoryKey(entry.path);
                return (
                  <div
                    className={`history-item${isCurrent ? ' is-current' : ''}`}
                    key={folderHistoryKey(entry.path)}
                  >
                    <button
                      type="button"
                      className="history-entry"
                      onClick={() => onOpen(entry)}
                      disabled={scanning}
                      title={entry.path}
                    >
                      <FolderOpen size={16} className="history-entry-icon" aria-hidden />
                      <span className="history-entry-copy">
                        <strong>{entry.name}</strong>
                        <span>{entry.path}</span>
                        <small>{formatHistoryDate(entry.lastOpenedAt, t, locale)}</small>
                      </span>
                      {isCurrent && <span className="history-current">{t('common.current')}</span>}
                    </button>
                    <div className="history-item-actions">
                      <button
                        type="button"
                        className={`btn btn-icon history-action${entry.pinned ? ' is-pinned' : ''}`}
                        onClick={() => onTogglePin(entry)}
                        aria-label={
                          entry.pinned
                            ? t('history.unpinAria', { name: entry.name })
                            : t('history.pinAria', { name: entry.name })
                        }
                        title={entry.pinned ? t('history.unpinTitle') : t('history.pinTitle')}
                      >
                        {entry.pinned ? <PinOff size={14} /> : <Pin size={14} />}
                      </button>
                      <button
                        type="button"
                        className="btn btn-icon history-action danger"
                        onClick={() => onRemove(entry)}
                        aria-label={t('history.removeAria', { name: entry.name })}
                        title={t('history.removeTitle')}
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        ) : (
          <div className="history-empty">
            <HistoryIcon size={22} aria-hidden />
            <strong>{t('history.emptyTitle')}</strong>
            <span>{t('history.emptyDesc')}</span>
          </div>
        )}
      </section>
    </div>
  );
}

export function TreeRow({
  row,
  selectedSet,
  skeletonSet,
  filterText,
  onToggleExpand,
  onToggleSelect,
  onToggleSkeleton,
  onFocusPath,
  onOpenFile,
  onContextMenu,
  focusedPath,
  previewPath,
  subtreeStats,
}: {
  row: VisibleTreeRow;
  selectedSet: Set<string>;
  skeletonSet: Set<string>;
  filterText: string;
  onToggleExpand: (path: string) => void;
  onToggleSelect: (path: string, isDir: boolean) => void;
  onToggleSkeleton: (path: string, isDir: boolean) => void;
  onFocusPath: (path: string) => void;
  onOpenFile: (path: string) => void;
  onContextMenu: (e: ReactMouseEvent, path: string, isDir: boolean) => void;
  focusedPath: string | null;
  previewPath: string | null;
  subtreeStats: Map<string, SubtreeStats>;
}) {
  const { node, depth, hasChildren, showChildren } = row;
  const { t } = useI18n();
  const checkRef = useRef<HTMLInputElement>(null);

  const subtree = subtreeStats.get(node.path) ?? {
    selected: 0,
    total: 0,
    partial: false,
    allSelected: false,
    allSkeleton: false,
    tokens: 0,
  };

  const isSelected = node.isDir
    ? subtree.allSelected && subtree.total > 0
    : selectedSet.has(node.path);
  const isPartial = node.isDir && subtree.partial;
  const isPreviewing = !node.isDir && previewPath === node.path;
  const isSkeleton = node.isDir
    ? subtree.allSkeleton && subtree.total > 0
    : skeletonSet.has(node.path);

  useEffect(() => {
    if (checkRef.current) {
      checkRef.current.indeterminate = isPartial;
    }
  }, [isPartial]);

  const handleRowClick = () => {
    onFocusPath(node.path);
    if (hasChildren) onToggleExpand(node.path);
    else onOpenFile(node.path);
  };

  const handleKeyDown = (e: ReactKeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      handleRowClick();
    } else if (e.key === 'ArrowRight' && hasChildren && !showChildren) {
      e.preventDefault();
      onToggleExpand(node.path);
    } else if (e.key === 'ArrowLeft' && hasChildren && showChildren) {
      e.preventDefault();
      onToggleExpand(node.path);
    }
  };

  const matchesFilter =
    !!filterText.trim() &&
    (node.name.toLowerCase().includes(filterText.toLowerCase()) ||
      node.path.toLowerCase().includes(filterText.toLowerCase()));

  return (
    <div
      className={[
        'tree-item',
        isSelected && !isPartial ? 'is-selected' : '',
        isPartial ? 'is-partial' : '',
        isPreviewing ? 'is-previewing' : '',
        matchesFilter ? 'is-filtered-match' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      style={{ paddingLeft: `${depth * 14 + 4}px`, height: '28px' } as CSSProperties}
      onClick={handleRowClick}
      onContextMenu={(e) => onContextMenu(e, node.path, node.isDir)}
      onKeyDown={handleKeyDown}
      tabIndex={0}
      role="treeitem"
      aria-expanded={hasChildren ? showChildren : undefined}
      aria-selected={isSelected || isPartial}
      data-path={node.path}
      data-focused={focusedPath === node.path || undefined}
    >
      {hasChildren ? (
        <button
          type="button"
          className="tree-chevron"
          onClick={(e) => {
            e.stopPropagation();
            onToggleExpand(node.path);
          }}
          aria-label={showChildren ? t('tree.collapseFolder') : t('tree.expandFolder')}
          tabIndex={-1}
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            style={{
              transform: showChildren ? 'rotate(90deg)' : 'rotate(0deg)',
              transition: 'transform 0.12s ease',
            }}
          >
            <path d="m9 18 6-6-6-6" />
          </svg>
        </button>
      ) : (
        <span className="tree-chevron" aria-hidden style={{ visibility: 'hidden' }} />
      )}

      <span className="tree-icon" aria-hidden>
        {node.isDir ? <Folder size={15} /> : <File size={15} />}
      </span>

      <span className="tree-name">
        {highlightMatch(node.name, filterText)}
        {hasChildren && subtree.total > 0 && (
          <span className="tree-count">
            {subtree.selected}/{subtree.total}
          </span>
        )}
      </span>

      {!node.isDir && node.gitStatus && (
        <span
          className={`tree-git-badge git-${node.gitStatus}`}
          title={t('tree.gitStatus', { status: node.gitStatus })}
          data-testid={`git-badge-${node.path}`}
        >
          {node.gitStatus}
        </span>
      )}

      <button
        type="button"
        className={`tree-skel-btn${isSkeleton ? ' is-active' : ''}`}
        title={t('tree.skeletonTitle')}
        aria-label={t('tree.skeletonAria', { name: node.name })}
        aria-pressed={isSkeleton}
        onClick={(e) => {
          e.stopPropagation();
          onToggleSkeleton(node.path, node.isDir);
        }}
      >
        S
      </button>

      {!node.isDir && node.size != null && node.size > 0 && (
        <span className="tree-size">{formatBytes(node.size)}</span>
      )}

      {subtree.tokens > 0 && (
        <span className="tree-tokens" title={t('tree.tokensTitle')}>
          {t('tree.tokens', { tokens: formatTokens(subtree.tokens) })}
        </span>
      )}

      <label className="tree-check" onClick={(e) => e.stopPropagation()}>
        <input
          ref={checkRef}
          type="checkbox"
          checked={isSelected}
          onChange={() => onToggleSelect(node.path, node.isDir)}
          aria-label={
            node.isDir
              ? isPartial
                ? t('tree.selectPartial', { name: node.name })
                : t('tree.selectFolder', { name: node.name })
              : t('tree.selectFile', { name: node.name })
          }
        />
      </label>
    </div>
  );
}

export function ShortcutsHelpDialog({ ws }: { ws: WorkspaceState }) {
  const { setShowHelp, setThemePref, showHelp, themePref } = ws;
  const { t } = useI18n();
  if (!showHelp) return null;
  return (
    <div
      className="help-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="help-title"
      onClick={() => setShowHelp(false)}
      onKeyDown={(e) => {
        if (e.key === 'Tab') {
          const root = e.currentTarget.querySelector('.help-card');
          if (!root) return;
          const focusable = root.querySelectorAll<HTMLElement>(
            'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
          );
          if (focusable.length === 0) return;
          const first = focusable[0];
          const last = focusable[focusable.length - 1];
          if (e.shiftKey && document.activeElement === first) {
            e.preventDefault();
            last.focus();
          } else if (!e.shiftKey && document.activeElement === last) {
            e.preventDefault();
            first.focus();
          }
        }
      }}
    >
      <div className="help-card" onClick={(e) => e.stopPropagation()}>
        <div className="help-header">
          <h2 id="help-title">{t('help.title')}</h2>
          <button
            type="button"
            className="btn btn-ghost btn-icon"
            onClick={() => setShowHelp(false)}
            aria-label={t('help.close')}
          >
            <X size={14} />
          </button>
        </div>
        <dl className="help-list">
          <div>
            <dt>
              <span className="kbd">{formatShortcut('O')}</span>
            </dt>
            <dd>{t('help.open')}</dd>
          </div>
          <div>
            <dt>
              <span className="kbd">{formatShortcut('R')}</span>
            </dt>
            <dd>{t('help.refresh')}</dd>
          </div>
          <div>
            <dt>
              <span className="kbd">{formatShortcut('F')}</span>
            </dt>
            <dd>{t('help.focus')}</dd>
          </div>
          <div>
            <dt>
              <span className="kbd">{formatShortcut('C')}</span>
            </dt>
            <dd>{t('help.copy')}</dd>
          </div>
          <div>
            <dt>
              <span className="kbd">{formatShortcut('S')}</span>
            </dt>
            <dd>{t('help.save')}</dd>
          </div>
          <div>
            <dt>
              <span className="kbd">Esc</span>
            </dt>
            <dd>{t('help.esc')}</dd>
          </div>
          <div>
            <dt>
              <span className="kbd">?</span>
            </dt>
            <dd>{t('help.toggle')}</dd>
          </div>
          <div>
            <dt>
              <span className="kbd">F1</span> / <span className="kbd">{formatShortcut('/')}</span>
            </dt>
            <dd>{t('help.docs')}</dd>
          </div>
          <div>
            <dt>
              <span className="kbd">Space</span> / <span className="kbd">Enter</span>
            </dt>
            <dd>{t('help.spaceEnter')}</dd>
          </div>
          <div>
            <dt>
              <span className="kbd">{t('help.rightClickKey')}</span>
            </dt>
            <dd>{t('help.rightClick')}</dd>
          </div>
          <div>
            <dt>
              <span className="kbd">{t('help.checkboxKey')}</span>
            </dt>
            <dd>{t('help.checkbox')}</dd>
          </div>
        </dl>
        <div className="help-theme">
          <span className="help-theme-label">{t('help.appearance')}</span>
          <div className="theme-segment" role="group" aria-label={t('help.colorTheme')}>
            {(['light', 'dark', 'system'] as ThemePref[]).map((opt) => (
              <button
                key={opt}
                type="button"
                className={`theme-segment-btn${themePref === opt ? ' is-active' : ''}`}
                onClick={() => setThemePref(opt)}
                aria-pressed={themePref === opt}
              >
                {opt === 'light' ? <Sun size={13} /> : opt === 'dark' ? <Moon size={13} /> : <Monitor size={13} />}
                {t(`theme.${opt}`)}
              </button>
            ))}
          </div>
        </div>
        <p className="help-foot">
          {t('help.foot')}
        </p>
      </div>
    </div>
  );
}


export function TreeContextMenu({ ws }: { ws: WorkspaceState }) {
  const {
    contextMenu,
    openFilePreview,
    openInDefaultApp,
    openWithApp,
    pickAppAndOpen,
    selectRelatedFiles,
    setContextMenu,
    toggleSelect,
    toggleSkeleton,
  } = ws;
  const { t } = useI18n();
  if (!contextMenu) return null;
  return (
    <div
      className="ctx-menu"
      style={{ top: contextMenu.y, left: contextMenu.x }}
      role="menu"
      onClick={(e) => e.stopPropagation()}
    >
      <button
        type="button"
        role="menuitem"
        className="ctx-item"
        onClick={() => void openFilePreview(contextMenu.path)}
      >
        <FileCode2 size={14} /> {t('ctx.preview')}
      </button>
      <button
        type="button"
        role="menuitem"
        className="ctx-item"
        onClick={() => void openInDefaultApp(contextMenu.path)}
      >
        <ExternalLink size={14} /> {t('ctx.openDefault')}
      </button>
      <button
        type="button"
        role="menuitem"
        className="ctx-item"
        onClick={() => void openWithApp('code', contextMenu.path)}
      >
        {t('ctx.openVscode')}
      </button>
      <button
        type="button"
        role="menuitem"
        className="ctx-item"
        onClick={() => void openWithApp('notepad++', contextMenu.path)}
      >
        {t('ctx.openNotepad')}
      </button>
      <button
        type="button"
        role="menuitem"
        className="ctx-item"
        onClick={() => void pickAppAndOpen(contextMenu.path)}
      >
        {t('ctx.chooseProgram')}
      </button>
      <div className="ctx-sep" />
      <button
        type="button"
        role="menuitem"
        className="ctx-item"
        onClick={() => {
          toggleSelect(contextMenu.path, false);
          setContextMenu(null);
        }}
      >
        {t('ctx.togglePack')}
      </button>
      <button
        type="button"
        role="menuitem"
        className="ctx-item"
        onClick={() => {
          toggleSkeleton(contextMenu.path, false);
          setContextMenu(null);
        }}
      >
        {t('ctx.skeleton')}
      </button>
      <div className="ctx-sep" />
      <button
        type="button"
        role="menuitem"
        className="ctx-item"
        style={{ fontWeight: 600 }}
        onClick={() => void selectRelatedFiles(contextMenu.path, 'all')}
      >
        {t('ctx.related')}
      </button>
      <button
        type="button"
        role="menuitem"
        className="ctx-item"
        onClick={() => void selectRelatedFiles(contextMenu.path, 'imports')}
      >
        {t('ctx.imports')}
      </button>
      <button
        type="button"
        role="menuitem"
        className="ctx-item"
        onClick={() => void selectRelatedFiles(contextMenu.path, 'importers')}
      >
        {t('ctx.importers')}
      </button>
      <button
        type="button"
        role="menuitem"
        className="ctx-item"
        onClick={() => void selectRelatedFiles(contextMenu.path, 'tests')}
      >
        {t('ctx.tests')}
      </button>
    </div>
  );
}

