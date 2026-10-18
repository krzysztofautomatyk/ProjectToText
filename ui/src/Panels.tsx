import { useEffect, useRef, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';
import { ExternalLink, File, FileCode2, Folder, FolderOpen, History as HistoryIcon, Info, Monitor, Moon, Pin, PinOff, SlidersHorizontal, MessageSquare, Download, Sun, Upload, Star, Trash2, X, AlertCircle, CheckCircle2 } from 'lucide-react';
import { formatShortcut } from './platform';
import { folderHistoryKey, type FolderHistoryEntry } from './folderHistory';
import { projectPrefKey, type ProjectPref } from './projectPrefs';
import APP_VERSION from './version';
import './index.css';
import { type VisibleTreeRow, type ToastItem, formatBytes, formatTokens, type SubtreeStats } from './treeModel';
import { themeLabel, type ThemePref, type WorkspaceState } from './useWorkspace';

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
          <h2 id="about-title">About ptt</h2>
          <button
            type="button"
            className="btn btn-ghost btn-icon"
            onClick={onClose}
            aria-label="Close about"
          >
            <X size={14} />
          </button>
        </div>
        <p>
          ProjectToText (ptt) · version {APP_VERSION}
        </p>
        <p>
          Author: <strong>{ABOUT_AUTHOR}</strong>
        </p>
        <p>
          <button type="button" className="panel-link" onClick={onOpenRepo}>
            <ExternalLink size={12} aria-hidden /> {ABOUT_REPO_URL}
          </button>
        </p>
        <h3>Frontend libraries</h3>
        <ul style={libList}>
          {ABOUT_FRONTEND_LIBS.map((lib) => (
            <li key={lib} className="kbd">{lib}</li>
          ))}
        </ul>
        <h3>Backend libraries (Rust)</h3>
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
  return (
    <div className="toast-viewport" aria-live="polite" aria-relevant="additions">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`} role="status">
          <span className="toast-icon" aria-hidden>
            {t.kind === 'success' ? (
              <CheckCircle2 size={15} />
            ) : t.kind === 'error' ? (
              <AlertCircle size={15} />
            ) : (
              <Info size={15} />
            )}
          </span>
          <span>{t.message}</span>
          <button
            className="btn btn-ghost btn-icon"
            style={{ marginLeft: 'auto', height: 22, width: 22 }}
            onClick={() => onDismiss(t.id)}
            aria-label="Dismiss notification"
          >
            <X size={12} />
          </button>
        </div>
      ))}
    </div>
  );
}

export function formatHistoryDate(timestamp: number): string {
  if (!timestamp) return 'Previously opened';
  return `Opened ${new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    year: timestamp > Date.now() - 365 * 24 * 60 * 60 * 1000 ? undefined : 'numeric',
  }).format(timestamp)}`;
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
  if (!importPreview) return null;
  return (
    <div className="help-overlay" role="presentation" onClick={cancelImportPrefs}>
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
          <h2 id="import-prefs-title">Podgląd importu</h2>
          <button
            type="button"
            className="btn btn-ghost btn-icon"
            onClick={cancelImportPrefs}
            aria-label="Cancel import"
          >
            <X size={14} />
          </button>
        </div>
        <ul className="import-preview-stats" data-testid="import-preview-stats">
          <li>
            Projekty w paczce: <strong>{importPreview.projectsCount}</strong>
          </li>
          <li>
            Historia: <strong>{importPreview.historyCount}</strong>
          </li>
          <li>
            Prompty — nowe: <strong data-testid="import-prompts-new">{importPreview.promptsNew}</strong>,
            zaktualizowane:{' '}
            <strong data-testid="import-prompts-updated">{importPreview.promptsUpdated}</strong>,
            duplikaty:{' '}
            <strong data-testid="import-prompts-dupes">{importPreview.promptsDuplicates}</strong>
          </li>
          {importPreview.defaultPromptName && (
            <li data-testid="import-default-prompt-name">
              Domyślny prompt w pliku: <strong>{importPreview.defaultPromptName}</strong>
            </li>
          )}
        </ul>
        {importPreview.secretWarnings.length > 0 && (
          <div
            className="import-secret-banner"
            role="alert"
            data-testid="import-secret-warning"
          >
            Ostrzeżenie: w importowanych promptach wykryto potencjalne sekrety / klucze API:
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
          <legend>Tryb importu</legend>
          <label>
            <input
              type="radio"
              name="import-mode"
              data-testid="import-mode-merge"
              checked={importMode === 'merge'}
              onChange={() => setImportMode('merge')}
            />{' '}
            Merge — scal bez utraty lokalnych promptów
          </label>
          <label>
            <input
              type="radio"
              name="import-mode"
              data-testid="import-mode-replace"
              checked={importMode === 'replace'}
              onChange={() => setImportMode('replace')}
            />{' '}
            Replace — zastąp Prompt Studio stanem z pliku
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
            Zastosuj domyślny prompt z importowanego pliku
          </label>
        )}
        <div className="import-prefs-actions">
          <button type="button" className="btn btn-ghost" onClick={cancelImportPrefs}>
            Anuluj
          </button>
          <button
            type="button"
            className="btn btn-primary"
            data-testid="confirm-import-btn"
            onClick={confirmImportPrefs}
          >
            Zatwierdź import
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
            <h2 id="custom-projects-title">Custom projects</h2>
            <p>
              Projects with saved selection exclusions, favorites first. Notes and
              excluded files are kept on this device.
            </p>
          </div>
          <button
            type="button"
            className="btn btn-ghost btn-icon"
            onClick={onClose}
            aria-label="Close custom projects"
          >
            <X size={14} />
          </button>
        </div>

        <div className="history-toolbar custom-transfer" data-testid="custom-transfer">
          <button type="button" className="panel-link" onClick={onExport} data-testid="export-prefs-btn">
            <Download size={12} aria-hidden /> Export all
          </button>
          {onExportPrompts && (
            <button
              type="button"
              className="panel-link"
              onClick={onExportPrompts}
              data-testid="export-prompts-only-btn"
            >
              <Download size={12} aria-hidden /> Export Prompt Studio
            </button>
          )}
          <button type="button" className="panel-link" onClick={onImport} data-testid="import-prefs-btn">
            <Upload size={12} aria-hidden /> Import…
          </button>
          <span className="custom-transfer-hint">JSON · preview → Merge / Replace</span>
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
                      {isCurrent && <span className="history-current">Current</span>}
                    </button>

                    {entry.deselectPaths.length > 0 && (
                      <div className="custom-deselect" data-testid="custom-deselect">
                        <span className="custom-deselect-label" aria-hidden>
                          <X size={11} /> {entry.deselectPaths.length} deselected
                        </span>
                        <button
                          type="button"
                          className="panel-link"
                          onClick={() => onClearDeselect(entry)}
                          aria-label={`Clear saved deselect list for ${entry.name}`}
                        >
                          Clear deselections
                        </button>
                      </div>
                    )}

                    <div className="custom-note-row" data-testid="custom-note">
                      <MessageSquare size={12} className="icon-muted" aria-hidden />
                      <textarea
                        className="custom-note-input"
                        rows={1}
                        placeholder="Add a note… (e.g. why these files are excluded)"
                        value={entry.note}
                        onChange={(e) => onNoteChange(entry, e.target.value)}
                        aria-label={`Note for ${entry.name}`}
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
                          ? `Remove ${entry.name} from favorites`
                          : `Add ${entry.name} to favorites`
                      }
                      title={entry.favorite ? 'Unfavorite project' : 'Favorite project'}
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
                      aria-label={`Remove ${entry.name} from custom projects`}
                      title="Remove from custom projects"
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
            <strong>No custom projects yet</strong>
            <span>
              Open a project and deselect some files — they will be remembered here.
            </span>
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
            <h2 id="folder-history-title">Folder history</h2>
            <p>Pin projects you open often. History is saved on this device.</p>
          </div>
          <button
            type="button"
            className="btn btn-ghost btn-icon"
            onClick={onClose}
            aria-label="Close folder history"
          >
            <X size={14} />
          </button>
        </div>

        {entries.length > 0 ? (
          <>
            <div className="history-toolbar">
              <span>{entries.length} saved folder{entries.length === 1 ? '' : 's'}</span>
              <button type="button" className="panel-link" onClick={onClear}>
                Clear history
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
                        <small>{formatHistoryDate(entry.lastOpenedAt)}</small>
                      </span>
                      {isCurrent && <span className="history-current">Current</span>}
                    </button>
                    <div className="history-item-actions">
                      <button
                        type="button"
                        className={`btn btn-icon history-action${entry.pinned ? ' is-pinned' : ''}`}
                        onClick={() => onTogglePin(entry)}
                        aria-label={entry.pinned ? `Unpin ${entry.name}` : `Pin ${entry.name}`}
                        title={entry.pinned ? 'Unpin folder' : 'Pin folder'}
                      >
                        {entry.pinned ? <PinOff size={14} /> : <Pin size={14} />}
                      </button>
                      <button
                        type="button"
                        className="btn btn-icon history-action danger"
                        onClick={() => onRemove(entry)}
                        aria-label={`Remove ${entry.name} from history`}
                        title="Remove from history"
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
            <strong>No folders in history</strong>
            <span>Open a project and it will appear here for quick access.</span>
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
          aria-label={showChildren ? 'Collapse folder' : 'Expand folder'}
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
          title={`Git status: ${node.gitStatus}`}
          data-testid={`git-badge-${node.path}`}
        >
          {node.gitStatus}
        </span>
      )}

      <button
        type="button"
        className={`tree-skel-btn${isSkeleton ? ' is-active' : ''}`}
        title="Pack signatures only (~80% fewer tokens)"
        aria-label={`Toggle skeleton mode for ${node.name}`}
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
        <span className="tree-tokens" title="Approximate tokens (bytes ÷ 3.8)">
          ~{formatTokens(subtree.tokens)} tok
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
                ? `Partially selected folder ${node.name}`
                : `Select folder ${node.name}`
              : `Select file ${node.name}`
          }
        />
      </label>
    </div>
  );
}

export function ShortcutsHelpDialog({ ws }: { ws: WorkspaceState }) {
  const { setShowHelp, setThemePref, showHelp, themePref } = ws;
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
          <h2 id="help-title">Keyboard shortcuts</h2>
          <button
            type="button"
            className="btn btn-ghost btn-icon"
            onClick={() => setShowHelp(false)}
            aria-label="Close"
          >
            <X size={14} />
          </button>
        </div>
        <dl className="help-list">
          <div>
            <dt>
              <span className="kbd">{formatShortcut('O')}</span>
            </dt>
            <dd>Open folder</dd>
          </div>
          <div>
            <dt>
              <span className="kbd">{formatShortcut('R')}</span>
            </dt>
            <dd>Refresh project</dd>
          </div>
          <div>
            <dt>
              <span className="kbd">{formatShortcut('F')}</span>
            </dt>
            <dd>Focus filter</dd>
          </div>
          <div>
            <dt>
              <span className="kbd">{formatShortcut('C')}</span>
            </dt>
            <dd>Copy packed output (or file list)</dd>
          </div>
          <div>
            <dt>
              <span className="kbd">{formatShortcut('S')}</span>
            </dt>
            <dd>Save packed output</dd>
          </div>
          <div>
            <dt>
              <span className="kbd">Esc</span>
            </dt>
            <dd>Clear filter / close dialog</dd>
          </div>
          <div>
            <dt>
              <span className="kbd">?</span>
            </dt>
            <dd>Toggle this help</dd>
          </div>
          <div>
            <dt>
              <span className="kbd">F1</span> / <span className="kbd">{formatShortcut('/')}</span>
            </dt>
            <dd>Documentation & How-To (7 examples)</dd>
          </div>
          <div>
            <dt>
              <span className="kbd">Space</span> / <span className="kbd">Enter</span>
            </dt>
            <dd>Open file preview or expand folder</dd>
          </div>
          <div>
            <dt>
              <span className="kbd">Right-click</span>
            </dt>
            <dd>Open with default app / VS Code / choose program</dd>
          </div>
          <div>
            <dt>
              <span className="kbd">Checkbox</span>
            </dt>
            <dd>Include file in packed LLM output</dd>
          </div>
        </dl>
        <div className="help-theme">
          <span className="help-theme-label">Appearance</span>
          <div className="theme-segment" role="group" aria-label="Color theme">
            {(['light', 'dark', 'system'] as ThemePref[]).map((opt) => (
              <button
                key={opt}
                type="button"
                className={`theme-segment-btn${themePref === opt ? ' is-active' : ''}`}
                onClick={() => setThemePref(opt)}
                aria-pressed={themePref === opt}
              >
                {opt === 'light' ? <Sun size={13} /> : opt === 'dark' ? <Moon size={13} /> : <Monitor size={13} />}
                {themeLabel(opt)}
              </button>
            ))}
          </div>
        </div>
        <p className="help-foot">
          Tip: drop a folder onto the window to open it. Selection presets keep packs small for LLMs.
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
        <FileCode2 size={14} /> Preview in app
      </button>
      <button
        type="button"
        role="menuitem"
        className="ctx-item"
        onClick={() => void openInDefaultApp(contextMenu.path)}
      >
        <ExternalLink size={14} /> Open with default app
      </button>
      <button
        type="button"
        role="menuitem"
        className="ctx-item"
        onClick={() => void openWithApp('code', contextMenu.path)}
      >
        Open with VS Code
      </button>
      <button
        type="button"
        role="menuitem"
        className="ctx-item"
        onClick={() => void openWithApp('notepad++', contextMenu.path)}
      >
        Open with Notepad++
      </button>
      <button
        type="button"
        role="menuitem"
        className="ctx-item"
        onClick={() => void pickAppAndOpen(contextMenu.path)}
      >
        Choose program…
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
        Toggle pack selection
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
        Pack signatures only (Skeleton mode)
      </button>
      <div className="ctx-sep" />
      <button
        type="button"
        role="menuitem"
        className="ctx-item"
        style={{ fontWeight: 600 }}
        onClick={() => void selectRelatedFiles(contextMenu.path, 'all')}
      >
        Select with Related Files (Imports + Tests)
      </button>
      <button
        type="button"
        role="menuitem"
        className="ctx-item"
        onClick={() => void selectRelatedFiles(contextMenu.path, 'imports')}
      >
        Select file + direct imports (1-hop)
      </button>
      <button
        type="button"
        role="menuitem"
        className="ctx-item"
        onClick={() => void selectRelatedFiles(contextMenu.path, 'importers')}
      >
        Select file + importers (who uses this?)
      </button>
      <button
        type="button"
        role="menuitem"
        className="ctx-item"
        onClick={() => void selectRelatedFiles(contextMenu.path, 'tests')}
      >
        Select file + matching tests
      </button>
    </div>
  );
}

