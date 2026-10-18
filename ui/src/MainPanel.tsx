import { Copy, FileCode2, FileText, FolderOpen, List, Loader2, AlertCircle } from 'lucide-react';
import FileViewer from './FileViewer';
import { formatShortcut } from './platform';
import { type OutputFormat, type ListFormat, TOKEN_SOFT, TOKEN_HARD, normalizePath, formatBytes, formatTokens, estimateTokensFromBytes } from './treeModel';
import { CustomProjectsPanel, FolderHistoryPanel, TreeContextMenu, TreeRow } from './Panels';
import type { WorkspaceState } from './useWorkspace';
import { useI18n } from './i18n';

export function MainPanel({ ws }: { ws: WorkspaceState }) {
  const { t, tRich } = useI18n();
  const { ROW_HEIGHT, changeCustomNote, changeFormat, clearCustomDeselect, clearFolderHistory, collapseAll, currentPath, customProjects, expandAll, exportPrefs, exportPromptStudioPack, fileListText, filePreview, fileTokens, fileTree, filterText, focusedPath, folderHistory, format, fullOutputPreview, fullOutputText, generating, handleCopyFileList, handleToggleFullPreview, handleTreeContextMenu, importPrefs, listFormat, nodes, openCustomProject, openFilePreview, openFolder, openHistoryFolder, openInDefaultApp, openWithApp, output, outputBytes, pickAppAndOpen, previewError, previewLoading, previewRelPath, readyBadge, removeCustomProject, removeFolderFromHistory, resizing, scanning, selectedCount, selectedSet, setFilterText, setFocusedPath, setListFormat, setResizing, setShowCustom, setShowHistory, setShowTopConsumers, setTokenSort, setTreeScrollTop, setTreeWidth, setView, showCustom, showHistory, showInitialLoading, showTopConsumers, skeletonSet, startRowIdx, stats, subtreeStats, toggleCustomFavorite, toggleExpand, toggleFolderPin, toggleSelect, toggleSkeleton, tokenSort, totalTreeHeight, treeScrollRef, treeWidth, truncatedPreview, view, virtualSlice, visibleTreeRows } = ws;
  return (
    <>
      {/* Main */}
      <div className="main-content">
        <aside className="tree-panel" style={{ width: treeWidth }} aria-label={t('main.projectFilesAria')}>
          <div className="panel-header">
            <span className="panel-title">{t('main.files')}</span>
            {currentPath && (
              <div className="panel-meta">
                <span title={t('main.itemsTitle')}>
                  {t('main.items', { count: nodes.length })}
                </span>
                <button type="button" className="panel-link" onClick={expandAll}>
                  {t('main.expand')}
                </button>
                <button type="button" className="panel-link" onClick={collapseAll}>
                  {t('main.collapse')}
                </button>
                <button
                  type="button"
                  className="panel-link"
                  aria-pressed={tokenSort}
                  title={t('main.sortTokensTitle')}
                  onClick={() => setTokenSort((v) => !v)}
                >
                  {tokenSort ? t('main.sortTokens') : t('main.sortName')}
                </button>
              </div>
            )}
          </div>

          <div
            ref={treeScrollRef}
            className="file-tree"
            role="tree"
            aria-label={t('main.fileTreeAria')}
            onScroll={(e) => setTreeScrollTop(e.currentTarget.scrollTop)}
          >
            {scanning && !fileTree.children.length ? (
              <div className="loading-center">
                <div className="title">
                  <Loader2 size={18} className="spin icon-accent" /> {t('main.scanning')}
                </div>
                <div className="sub">{t('main.respectingGitignore')}</div>
              </div>
            ) : visibleTreeRows.length > 0 ? (
              <div
                className="tree-virtual-container"
                style={{
                  height: `${totalTreeHeight}px`,
                  paddingTop: `${startRowIdx * ROW_HEIGHT}px`,
                }}
              >
                {virtualSlice.map((row) => (
                  <TreeRow
                    key={row.node.path}
                    row={row}
                    selectedSet={selectedSet}
                    skeletonSet={skeletonSet}
                    filterText={filterText}
                    onToggleExpand={toggleExpand}
                    onToggleSelect={toggleSelect}
                    onToggleSkeleton={toggleSkeleton}
                    onFocusPath={setFocusedPath}
                    onOpenFile={(p) => void openFilePreview(p)}
                    onContextMenu={handleTreeContextMenu}
                    focusedPath={focusedPath}
                    previewPath={previewRelPath}
                    subtreeStats={subtreeStats}
                  />
                ))}
              </div>
            ) : currentPath && filterText ? (
              <div className="empty-state">
                <div className="empty-title">{t('main.noMatches')}</div>
                <div className="empty-desc">
                  {t('main.noMatchesDesc', { filter: filterText })}
                </div>
                <button type="button" className="btn" onClick={() => setFilterText('')}>
                  {t('main.clearFilter')}
                </button>
              </div>
            ) : !currentPath ? (
              <div className="empty-state" data-testid="empty-open-project">
                <div className="empty-icon">
                  <FolderOpen size={26} />
                </div>
                <div className="empty-title">{t('main.openProject')}</div>
                <div className="empty-desc">
                  {tRich('main.openProjectDesc', undefined, {
                    strong: (children, key) => (
                      <strong key={key} className="text-emphasis">
                        {children}
                      </strong>
                    ),
                  })}
                </div>
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => void openFolder()}
                  data-testid="btn-open-folder-empty"
                >
                  <FolderOpen size={15} /> {t('main.openFolder')}
                </button>
                <div className="empty-hints">
                  <span className="hint-chip">
                    <span className="kbd">{formatShortcut('O')}</span> {t('main.hintOpen')}
                  </span>
                  <span className="hint-chip">
                    <span className="kbd">{formatShortcut('F')}</span> {t('main.hintFilter')}
                  </span>
                  <span className="hint-chip">
                    <span className="kbd">{formatShortcut('C')}</span> {t('main.hintCopy')}
                  </span>
                </div>
              </div>
            ) : (
              <div className="empty-state">
                <div className="empty-title">{t('main.emptyProject')}</div>
                <div className="empty-desc">{t('main.emptyProjectDesc')}</div>
              </div>
            )}
          </div>
        </aside>

        <div
          className={`resize-handle${resizing ? ' active' : ''}`}
          onMouseDown={() => setResizing(true)}
          role="separator"
          aria-orientation="vertical"
          aria-label={t('main.resizeAria')}
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === 'ArrowLeft') setTreeWidth((w) => Math.max(220, w - 16));
            if (e.key === 'ArrowRight') setTreeWidth((w) => Math.min(window.innerWidth * 0.55, w + 16));
          }}
        />

        <section className="preview-panel" aria-label={t('main.previewAria')}>
          <div className="preview-header">
            <div className="tabs" role="tablist" aria-label={t('main.previewModeAria')}>
              <button
                type="button"
                role="tab"
                id="tab-packed"
                aria-controls="panel-packed"
                aria-selected={view === 'packed'}
                tabIndex={view === 'packed' ? 0 : -1}
                className={`tab ${view === 'packed' ? 'active' : ''}`}
                onClick={() => setView('packed')}
              >
                <FileText size={14} /> {t('main.tabPacked')}
              </button>
              <button
                type="button"
                role="tab"
                id="tab-list"
                aria-controls="panel-list"
                aria-selected={view === 'list'}
                tabIndex={view === 'list' ? 0 : -1}
                className={`tab ${view === 'list' ? 'active' : ''}`}
                onClick={() => setView('list')}
              >
                <List size={14} /> {t('main.tabList')}
              </button>
              <button
                type="button"
                role="tab"
                id="tab-file"
                aria-controls="panel-file"
                aria-selected={view === 'file'}
                tabIndex={view === 'file' ? 0 : -1}
                className={`tab ${view === 'file' ? 'active' : ''}`}
                onClick={() => setView('file')}
                title={t('main.tabFileTitle')}
              >
                <FileCode2 size={14} /> {t('main.tabFile')}
                {previewRelPath ? (
                  <span className="tab-file-name">
                    {previewRelPath.split(/[/\\]/).pop()}
                  </span>
                ) : null}
              </button>
            </div>

            <div className="preview-actions">
              {view !== 'file' && (
                <>
                  <label className="sr-only" htmlFor="format-select">
                    {t('main.formatLabel')}
                  </label>
                  <select
                    id="format-select"
                    className="select"
                    value={format}
                    onChange={(e) => changeFormat(e.target.value as OutputFormat)}
                  >
                    <option value="xml">XML</option>
                    <option value="markdown">Markdown</option>
                    <option value="json">JSON</option>
                    <option value="plain">{t('main.formatPlain')}</option>
                  </select>
                </>
              )}

              {view === 'list' && (
                <>
                  <label className="sr-only" htmlFor="list-format-select">
                    {t('main.listFormatLabel')}
                  </label>
                  <select
                    id="list-format-select"
                    className="select"
                    value={listFormat}
                    onChange={(e) => setListFormat(e.target.value as ListFormat)}
                  >
                    <option value="tree">{t('main.listTree')}</option>
                    <option value="paths">{t('main.listPaths')}</option>
                  </select>
                </>
              )}

              {view !== 'file' && readyBadge}
            </div>
          </div>

          {showTopConsumers && currentPath && (
            <div className="top-consumers-drawer" data-testid="top-consumers-drawer">
              <div className="top-consumers-header">
                <span>{t('main.topConsumers.title')}</span>
                <button
                  type="button"
                  className="panel-link"
                  onClick={() => setShowTopConsumers(false)}
                >
                  {t('common.close')}
                </button>
              </div>
              <div className="top-consumers-list">
                {nodes
                  .filter((n) => !n.is_dir && n.selected)
                  .map((n) => {
                    const norm = normalizePath(n.path);
                    const ft = fileTokens.find((f) => normalizePath(f.path) === norm);
                    return {
                      path: norm,
                      tokens: ft ? ft.tokens : estimateTokensFromBytes(n.size ?? 0),
                      isSkel: skeletonSet.has(norm),
                    };
                  })
                  .sort((a, b) => b.tokens - a.tokens)
                  .slice(0, 10)
                  .map((item) => (
                    <div key={item.path} className="top-consumer-row">
                      <span className="top-consumer-path" title={item.path}>
                        {item.path}
                      </span>
                      <span className="top-consumer-tokens">
                        {t('tree.tokens', { tokens: formatTokens(item.tokens) })}
                      </span>
                      <button
                        type="button"
                        className={`btn btn-ghost ${item.isSkel ? 'is-active' : ''}`}
                        style={{ height: 22, padding: '0 6px', fontSize: 11 }}
                        onClick={() => toggleSkeleton(item.path, false)}
                      >
                        {item.isSkel ? t('main.topConsumers.full') : t('main.topConsumers.skeletonize')}
                      </button>
                      <button
                        type="button"
                        className="btn btn-ghost"
                        style={{ height: 22, padding: '0 6px', fontSize: 11 }}
                        onClick={() => toggleSelect(item.path, false)}
                      >
                        {t('main.topConsumers.exclude')}
                      </button>
                    </div>
                  ))}
              </div>
            </div>
          )}

          {!generating && output && view === 'packed' && stats.tokens >= TOKEN_SOFT && (
            <div
              className={`token-banner${stats.tokens >= TOKEN_HARD ? ' is-hot' : ''}`}
              role="status"
            >
              <AlertCircle size={13} aria-hidden />
              <span>
                {stats.tokens >= TOKEN_HARD
                  ? t('main.banner.veryLarge', { tokens: formatTokens(stats.tokens) })
                  : t('main.banner.large', { tokens: formatTokens(stats.tokens) })}
              </span>
            </div>
          )}

          <div
            className={`preview-content${generating && output && view === 'packed' ? ' is-updating' : ''}${view === 'file' ? ' is-file-view' : ''}`}
            aria-busy={generating || previewLoading}
            role="tabpanel"
            id={
              view === 'packed'
                ? 'panel-packed'
                : view === 'list'
                  ? 'panel-list'
                  : 'panel-file'
            }
            aria-labelledby={
              view === 'packed'
                ? 'tab-packed'
                : view === 'list'
                  ? 'tab-list'
                  : 'tab-file'
            }
          >
            {showInitialLoading && view !== 'file' ? (
              <div className="loading-center">
                <div className="title">
                  <Loader2 size={18} className="spin icon-accent" />
                  {scanning ? t('main.loading.scanning') : t('main.loading.preparing')}
                </div>
                <div className="sub">
                  {selectedCount > 0
                    ? t('main.loading.selected', { count: selectedCount })
                    : t('main.loading.smartSelection')}
                </div>
              </div>
            ) : view === 'file' ? (
              <FileViewer
                preview={filePreview}
                loading={previewLoading}
                error={previewError}
                onOpenDefault={() => void openInDefaultApp()}
                onOpenWithCode={() => void openWithApp('code')}
                onOpenWithPicker={() => void pickAppAndOpen()}
                onOpenWithCommand={(cmd) => void openWithApp(cmd)}
              />
            ) : view === 'packed' ? (
              output ? (
                <div>
                  {(truncatedPreview || output.length > 150_000) && (
                    <div className="preview-inline-actions">
                      <span>
                        {fullOutputPreview ? t('main.previewFull') : t('main.previewLimited')}
                      </span>
                      <button
                        type="button"
                        className="btn"
                        onClick={() => void handleToggleFullPreview()}
                      >
                        {fullOutputPreview
                          ? t('main.limitPreview')
                          : t('main.showFullPreview', { size: formatBytes(outputBytes) })}
                      </button>
                    </div>
                  )}
                  <pre className="output-text">
                    {fullOutputPreview && fullOutputText !== null
                      ? fullOutputText
                      : output.length > 150_000 && !fullOutputPreview
                        ? output.slice(0, 100_000)
                        : output}
                  </pre>
                </div>
              ) : (
                <div className="empty-state">
                  <div className="empty-icon">
                    <FileText size={24} />
                  </div>
                  <div className="empty-title">{t('main.nothingPacked')}</div>
                  <div className="empty-desc">
                    {tRich('main.nothingPackedDesc', undefined, {
                      strong: (children, key) => (
                        <strong key={key} className="text-strong">
                          {children}
                        </strong>
                      ),
                    })}
                  </div>
                </div>
              )
            ) : (
              <div>
                <pre className="output-text">
                  {fileListText || t('main.noFilesSelected')}
                </pre>
                {fileListText && (
                  <div className="preview-inline-actions">
                    <button
                      type="button"
                      className="btn"
                      onClick={() => void handleCopyFileList()}
                    >
                      <Copy size={14} /> {t('main.copyFileList', { format: listFormat })}
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        </section>
      </div>

      {showHistory && (
        <FolderHistoryPanel
          entries={folderHistory}
          currentPath={currentPath}
          scanning={scanning}
          onClose={() => setShowHistory(false)}
          onOpen={openHistoryFolder}
          onTogglePin={toggleFolderPin}
          onRemove={removeFolderFromHistory}
          onClear={clearFolderHistory}
        />
      )}

      {showCustom && (
        <CustomProjectsPanel
          entries={customProjects}
          currentPath={currentPath}
          scanning={scanning}
          onClose={() => setShowCustom(false)}
          onOpen={openCustomProject}
          onToggleFavorite={toggleCustomFavorite}
          onNoteChange={changeCustomNote}
          onClearDeselect={clearCustomDeselect}
          onRemove={removeCustomProject}
          onExport={exportPrefs}
          onExportPrompts={exportPromptStudioPack}
          onImport={importPrefs}
        />
      )}

      <TreeContextMenu ws={ws} />

    </>
  );
}
