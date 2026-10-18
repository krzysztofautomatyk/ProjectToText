import { useState, type ChangeEvent } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { BookOpen, Copy, FolderOpen, GitBranch, History as HistoryIcon, Info, Languages, List, Loader2, Monitor, Moon, RefreshCw, Save, Search, Shield, SlidersHorizontal, Sparkles, Download, Sun, X } from 'lucide-react';
import APP_VERSION from './version';
import { formatShortcut } from './platform';
import { TOKEN_SOFT, TOKEN_HARD, formatTokens } from './treeModel';
import { ABOUT_REPO_URL, AboutDialog, ImportPrefsDialog, ShortcutsHelpDialog } from './Panels';
import { DocumentationAndHowToModal } from './DocumentationModal';
import { IN_TAURI, type ThemePref, type WorkspaceState } from './useWorkspace';
import { LanguageManagerModal } from './LanguageManagerModal';
import { useI18n } from './i18n';

export function AppHeader({ ws }: { ws: WorkspaceState }) {
  const { t, tRich, locale, locales, setLocale } = useI18n();
  const [showLanguageStudio, setShowLanguageStudio] = useState(false);
  const themeName = (pref: ThemePref) => t(`theme.${pref}`);
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
                title={t('header.versionTitle')}
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
                  ? t('header.update.failedTitle', { error: updateError })
                  : t('header.update.availableTitle', { version: availableUpdate.version })
              }
              data-testid="update-button"
            >
              {updateBusy ? <Loader2 size={14} className="spin" /> : <Download size={14} />}
              <span>
                {updateBusy
                  ? t('header.update.installing')
                  : updateError
                    ? t('header.update.retry')
                    : t('header.update.to', { version: availableUpdate.version })}
              </span>
            </button>
          )}
          <button
            type="button"
            className="btn btn-icon theme-toggle"
            onClick={cycleTheme}
            title={t('header.theme.title', { theme: themeName(themePref), resolved: themeName(resolvedTheme) })}
            aria-label={t('header.theme.aria', { theme: themeName(themePref) })}
          >
            {themePref === 'light' ? (
              <Sun size={15} />
            ) : themePref === 'dark' ? (
              <Moon size={15} />
            ) : (
              <Monitor size={15} />
            )}
          </button>

          <div className="language-switcher">
            <select
              className="select language-switcher-select"
              value={locale}
              onChange={(e) => setLocale(e.target.value)}
              aria-label={t('lang.switcher.aria')}
              title={t('lang.switcher.title', {
                name: locales.find((l) => l.code === locale)?.nativeName ?? locale,
              })}
              data-testid="language-switcher-select"
            >
              {locales
                .filter((l, i) => locales.findIndex((o) => o.code === l.code) === i)
                .map((l) => (
                  <option key={l.code} value={l.code} title={l.nativeName}>
                    {`🌐 ${l.code.toUpperCase()}`}
                  </option>
                ))}
            </select>
            <button
              type="button"
              className="btn btn-icon"
              onClick={() => setShowLanguageStudio(true)}
              title={t('lang.open.title')}
              aria-label={t('lang.open.aria')}
              aria-haspopup="dialog"
              data-testid="open-language-studio-btn"
            >
              <Languages size={15} />
            </button>
          </div>

          <button
            type="button"
            className={`btn history-toggle${showCustom ? ' is-active' : ''}`}
            onClick={() => setShowCustom((visible) => !visible)}
            title={t('header.custom.title')}
            aria-label={t('header.custom.aria')}
            aria-expanded={showCustom}
            data-testid="btn-custom-projects"
          >
            <SlidersHorizontal size={15} />
            <span className="btn-label">{t('header.custom.label')}</span>
            {customProjects.length > 0 && (
              <span className="history-count" aria-label={t('header.custom.count', { count: customProjects.length })}>
                {customProjects.length}
              </span>
            )}
          </button>

          <button
            type="button"
            className={`btn history-toggle${showHistory ? ' is-active' : ''}`}
            onClick={() => setShowHistory((visible) => !visible)}
            title={t('header.history.title')}
            aria-label={t('header.history.aria')}
            aria-expanded={showHistory}
            data-testid="btn-folder-history"
          >
            <HistoryIcon size={15} />
            <span className="btn-label">{t('header.history.label')}</span>
            {folderHistory.length > 0 && (
              <span className="history-count" aria-label={t('header.history.count', { count: folderHistory.length })}>
                {folderHistory.length}
              </span>
            )}
          </button>

          <div className="toolbar-sep" />

          <button
            type="button"
            onClick={() => void openFolder()}
            className="btn"
            title={t('header.open.title', { shortcut: formatShortcut('O') })}
            data-testid="btn-open-folder"
          >
            <FolderOpen size={15} /> {t('header.open.label')}
            <span className="kbd">{formatShortcut('O')}</span>
          </button>

          <button
            type="button"
            onClick={() => currentPath && void scan(currentPath)}
            className="btn"
            disabled={!currentPath || scanning}
            title={t('header.refresh.title', { shortcut: formatShortcut('R') })}
          >
            <RefreshCw size={15} className={scanning ? 'spin' : ''} /> {t('header.refresh.label')}
          </button>

          <button
            type="button"
            onClick={clearCurrentProject}
            className="btn"
            disabled={scanning || (!currentPath && nodes.length === 0 && !output)}
            title={t('header.clear.title')}
            data-testid="btn-clear-project"
          >
            <X size={15} /> {t('header.clear.label')}
          </button>

          <div className="toolbar-sep" />

          <div className="action-cluster" role="group" aria-label={t('header.actions.group')}>
            <button
              type="button"
              onClick={() => void handleCopyFileList()}
              className="btn btn-icon"
              disabled={selectedCount === 0}
              title={t('header.copyList.title')}
              aria-label={t('header.copyList.aria')}
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
                  ? t('header.copy.preparingTitle')
                  : t('header.copy.title', { shortcut: formatShortcut('C') })
              }
            >
              {generating && !output ? (
                <>
                  <Loader2 size={15} className="spin" /> {t('header.copy.preparing')}
                </>
              ) : (
                <>
                  <Copy size={15} />
                  <span className="btn-label">{t('header.copy.label')}</span>
                </>
              )}
            </button>

            <button
              type="button"
              onClick={() => void handleSave()}
              className="btn btn-icon"
              disabled={!output}
              title={t('header.save.title', { shortcut: formatShortcut('S') })}
              aria-label={t('header.save.aria')}
            >
              <Save size={15} />
            </button>
          </div>
        </div>
      </header>

      {browserMode && (
        <div className="browser-mode-banner" role="status" data-testid="browser-mode-banner">
          <Info size={13} aria-hidden />
          <span>{tRich('header.browserBanner')}</span>
        </div>
      )}

      <LanguageManagerModal
        open={showLanguageStudio}
        onClose={() => setShowLanguageStudio(false)}
        pushToast={ws.pushToast}
      />
    </>
  );
}

export function AppToolbar({ ws }: { ws: WorkspaceState }) {
  const { t } = useI18n();
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
            placeholder={t('toolbar.filter.placeholder')}
            value={filterText}
            onChange={(e: ChangeEvent<HTMLInputElement>) => setFilterText(e.target.value)}
            aria-label={t('toolbar.filter.aria')}
          />
          {filterText && (
            <button
              type="button"
              className="search-clear"
              onClick={() => setFilterText('')}
              title={t('toolbar.filter.clearTitle')}
              aria-label={t('toolbar.filter.clearAria')}
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
                ? t('toolbar.selectAll.matchesTitle')
                : t('toolbar.selectAll.title')
            }
          >
            {filterText.trim() ? t('toolbar.selectAll.matches') : t('toolbar.selectAll.label')}
          </button>
          <button
            type="button"
            onClick={deselectAll}
            className="btn btn-ghost"
            disabled={!currentPath || selectedCount === 0}
            title={
              filterText.trim()
                ? t('toolbar.deselect.matchesTitle')
                : t('toolbar.deselect.title')
            }
          >
            {filterText.trim() ? t('toolbar.deselect.matches') : t('toolbar.deselect.label')}
          </button>
        </div>

        <div className="toolbar-sep" />

        <div className="toolbar-group" role="group" aria-label={t('toolbar.presets.group')}>
          <button
            type="button"
            className={`btn btn-ghost ${preset === 'source' ? 'is-active' : ''}`}
            onClick={() => applySelectionPreset('source')}
            disabled={!currentPath}
            title={t('toolbar.preset.source.title')}
          >
            {t('toolbar.preset.source.label')}
          </button>
          <button
            type="button"
            className={`btn btn-ghost ${preset === 'docs' ? 'is-active' : ''}`}
            onClick={() => applySelectionPreset('docs')}
            disabled={!currentPath}
            title={t('toolbar.preset.docs.title')}
          >
            {t('toolbar.preset.docs.label')}
          </button>
          <button
            type="button"
            className={`btn btn-ghost ${preset === 'all' ? 'is-active' : ''}`}
            onClick={() => applySelectionPreset('all')}
            disabled={!currentPath}
            title={t('toolbar.preset.all.title')}
          >
            {t('toolbar.preset.all.label')}
          </button>
          <button
            type="button"
            className={`btn btn-ghost ${preset === 'core_skeleton' ? 'is-active' : ''}`}
            onClick={() => applySelectionPreset('core_skeleton')}
            disabled={!currentPath}
            title={t('toolbar.preset.core.title')}
          >
            {t('toolbar.preset.core.label')}
          </button>
        </div>

        <div className="toolbar-sep" />

        <div className="toolbar-group" role="group" aria-label={t('toolbar.security.group')}>
          <button
            type="button"
            className={`btn btn-ghost ${redactSecretsEnabled ? 'is-active' : ''}`}
            onClick={toggleRedactSecrets}
            aria-pressed={redactSecretsEnabled}
            data-testid="btn-toggle-redact"
            title={
              redactSecretsEnabled
                ? t('toolbar.redact.onTitle')
                : t('toolbar.redact.offTitle')
            }
          >
            <Shield size={13} />
            <span>{t('toolbar.redact.label')}</span>
          </button>
          {redactSecretsEnabled &&
            (redactionSummary.totalRedactions > 0 || redactionSummary.filesScanned != null) && (
            <span
              className="redact-badge"
              data-testid="redaction-badge"
              title={[
                redactionSummary.kinds.map(([k, c]) => `${k}: ${c}`).join(', '),
                redactionSummary.filesScanned != null
                  ? t('toolbar.redact.tooltipScanned', {
                      scanned: redactionSummary.filesScanned,
                      skipped: redactionSummary.filesSkipped ?? 0,
                    })
                  : t('toolbar.redact.tooltipPlain'),
              ]
                .filter(Boolean)
                .join(' ')}
            >
              {t('toolbar.redact.badge', { count: redactionSummary.totalRedactions })}
              {redactionSummary.filesScanned != null &&
                t('toolbar.redact.badgeScanned', {
                  scanned: redactionSummary.filesScanned,
                  skipped: redactionSummary.filesSkipped ?? 0,
                })}
            </span>
          )}
          {!redactSecretsEnabled && currentPath && (
            <span
              className="redact-badge"
              data-testid="redaction-disabled-badge"
              title={t('toolbar.redact.offBadgeTitle')}
            >
              {t('toolbar.redact.offBadge')}
            </span>
          )}

          {gitContext?.isGitRepo && (
            <>
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => selectGitFiles('modified')}
                title={t('toolbar.git.modifiedTitle')}
                data-testid="btn-git-modified"
              >
                <GitBranch size={13} /> {t('toolbar.git.modifiedLabel')}
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
                title={t('toolbar.git.branchTitle')}
                data-testid="btn-git-branch"
              >
                {t('toolbar.git.branchLabel')}
              </button>
              <button
                type="button"
                className={`btn btn-ghost ${includeGitDiff ? 'is-active' : ''}`}
                onClick={toggleIncludeGitDiff}
                aria-pressed={includeGitDiff}
                title={t('toolbar.git.diffTitle')}
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
            title={t('toolbar.promptStudio.title')}
          >
            <Sparkles size={13} /> {t('toolbar.promptStudio.label')}
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
            <RefreshCw size={11} /> {t('toolbar.diskChanged')}
          </button>
        )}

        {currentPath && (
          <span className="meta-inline">
            <span className="count">{selectedCount}</span>
            {' / '}
            {t('toolbar.files', { count: totalFiles })}
            {filterText && filteredTree && (
              <span className="meta-filter">{t('toolbar.filtered')}</span>
            )}
          </span>
        )}
      </div>

    </>
  );
}

export function AppStatusBar({ ws }: { ws: WorkspaceState }) {
  const { t } = useI18n();
  const {
    applyPlaybook,
    currentPath,
    folderName,
    format,
    generating,
    gitContext,
    importPreview,
    pushToast,
    selectedCount,
    setShowAbout,
    setShowDocs,
    setShowHelp,
    showAbout,
    showDocs,
    skeletonSet,
    stats,
    targetBudgetTokens,
  } = ws;
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
            t('status.noFolder')
          )}
        </div>
        <div className="status-right">
          <button
            type="button"
            className="btn footer-docs-btn"
            data-testid="footer-docs-howto-btn"
            aria-haspopup="dialog"
            aria-expanded={showDocs}
            title={t('footer.docsTitle')}
            onClick={() => setShowDocs(true)}
          >
            <BookOpen size={13} aria-hidden />
            <span>{t('footer.docs')}</span>
            <span className="footer-docs-badge" aria-hidden>
              {t('footer.docsBadge')}
            </span>
            <span className="kbd">F1</span>
          </button>
          <span className="sep">|</span>
          <span>
            {t('status.selected')} <span className="status-value">{stats.files}</span>
          </span>
          <span className="sep">|</span>
          {generating ? (
            <span className="status-busy">
              <Loader2 size={11} className="spin" /> {t('status.preparing')}
            </span>
          ) : (
            <span
              title={
                stats.tokens >= TOKEN_HARD
                  ? t('status.tokens.veryLarge')
                  : stats.tokens >= TOKEN_SOFT
                    ? t('status.tokens.large', {
                        hint: stats.tokenizerExact
                          ? t('status.tokens.exactShort')
                          : t('tokens.estimateHint'),
                      })
                    : stats.tokenizerExact
                      ? t('status.tokens.exactFull')
                      : t('tokens.estimateHint')
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
              {t('status.tokensWithKind', {
                kind: stats.tokenizerExact ? t('tokens.kindExact') : t('tokens.kindApprox'),
              })}
            </span>
          )}
          <span className="sep">|</span>
          <span className="status-format">{format}</span>
          <span className="sep">|</span>
          <button
            type="button"
            className="panel-link"
            onClick={() => setShowHelp(true)}
            title={t('status.shortcutsTitle')}
          >
            {t('status.shortcuts')} <span className="kbd">?</span>
          </button>
          <span className="sep">|</span>
          <button
            type="button"
            className="panel-link"
            onClick={() => setShowAbout(true)}
            title={t('status.aboutTitle')}
          >
            {t('status.about')}
          </button>
        </div>
      </footer>

      <ShortcutsHelpDialog ws={ws} />

      <DocumentationAndHowToModal
        open={showDocs}
        onClose={() => setShowDocs(false)}
        onApplyPlaybook={applyPlaybook}
        projectName={folderName || undefined}
        gitBranch={gitContext?.currentBranch ?? undefined}
        selectedFilesCount={selectedCount}
        tokenBudget={targetBudgetTokens}
        skeletonEnabled={skeletonSet.size > 0}
      />

      {importPreview && <ImportPrefsDialog ws={ws} />}

      {showAbout && (
        <AboutDialog
          onClose={() => setShowAbout(false)}
          onOpenRepo={() => {
            if (IN_TAURI) {
              invoke('open_url', { url: ABOUT_REPO_URL }).catch((err) =>
                pushToast('error', t('status.openLinkFailed', { error: String(err) })),
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
