import { Copy, FileCode2, FileText, FolderOpen, List, Loader2, AlertCircle } from 'lucide-react';
import FileViewer from './FileViewer';
import { formatShortcut } from './platform';
import { type OutputFormat, type ListFormat, TOKEN_SOFT, TOKEN_HARD, normalizePath, formatBytes, formatTokens, estimateTokensFromBytes } from './treeModel';
import { CustomProjectsPanel, FolderHistoryPanel, TreeContextMenu, TreeRow } from './Panels';
import type { WorkspaceState } from './useWorkspace';

export function MainPanel({ ws }: { ws: WorkspaceState }) {
  const { ROW_HEIGHT, changeCustomNote, changeFormat, clearCustomDeselect, clearFolderHistory, collapseAll, currentPath, customProjects, expandAll, exportPrefs, exportPromptStudioPack, fileListText, filePreview, fileTokens, fileTree, filterText, focusedPath, folderHistory, format, fullOutputPreview, fullOutputText, generating, handleCopyFileList, handleToggleFullPreview, handleTreeContextMenu, importPrefs, listFormat, nodes, openCustomProject, openFilePreview, openFolder, openHistoryFolder, openInDefaultApp, openWithApp, output, outputBytes, pickAppAndOpen, previewError, previewLoading, previewRelPath, readyBadge, removeCustomProject, removeFolderFromHistory, resizing, scanning, selectedCount, selectedSet, setFilterText, setFocusedPath, setListFormat, setResizing, setShowCustom, setShowHistory, setShowTopConsumers, setTokenSort, setTreeScrollTop, setTreeWidth, setView, showCustom, showHistory, showInitialLoading, showTopConsumers, skeletonSet, startRowIdx, stats, subtreeStats, toggleCustomFavorite, toggleExpand, toggleFolderPin, toggleSelect, toggleSkeleton, tokenSort, totalTreeHeight, treeScrollRef, treeWidth, truncatedPreview, view, virtualSlice, visibleTreeRows } = ws;
  return (
    <>
      {/* Main */}
      <div className="main-content">
        <aside className="tree-panel" style={{ width: treeWidth }} aria-label="Project files">
          <div className="panel-header">
            <span className="panel-title">Files</span>
            {currentPath && (
              <div className="panel-meta">
                <span title="Files and folders after .gitignore">
                  {nodes.length} items
                </span>
                <button type="button" className="panel-link" onClick={expandAll}>
                  Expand
                </button>
                <button type="button" className="panel-link" onClick={collapseAll}>
                  Collapse
                </button>
                <button
                  type="button"
                  className="panel-link"
                  aria-pressed={tokenSort}
                  title="Sort children by estimated token weight"
                  onClick={() => setTokenSort((v) => !v)}
                >
                  {tokenSort ? 'Sort: tokens' : 'Sort: name'}
                </button>
              </div>
            )}
          </div>

          <div
            ref={treeScrollRef}
            className="file-tree"
            role="tree"
            aria-label="File tree"
            onScroll={(e) => setTreeScrollTop(e.currentTarget.scrollTop)}
          >
            {scanning && !fileTree.children.length ? (
              <div className="loading-center">
                <div className="title">
                  <Loader2 size={18} className="spin icon-accent" /> Scanning…
                </div>
                <div className="sub">Respecting .gitignore</div>
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
                <div className="empty-title">No matches</div>
                <div className="empty-desc">
                  Nothing matches “{filterText}”. Try a different filter.
                </div>
                <button type="button" className="btn" onClick={() => setFilterText('')}>
                  Clear filter
                </button>
              </div>
            ) : !currentPath ? (
              <div className="empty-state" data-testid="empty-open-project">
                <div className="empty-icon">
                  <FolderOpen size={26} />
                </div>
                <div className="empty-title">Open a project</div>
                <div className="empty-desc">
                  Drop a folder here or open one. We respect your{' '}
                  <strong className="text-emphasis">.gitignore</strong> exactly
                  like Git.
                </div>
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => void openFolder()}
                  data-testid="btn-open-folder-empty"
                >
                  <FolderOpen size={15} /> Open folder
                </button>
                <div className="empty-hints">
                  <span className="hint-chip">
                    <span className="kbd">{formatShortcut('O')}</span> Open
                  </span>
                  <span className="hint-chip">
                    <span className="kbd">{formatShortcut('F')}</span> Filter
                  </span>
                  <span className="hint-chip">
                    <span className="kbd">{formatShortcut('C')}</span> Copy
                  </span>
                </div>
              </div>
            ) : (
              <div className="empty-state">
                <div className="empty-title">Empty project</div>
                <div className="empty-desc">No files found after applying .gitignore.</div>
              </div>
            )}
          </div>
        </aside>

        <div
          className={`resize-handle${resizing ? ' active' : ''}`}
          onMouseDown={() => setResizing(true)}
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize file panel"
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === 'ArrowLeft') setTreeWidth((w) => Math.max(220, w - 16));
            if (e.key === 'ArrowRight') setTreeWidth((w) => Math.min(window.innerWidth * 0.55, w + 16));
          }}
        />

        <section className="preview-panel" aria-label="Output preview">
          <div className="preview-header">
            <div className="tabs" role="tablist" aria-label="Preview mode">
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
                <FileText size={14} /> Packed output
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
                <List size={14} /> File list
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
                title="In-app file preview with syntax highlighting"
              >
                <FileCode2 size={14} /> File
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
                    Output format
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
                    <option value="plain">Plain</option>
                  </select>
                </>
              )}

              {view === 'list' && (
                <>
                  <label className="sr-only" htmlFor="list-format-select">
                    List format
                  </label>
                  <select
                    id="list-format-select"
                    className="select"
                    value={listFormat}
                    onChange={(e) => setListFormat(e.target.value as ListFormat)}
                  >
                    <option value="tree">Tree</option>
                    <option value="paths">Paths</option>
                  </select>
                </>
              )}

              {view !== 'file' && readyBadge}
            </div>
          </div>

          {showTopConsumers && currentPath && (
            <div className="top-consumers-drawer" data-testid="top-consumers-drawer">
              <div className="top-consumers-header">
                <span>Top Token Consumers (Top 10 Selected Files)</span>
                <button
                  type="button"
                  className="panel-link"
                  onClick={() => setShowTopConsumers(false)}
                >
                  Close
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
                        ~{formatTokens(item.tokens)} tok
                      </span>
                      <button
                        type="button"
                        className={`btn btn-ghost ${item.isSkel ? 'is-active' : ''}`}
                        style={{ height: 22, padding: '0 6px', fontSize: 11 }}
                        onClick={() => toggleSkeleton(item.path, false)}
                      >
                        {item.isSkel ? 'Full' : 'Skeletonize'}
                      </button>
                      <button
                        type="button"
                        className="btn btn-ghost"
                        style={{ height: 22, padding: '0 6px', fontSize: 11 }}
                        onClick={() => toggleSelect(item.path, false)}
                      >
                        Exclude
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
                  ? `Very large pack (~${formatTokens(stats.tokens)} tokens). Many models will truncate this — deselect more files.`
                  : `Large pack (~${formatTokens(stats.tokens)} tokens). May exceed smaller context windows.`}
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
                  {scanning ? 'Scanning project…' : 'Preparing packed output…'}
                </div>
                <div className="sub">
                  {selectedCount > 0
                    ? `${selectedCount} files selected · estimating tokens`
                    : 'Applying smart source selection'}
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
                        {fullOutputPreview
                          ? 'Full preview'
                          : 'Preview limited to 100,000 characters'}
                        . Copy and Save use the complete output.
                      </span>
                      <button
                        type="button"
                        className="btn"
                        onClick={() => void handleToggleFullPreview()}
                      >
                        {fullOutputPreview
                          ? 'Limit preview'
                          : `Show full preview (${formatBytes(outputBytes)})`}
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
                  <div className="empty-title">Nothing packed yet</div>
                  <div className="empty-desc">
                    Select files in the tree (checkbox). Click a file name to{' '}
                    <strong className="text-strong">preview</strong> it.
                    <strong className="text-strong"> Copy packed</strong> is ready
                    for your LLM.
                  </div>
                </div>
              )
            ) : (
              <div>
                <pre className="output-text">
                  {fileListText || 'No files selected.'}
                </pre>
                {fileListText && (
                  <div className="preview-inline-actions">
                    <button
                      type="button"
                      className="btn"
                      onClick={() => void handleCopyFileList()}
                    >
                      <Copy size={14} /> Copy file list ({listFormat})
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
