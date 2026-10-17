import { type ChangeEvent } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Copy, FolderOpen, GitBranch, History as HistoryIcon, Info, List, Loader2, Monitor, Moon, RefreshCw, Save, Search, Shield, SlidersHorizontal, Sparkles, Download, Sun, X } from 'lucide-react';
import APP_VERSION from './version';
import { formatShortcut } from './platform';
import { TOKEN_SOFT, TOKEN_HARD, formatTokens, TOKEN_ESTIMATE_HINT } from './treeModel';
import { ABOUT_REPO_URL, AboutDialog, ShortcutsHelpDialog } from './Panels';
import { IN_TAURI, themeLabel, type WorkspaceState } from './useWorkspace';

export function AppHeader({ ws }: { ws: WorkspaceState }) {
  const { availableUpdate, browserMode, clearCurrentProject, currentPath, customProjects, cycleTheme, folderHistory, generating, handleCopy, handleCopyFileList, handleSave, installUpdate, nodes, openFolder, output, resolvedTheme, scan, scanning, selectedCount, setShowCustom, setShowHistory, showCustom, showHistory, themePref, updateBusy, updateError } = ws;
  return (
    <>
      {/* Header */}
      <header className="header" data-testid="app-header">
        <div className="header-left">
          <div className="brand" title="ProjectToText" data-testid="brand">
            <div className="brand-mark" aria-hidden>
              ptt
            </div>
            <div className="brand-text">
              <span className="brand-name">ProjectToText</span>
              <span
                className="brand-version"
                title="Application version"
                data-testid="app-version"
              >
                v{APP_VERSION}
              </span>
            </div>
          </div>

          {currentPath && (
            <div className="path-chip" title={currentPath}>
              <FolderOpen size={12} className="icon-muted" aria-hidden />
              <span>{currentPath}</span>
            </div>
          )}
        </div>

        <div className="header-right">
          {availableUpdate && (
            <button
              type="button"
              className="btn btn-primary update-button"
              onClick={installUpdate}
              disabled={updateBusy}
              title={
                updateError
                  ? `Update failed: ${updateError}. Click to retry.`
                  : `Version ${availableUpdate.version} is available. Click to install and restart.`
              }
              data-testid="update-button"
            >
              {updateBusy ? <Loader2 size={14} className="spin" /> : <Download size={14} />}
              <span>
                {updateBusy
                  ? 'Installing…'
                  : updateError
                    ? 'Update failed, retry'
                    : `Update to v${availableUpdate.version}`}
              </span>
            </button>
          )}
          <button
            type="button"
            className="btn btn-icon theme-toggle"
            onClick={cycleTheme}
            title={`Theme: ${themeLabel(themePref)} (${resolvedTheme}). Click to cycle Light → Dark → System`}
            aria-label={`Theme ${themeLabel(themePref)}. Click to change.`}
          >
            {themePref === 'light' ? (
              <Sun size={15} />
            ) : themePref === 'dark' ? (
              <Moon size={15} />
            ) : (
              <Monitor size={15} />
            )}
          </button>

          <button
            type="button"
            className={`btn history-toggle${showCustom ? ' is-active' : ''}`}
            onClick={() => setShowCustom((visible) => !visible)}
            title="Custom projects — saved exclusions, favorites, notes"
            aria-label="Open custom projects"
            aria-expanded={showCustom}
            data-testid="btn-custom-projects"
          >
            <SlidersHorizontal size={15} />
            <span className="btn-label">Custom</span>
            {customProjects.length > 0 && (
              <span className="history-count" aria-label={`${customProjects.length} custom projects`}>
                {customProjects.length}
              </span>
            )}
          </button>

          <button
            type="button"
            className={`btn history-toggle${showHistory ? ' is-active' : ''}`}
            onClick={() => setShowHistory((visible) => !visible)}
            title="Open folder history"
            aria-label="Open folder history"
            aria-expanded={showHistory}
            data-testid="btn-folder-history"
          >
            <HistoryIcon size={15} />
            <span className="btn-label">History</span>
            {folderHistory.length > 0 && (
              <span className="history-count" aria-label={`${folderHistory.length} folders`}>
                {folderHistory.length}
              </span>
            )}
          </button>

          <div className="toolbar-sep" />

          <button
            type="button"
            onClick={() => void openFolder()}
            className="btn"
            title={`Open folder (${formatShortcut('O')})`}
            data-testid="btn-open-folder"
          >
            <FolderOpen size={15} /> Open
            <span className="kbd">{formatShortcut('O')}</span>
          </button>

          <button
            type="button"
            onClick={() => currentPath && void scan(currentPath)}
            className="btn"
            disabled={!currentPath || scanning}
            title={`Refresh (${formatShortcut('R')})`}
          >
            <RefreshCw size={15} className={scanning ? 'spin' : ''} /> Refresh
          </button>

          <button
            type="button"
            onClick={clearCurrentProject}
            className="btn"
            disabled={scanning || (!currentPath && nodes.length === 0 && !output)}
            title="Clear current project and choose another folder"
            data-testid="btn-clear-project"
          >
            <X size={15} /> Clear
          </button>

          <div className="toolbar-sep" />

          <div className="action-cluster" role="group" aria-label="Output actions">
            <button
              type="button"
              onClick={() => void handleCopyFileList()}
              className="btn btn-icon"
              disabled={selectedCount === 0}
              title="Copy selected files as tree or paths"
              aria-label="Copy file list"
            >
              <List size={15} />
            </button>

            <button
              type="button"
              onClick={() => void handleCopy()}
              className={`btn ${output ? 'btn-primary' : ''}`}
              disabled={!output}
              title={
                generating && !output
                  ? 'Preparing packed output…'
                  : `Copy packed content (${formatShortcut('C')})`
              }
            >
              {generating && !output ? (
                <>
                  <Loader2 size={15} className="spin" /> Preparing…
                </>
              ) : (
                <>
                  <Copy size={15} />
                  <span className="btn-label">Copy packed</span>
                </>
              )}
            </button>

            <button
              type="button"
              onClick={() => void handleSave()}
              className="btn btn-icon"
              disabled={!output}
              title={`Save (${formatShortcut('S')})`}
              aria-label="Save packed output"
            >
              <Save size={15} />
            </button>
          </div>
        </div>
      </header>

      {browserMode && (
        <div className="browser-mode-banner" role="status" data-testid="browser-mode-banner">
          <Info size={13} aria-hidden />
          <span>
            <strong>Browser mode</strong> — evaluates in-folder <code>.gitignore</code> and{' '}
            <code>.pttignore</code> rules, caps packs at 400 files, and uses approximate token
            estimates (<code>chars ÷ 3.8</code>). It does not run Git (tracked-file state, global
            ignores, or <code>git diff</code>) or native editor launchers; run{' '}
            <code>cargo tauri dev</code> or <code>ptt pack</code> when full Git/BPE fidelity is
            required.
          </span>
        </div>
      )}

    </>
  );
}

export function AppToolbar({ ws }: { ws: WorkspaceState }) {
  const { applySelectionPreset, currentPath, deselectAll, filterRef, filterText, filteredTree, gitContext, includeGitDiff, preset, redactSecretsEnabled, redactionSummary, scan, selectAll, selectGitFiles, selectedCount, setFilterText, setShowPromptStudio, showPromptStudio, toggleIncludeGitDiff, toggleRedactSecrets, totalFiles, workspaceChangedOnDisk } = ws;
  return (
    <>
      {/* Toolbar */}
      <div className="toolbar">
        <div className="search-field">
          <Search size={13} className="search-icon" aria-hidden />
          <input
            ref={filterRef}
            type="search"
            placeholder="Filter files…"
            value={filterText}
            onChange={(e: ChangeEvent<HTMLInputElement>) => setFilterText(e.target.value)}
            aria-label="Filter files"
          />
          {filterText && (
            <button
              type="button"
              className="search-clear"
              onClick={() => setFilterText('')}
              title="Clear filter (Esc)"
              aria-label="Clear filter"
            >
              <X size={12} />
            </button>
          )}
        </div>

        <div className="toolbar-group">
          <button
            type="button"
            onClick={selectAll}
            className="btn btn-ghost"
            disabled={!currentPath}
            title={
              filterText.trim()
                ? 'Select all files matching the current filter'
                : 'Select all files'
            }
          >
            {filterText.trim() ? 'Select matches' : 'Select all'}
          </button>
          <button
            type="button"
            onClick={deselectAll}
            className="btn btn-ghost"
            disabled={!currentPath || selectedCount === 0}
            title={
              filterText.trim()
                ? 'Deselect files matching the current filter'
                : 'Deselect all files'
            }
          >
            {filterText.trim() ? 'Deselect matches' : 'Deselect'}
          </button>
        </div>

        <div className="toolbar-sep" />

        <div className="toolbar-group" role="group" aria-label="Selection presets">
          <button
            type="button"
            className={`btn btn-ghost ${preset === 'source' ? 'is-active' : ''}`}
            onClick={() => applySelectionPreset('source')}
            disabled={!currentPath}
            title="Select source code & config files only"
          >
            Source
          </button>
          <button
            type="button"
            className={`btn btn-ghost ${preset === 'docs' ? 'is-active' : ''}`}
            onClick={() => applySelectionPreset('docs')}
            disabled={!currentPath}
            title="Source + documentation"
          >
            + Docs
          </button>
          <button
            type="button"
            className={`btn btn-ghost ${preset === 'all' ? 'is-active' : ''}`}
            onClick={() => applySelectionPreset('all')}
            disabled={!currentPath}
            title="All files except common junk (node_modules, dist, target…)"
          >
            All clean
          </button>
          <button
            type="button"
            className={`btn btn-ghost ${preset === 'core_skeleton' ? 'is-active' : ''}`}
            onClick={() => applySelectionPreset('core_skeleton')}
            disabled={!currentPath}
            title="Core files full + tests/docs as AST skeletons"
          >
            Core Full + Rest Skeleton
          </button>
        </div>

        <div className="toolbar-sep" />

        <div className="toolbar-group" role="group" aria-label="Security and Git">
          <button
            type="button"
            className={`btn btn-ghost ${redactSecretsEnabled ? 'is-active' : ''}`}
            onClick={toggleRedactSecrets}
            aria-pressed={redactSecretsEnabled}
            data-testid="btn-toggle-redact"
            title={
              redactSecretsEnabled
                ? 'Secret redaction is ON (click to disable)'
                : 'Secret redaction is OFF (click to enable)'
            }
          >
            <Shield size={13} />
            <span>Redact</span>
          </button>
          {redactSecretsEnabled &&
            (redactionSummary.totalRedactions > 0 || redactionSummary.filesScanned != null) && (
            <span
              className="redact-badge"
              data-testid="redaction-badge"
              title={[
                redactionSummary.kinds.map(([k, c]) => `${k}: ${c}`).join(', '),
                redactionSummary.filesScanned != null
                  ? `(${redactionSummary.filesScanned} scanned, ${redactionSummary.filesSkipped ?? 0} skipped — pattern-based only; custom secret formats may remain)`
                  : 'Pattern-based masking only; custom secret formats may remain',
              ]
                .filter(Boolean)
                .join(' ')}
            >
              🛡️ {redactionSummary.totalRedactions} secrets masked
              {redactionSummary.filesScanned != null && (
                <> · {redactionSummary.filesScanned} scanned · {redactionSummary.filesSkipped ?? 0} skipped</>
              )}
            </span>
          )}
          {!redactSecretsEnabled && currentPath && (
            <span
              className="redact-badge"
              data-testid="redaction-disabled-badge"
              title="Secret masking is turned OFF. Credentials in selected files or diffs will be exported unmasked."
            >
              ⚠️ Redaction OFF
            </span>
          )}

          {gitContext?.isGitRepo && (
            <>
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => selectGitFiles('modified')}
                title="Select Git modified, staged, and untracked files"
                data-testid="btn-git-modified"
              >
                <GitBranch size={13} /> Select Git Modified
                {gitContext.modifiedFiles.length > 0 && (
                  <span className="history-count">
                    {gitContext.modifiedFiles.length}
                  </span>
                )}
              </button>
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => selectGitFiles('branch')}
                title="Select files changed on current branch vs base branch"
                data-testid="btn-git-branch"
              >
                Select Branch Changes
              </button>
              <button
                type="button"
                className={`btn btn-ghost ${includeGitDiff ? 'is-active' : ''}`}
                onClick={toggleIncludeGitDiff}
                aria-pressed={includeGitDiff}
                title="Include unified <git_diff> block in packed output"
                data-testid="btn-include-git-diff"
              >
                + &lt;git_diff&gt;
              </button>
            </>
          )}

          <button
            type="button"
            className={`btn btn-ghost ${showPromptStudio ? 'is-active' : ''}`}
            onClick={() => setShowPromptStudio((v) => !v)}
            aria-expanded={showPromptStudio}
            data-testid="btn-prompt-studio"
            title="Prompt Studio — append <task_instructions> at the end of the pack"
          >
            <Sparkles size={13} /> Prompt Studio
          </button>
        </div>

        <div className="toolbar-spacer" />

        {workspaceChangedOnDisk && currentPath && (
          <button
            type="button"
            className="disk-changed-pill"
            onClick={() => void scan(currentPath)}
            data-testid="disk-changed-pill"
          >
            <RefreshCw size={11} /> Files changed on disk — Refresh
          </button>
        )}

        {currentPath && (
          <span className="meta-inline">
            <span className="count">{selectedCount}</span>
            {' / '}
            {totalFiles} files
            {filterText && filteredTree && (
              <span className="meta-filter">· filtered</span>
            )}
          </span>
        )}
      </div>

    </>
  );
}

export function AppStatusBar({ ws }: { ws: WorkspaceState }) {
  const { currentPath, folderName, format, generating, pushToast, setShowAbout, setShowHelp, showAbout, stats } = ws;
  return (
    <>
      {/* Status bar */}
      <footer className="status-bar">
        <div className="status-left" title={currentPath || undefined}>
          {currentPath ? (
            <>
              <span className="status-folder">{folderName}</span>
              <span className="status-dot"> · </span>
              {currentPath}
            </>
          ) : (
            'No folder opened — drop a project or press Open'
          )}
        </div>
        <div className="status-right">
          <span>
            Selected: <span className="status-value">{stats.files}</span>
          </span>
          <span className="sep">|</span>
          {generating ? (
            <span className="status-busy">
              <Loader2 size={11} className="spin" /> preparing…
            </span>
          ) : (
            <span
              title={
                stats.tokens >= TOKEN_HARD
                  ? 'Very large context — consider deselecting files'
                  : stats.tokens >= TOKEN_SOFT
                    ? `Large pack — may exceed smaller model windows. ${stats.tokenizerExact ? 'Exact BPE count (o200k_base).' : TOKEN_ESTIMATE_HINT}`
                    : stats.tokenizerExact
                      ? 'Exact BPE token count (o200k_base) on complete serialized artifact.'
                      : TOKEN_ESTIMATE_HINT
              }
            >
              {stats.tokenizerExact ? '' : '~'}
              <span
                className={[
                  'status-value accent',
                  stats.tokens >= TOKEN_HARD
                    ? 'token-hot'
                    : stats.tokens >= TOKEN_SOFT
                      ? 'token-warm'
                      : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
              >
                {formatTokens(stats.tokens)}
              </span>{' '}
              tokens ({stats.tokenizerExact ? 'exact' : 'approx'})
            </span>
          )}
          <span className="sep">|</span>
          <span className="status-format">{format}</span>
          <span className="sep">|</span>
          <button
            type="button"
            className="panel-link"
            onClick={() => setShowHelp(true)}
            title="Keyboard shortcuts (?)"
          >
            Shortcuts <span className="kbd">?</span>
          </button>
          <span className="sep">|</span>
          <button
            type="button"
            className="panel-link"
            onClick={() => setShowAbout(true)}
            title="About ptt"
          >
            About
          </button>
        </div>
      </footer>

      <ShortcutsHelpDialog ws={ws} />

      {showAbout && (
        <AboutDialog
          onClose={() => setShowAbout(false)}
          onOpenRepo={() => {
            if (IN_TAURI) {
              invoke('open_url', { url: ABOUT_REPO_URL }).catch((err) =>
                pushToast('error', `Could not open link: ${String(err)}`),
              );
            } else {
              window.open(ABOUT_REPO_URL, '_blank', 'noopener,noreferrer');
            }
          }}
        />
      )}

    </>
  );
}
