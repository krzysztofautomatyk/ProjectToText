import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { check, type Update } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { Check, Loader2 } from 'lucide-react';
import { CANONICAL_JUNK_DIRS, downloadText, isCancelledError, pickDirectoryWithInput, pickDirectoryWithPicker, scanDirectoryHandle, scanFileList, UserCancelledError, type BrowserProject } from './browserFs';
import { readFolderHistory, rememberFolder, removeFolder, setFolderPinned, writeFolderHistory, type FolderHistoryEntry } from './folderHistory';
import { projectPrefKey, readProjectPrefs, rememberProject, removeProject, setProjectFavorite, setProjectNote, writeProjectPrefs, type ProjectPref } from './projectPrefs';
import { buildPrefSnapshot, mergePrefSnapshot, parsePrefSnapshot, snapshotFileName } from './prefTransfer';
import { isTauriRuntime } from './tauriEnv';
import { isModKey } from './platform';
import { type FileNode, type GitRepoContext, type ScanResult, type OutputFormat, type ViewMode, type ListFormat, type SelectionPreset, type ToastKind, type BudgetPreset, BUDGET_LIMITS, type ToastItem, normalizePath, applySavedDeselects, formatTokens, TOKEN_ESTIMATE_HINT, isLowPriorityPath, applyPreset, generateFileList, generatePathsList, readStoredFormat, tokenBadgeClass } from './treeModel';
import { useThemeAndLayout } from './useThemeAndLayout';
import { useGeneration } from './useGeneration';
import { useSelection } from './useSelection';
import { useFilePreviewAndMenu } from './useFilePreviewAndMenu';

export const IN_TAURI = isTauriRuntime();

export { readThemePref, resolveTheme, themeLabel, type ThemePref } from './useThemeAndLayout';

export function useWorkspace() {
  const [currentPath, setCurrentPath] = useState('');
  const [nodes, setNodes] = useState<FileNode[]>([]);
  const [format, setFormat] = useState<OutputFormat>(() => readStoredFormat());
  const [scanning, setScanning] = useState(false);
  const [view, setView] = useState<ViewMode>('packed');
  const [listFormat, setListFormat] = useState<ListFormat>('tree');
  const [tokenSort, setTokenSort] = useState(false);
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [focusedPath, setFocusedPath] = useState<string | null>(null);
  const [showHelp, setShowHelp] = useState(false);
  const [showAbout, setShowAbout] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [folderHistory, setFolderHistory] = useState<FolderHistoryEntry[]>(() =>
    IN_TAURI ? readFolderHistory() : [],
  );
  const [showCustom, setShowCustom] = useState(false);
  const [customProjects, setCustomProjects] = useState<ProjectPref[]>(readProjectPrefs);
  const filterRef = useRef<HTMLInputElement>(null);
  const toastId = useRef(0);
  /** Browser-mode project (files in memory). Null in Tauri desktop mode. */
  const browserProjectRef = useRef<BrowserProject | null>(null);
  const workspaceRevision = useRef(0);
  const scanSeq = useRef(0);
  const startupRequested = useRef(false);
  const [budgetPreset, setBudgetPreset] = useState<BudgetPreset>('128k');
  const [customBudget, setCustomBudget] = useState(128_000);
  const [showTopConsumers, setShowTopConsumers] = useState(false);
  const [junkDirs, setJunkDirs] = useState<readonly string[]>(CANONICAL_JUNK_DIRS);
  const [gitContext, setGitContext] = useState<GitRepoContext | null>(null);
  const [showPromptStudio, setShowPromptStudio] = useState(false);
  const [promptTemplateId, setPromptTemplateId] = useState('none');
  const [taskPrompt, setTaskPrompt] = useState('');
  const [workspaceChangedOnDisk, setWorkspaceChangedOnDisk] = useState(false);
  const refreshTimer = useRef<number | null>(null);
  const refreshFromDiskRef = useRef<() => void>(() => {});
  const [browserMode, setBrowserMode] = useState(!IN_TAURI);
  /** Newer release found by the Tauri updater (desktop builds only). */
  const [availableUpdate, setAvailableUpdate] = useState<Update | null>(null);
  const [updateBusy, setUpdateBusy] = useState(false);
  const [updateError, setUpdateError] = useState<string | null>(null);

  useEffect(() => {
    if (!IN_TAURI) return;
    let unlisten: (() => void) | undefined;
    listen<string>('workspace-changed', () => {
      setWorkspaceChangedOnDisk(true);
      // Debounced: a burst of watcher events triggers one refresh, after the files settle.
      if (refreshTimer.current != null) window.clearTimeout(refreshTimer.current);
      refreshTimer.current = window.setTimeout(() => {
        refreshTimer.current = null;
        refreshFromDiskRef.current();
      }, 800);
    })
      .then((fn) => {
        unlisten = fn;
      })
      .catch(() => {
        /* ignore in mock/test environments */
      });
    return () => {
      unlisten?.();
      if (refreshTimer.current != null) window.clearTimeout(refreshTimer.current);
    };
  }, []);

  useEffect(() => {
    // Silent startup check. Skipped in dev, where no signed latest.json exists.
    if (!IN_TAURI || import.meta.env.DEV) return;
    check()
      .then((update) => setAvailableUpdate(update))
      .catch((err) => console.warn('Update check failed:', err));
  }, []);

  const installUpdate = async () => {
    if (!availableUpdate || updateBusy) return;
    setUpdateBusy(true);
    setUpdateError(null);
    try {
      await availableUpdate.downloadAndInstall();
      await relaunch();
    } catch (err) {
      console.error('Update install failed:', err);
      setUpdateError(String(err));
      setUpdateBusy(false);
    }
  };


  const targetBudgetTokens =
    budgetPreset === 'custom' ? Math.max(1000, customBudget) : BUDGET_LIMITS[budgetPreset];


  /* ─── Toasts ───────────────────────────────────────── */

  const pushToast = useCallback((kind: ToastKind, message: string) => {
    const id = ++toastId.current;
    setToasts((prev) => [...prev.slice(-3), { id, kind, message }]);
    window.setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 2200);
  }, []);

  const dismissToast = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);


  const { themePref, setThemePref, resolvedTheme, cycleTheme, treeWidth, setTreeWidth, resizing, setResizing, treeScrollTop, setTreeScrollTop, treeViewportHeight, treeScrollRef } = useThemeAndLayout({ currentPath, pushToast });
  const { output, setOutput, generating, setGenerating, stats, setStats, fullOutputPreview, fullOutputText, setFullOutputText, truncatedPreview, setTruncatedPreview, totalBytes, setTotalBytes, redactSecretsEnabled, setRedactSecretsEnabled, redactionSummary, setRedactionSummary, skeletonSet, setSkeletonSet, fileTokens, setFileTokens, includeGitDiff, setIncludeGitDiff, genSeq, hasLoadedOnce, generateTimer, generate, generateNow, handleToggleFullPreview, handleCopy, handleSave } = useGeneration({ currentPath, nodes, format, taskPrompt, pushToast, browserProjectRef, workspaceRevision });
  const { filterText, setFilterText, expanded, setExpanded, preset, setPreset, selectedSet, selectedCount, fileTree, filteredTree, subtreeStats, visibleTreeRows, toggleSelect, selectAll, deselectAll, applySelectionPreset, toggleSkeleton, toggleRedactSecrets, toggleIncludeGitDiff, selectGitFiles, autoFitToBudget, clearCustomDeselect, toggleExpand, expandAll, collapseAll, changeFormat } = useSelection({ currentPath, nodes, setNodes, format, setFormat, tokenSort, gitContext, junkDirs, customProjects, setCustomProjects, targetBudgetTokens, stats, fileTokens, skeletonSet, setSkeletonSet, setRedactSecretsEnabled, setIncludeGitDiff, setOutput, setStats, setGenerating, genSeq, generateTimer, generate, pushToast });
  const { filePreview, previewLoading, previewError, previewRelPath, contextMenu, setContextMenu, openFilePreview, openInDefaultApp, openWithApp, pickAppAndOpen, handleTreeContextMenu, selectRelatedFiles, setFilePreview, setPreviewRelPath, setPreviewError } = useFilePreviewAndMenu({ currentPath, nodes, format, browserProjectRef, setView, setFocusedPath, setNodes, pushToast, generate, workspaceRevision });

  const ROW_HEIGHT = 28;
  const OVERSCAN = 15;
  const totalTreeHeight = visibleTreeRows.length * ROW_HEIGHT;
  const startRowIdx = Math.max(0, Math.floor(treeScrollTop / ROW_HEIGHT) - OVERSCAN);
  const endRowIdx = Math.min(
    visibleTreeRows.length,
    Math.ceil((treeScrollTop + treeViewportHeight) / ROW_HEIGHT) + OVERSCAN,
  );
  const virtualSlice = visibleTreeRows.slice(startRowIdx, endRowIdx);

  const fileListText = useMemo(
    () => (listFormat === 'tree' ? generateFileList(nodes) : generatePathsList(nodes)),
    [nodes, listFormat],
  );

  const totalFiles = useMemo(() => nodes.filter((n) => !n.is_dir).length, [nodes]);

  const outputBytes = useMemo(
    () => (totalBytes > 0 ? totalBytes : new Blob([output]).size),
    [totalBytes, output],
  );

  const rememberLoadedFolder = useCallback((path: string) => {
    setFolderHistory((prev) => rememberFolder(prev, path));
    setCustomProjects((prev) => rememberProject(prev, path));
  }, []);

  const toggleFolderPin = useCallback((entry: FolderHistoryEntry) => {
    setFolderHistory((prev) => setFolderPinned(prev, entry.path, !entry.pinned));
  }, []);

  const removeFolderFromHistory = useCallback((entry: FolderHistoryEntry) => {
    setFolderHistory((prev) => removeFolder(prev, entry.path));
  }, []);

  const clearFolderHistory = useCallback(() => {
    setFolderHistory([]);
  }, []);

  const toggleCustomFavorite = useCallback((entry: ProjectPref) => {
    setCustomProjects((prev) => setProjectFavorite(prev, entry.path, !entry.favorite));
  }, []);

  const changeCustomNote = useCallback((entry: ProjectPref, note: string) => {
    setCustomProjects((prev) => setProjectNote(prev, entry.path, note));
  }, []);

  const removeCustomProject = useCallback((entry: ProjectPref) => {
    setCustomProjects((prev) => removeProject(prev, entry.path));
  }, []);

  /* ─── Preferences export / import ──────────────────── */

  const exportPrefs = useCallback(() => {
    const snapshot = buildPrefSnapshot(customProjects, folderHistory);
    const text = JSON.stringify(snapshot, null, 2);
    downloadText(snapshotFileName(), text);
    pushToast(
      'success',
      `Exported ${customProjects.length} projects · ${folderHistory.length} history entries`,
    );
  }, [customProjects, folderHistory, pushToast]);

  const importPrefs = useCallback(async () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json,.json';
    input.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0;';
    document.body.appendChild(input);
    const pick = new Promise<File | null>((resolve) => {
      input.addEventListener('change', () => resolve(input.files?.[0] ?? null));
      window.addEventListener(
        'focus',
        () => setTimeout(() => resolve(input.files?.[0] ?? null), 600),
        { once: true },
      );
    });
    input.click();
    const file = await pick;
    input.remove();
    if (!file) return;

    try {
      const snapshot = parsePrefSnapshot(await file.text());
      const result = mergePrefSnapshot(
        snapshot,
        customProjects,
        folderHistory,
      );
      setCustomProjects(result.projects);
      setFolderHistory(result.history);
      pushToast(
        'success',
        `Imported ${result.projectsImported} projects · ${result.historyImported} history entries` +
          (result.skipped > 0 ? ` (${result.skipped} invalid skipped)` : ''),
      );
    } catch (e) {
      pushToast('error', e instanceof Error ? e.message : 'Import failed');
    }
  }, [customProjects, folderHistory, pushToast]);

  const clearCurrentProject = useCallback(() => {
    if (!currentPath && nodes.length === 0 && !output) return;
    if (generateTimer.current != null) {
      window.clearTimeout(generateTimer.current);
      generateTimer.current = null;
    }
    genSeq.current += 1;
    scanSeq.current += 1;
    workspaceRevision.current = 0;
    browserProjectRef.current = null;
    hasLoadedOnce.current = false;
    setCurrentPath('');
    setNodes([]);
    setOutput('');
    setFullOutputText(null);
    setTruncatedPreview(false);
    setTotalBytes(0);
    setRedactionSummary({ totalRedactions: 0, kinds: [] });
    setSkeletonSet(new Set());
    setFileTokens([]);
    setGitContext(null);
    setIncludeGitDiff(false);
    setWorkspaceChangedOnDisk(false);
    setStats({ files: 0, tokens: 0 });
    setScanning(false);
    setGenerating(false);
    setBrowserMode(!IN_TAURI);
    setFilterText('');
    setExpanded(new Set());
    setPreset('source');
    setView('packed');
    setFilePreview(null);
    setPreviewRelPath(null);
    setPreviewError(null);
    setContextMenu(null);
    setFocusedPath(null);
    setShowHistory(false);
    pushToast('info', 'Project cleared — choose another folder');
  }, [currentPath, nodes.length, output, pushToast]);


  const applyScanResult = useCallback(
    async (
      result: FileNode[],
      pathLabel: string,
      nextPreset: SelectionPreset,
      fromBrowser: boolean,
      preserve?: { selected: Set<string>; skeletons: Set<string> },
    ) => {
      const withBase = applyPreset(result, nextPreset, junkDirs);
      // Apply saved per-project deselects (files user unchecked previously)
      const saved = customProjects.find(
        (p) => projectPrefKey(p.path) === projectPrefKey(pathLabel),
      );
      // A refresh keeps the selection the user had, instead of the preset and saved deselects.
      const withSelection = preserve
        ? withBase.map((n) => (n.is_dir ? n : { ...n, selected: preserve.selected.has(n.path) }))
        : applySavedDeselects(withBase, saved?.deselectPaths ?? []);
      const nextSkels = new Set<string>();
      if (preserve) {
        for (const n of withSelection) {
          const key = normalizePath(n.path);
          if (!n.is_dir && preserve.skeletons.has(key)) nextSkels.add(key);
        }
      } else if (nextPreset === 'core_skeleton') {
        for (const n of withSelection) {
          if (!n.is_dir && n.selected && isLowPriorityPath(n.path)) {
            nextSkels.add(normalizePath(n.path));
          }
        }
      }
      setSkeletonSet(nextSkels);
      setNodes(withSelection);
      setCurrentPath(pathLabel);
      setBrowserMode(fromBrowser);
      setFilterText('');
      setFilePreview(null);
      setPreviewRelPath(null);
      setPreviewError(null);
      setContextMenu(null);
      hasLoadedOnce.current = false;
      if (!fromBrowser) rememberLoadedFolder(pathLabel);

      const topDirs = withSelection
        .filter((n) => n.is_dir && !n.path.includes('/'))
        .map((n) => n.path);
      const rootName = pathLabel.split(/[/\\]/).filter(Boolean).pop() ?? '';
      const firstLevel = withSelection
        .filter((n) => {
          if (!n.is_dir) return false;
          const parts = n.path.split(/[/\\]/).filter(Boolean);
          return parts.length <= 2 || n.path.endsWith(rootName);
        })
        .map((n) => n.path)
        .slice(0, 40);

      setExpanded(new Set([...topDirs, ...firstLevel].slice(0, 50)));

      const fileCount = withSelection.filter((n) => !n.is_dir).length;
      const selectedCountLocal = withSelection.filter((n) => n.selected && !n.is_dir).length;

      if (fileCount === 0) {
        setOutput('');
        setStats({ files: 0, tokens: 0 });
        setGenerating(false);
        pushToast(
          'info',
          'Folder opened but no files found (empty or only ignored folders like node_modules/bin/obj).',
        );
        return;
      }

      pushToast(
        'success',
        `Loaded ${fileCount} files · ${selectedCountLocal} selected (${nextPreset})`,
      );

      // Pack after tree is visible
      await generateNow(withSelection, pathLabel, format, { skeletons: nextSkels });
    },
    [format, generateNow, pushToast, rememberLoadedFolder, customProjects, junkDirs],
  );

  const scan = useCallback(
    async (
      path: string,
      nextPreset: SelectionPreset = preset,
      preserve?: { selected: Set<string>; skeletons: Set<string> },
    ) => {
      if (!IN_TAURI || browserProjectRef.current) {
        pushToast(
          'info',
          'In browser mode use Open to pick the folder again (native path refresh needs the desktop app).',
        );
        return;
      }
      const sequence = ++scanSeq.current;
      ++genSeq.current;
      if (generateTimer.current != null) window.clearTimeout(generateTimer.current);
      setScanning(true);
      setGenerating(false);
      setOutput('');
      try {
        browserProjectRef.current = null;
        const result = await invoke<ScanResult>('scan_folder', { path });
        if (sequence !== scanSeq.current) return;
        workspaceRevision.current = result.revision;
        if (result.junkDirs && result.junkDirs.length > 0) {
          setJunkDirs(result.junkDirs);
        }
        setGitContext(result.gitContext ?? null);
        setWorkspaceChangedOnDisk(false);
        await applyScanResult(result.nodes, result.root, nextPreset, false, preserve);
      } catch (e) {
        console.error(e);
        const msg = e instanceof Error ? e.message : String(e);
        if (sequence !== scanSeq.current) return;
        pushToast('error', `Failed to scan folder: ${msg}`);
        setGenerating(false);
      } finally {
        if (sequence === scanSeq.current) setScanning(false);
      }
    },
    [preset, applyScanResult, pushToast],
  );

  // Re-scans the open folder after files changed on disk, keeping the current selection and skeletons.
  const refreshFromDisk = useCallback(() => {
    if (!currentPath || scanning || browserMode) return;
    void scan(currentPath, preset, {
      selected: new Set(selectedSet),
      skeletons: new Set(skeletonSet),
    });
  }, [currentPath, scanning, browserMode, scan, preset, selectedSet, skeletonSet]);

  useEffect(() => {
    refreshFromDiskRef.current = refreshFromDisk;
  }, [refreshFromDisk]);

  useEffect(() => {
    if (!IN_TAURI || startupRequested.current) return;
    startupRequested.current = true;
    invoke<string | null>('startup_folder')
      .then((folder) => { if (folder) void scan(folder); })
      .catch((error) => pushToast('error', `Cannot open startup folder: ${String(error)}`));
  }, [scan, pushToast]);


  const openFolderBrowser = useCallback(async () => {
    setScanning(true);
    setGenerating(false);
    setOutput('');
    try {
      let nodes: FileNode[] | null = null;
      let project: BrowserProject | null = null;

      // Prefer modern directory picker (Chrome, Edge, Opera)
      try {
        const handle = await pickDirectoryWithPicker();
        setScanning(true);
        pushToast('info', `Reading folder “${handle.name}”…`);
        const scanned = await scanDirectoryHandle(handle);
        nodes = scanned.nodes;
        project = scanned.project;
      } catch (e) {
        if (isCancelledError(e) || e instanceof UserCancelledError) {
          return;
        }
        const msg = e instanceof Error ? e.message : String(e);
        if (msg !== 'SHOW_DIRECTORY_PICKER_UNSUPPORTED') {
          console.warn('showDirectoryPicker failed, trying input fallback', e);
        }

        // Fallback: <input webkitdirectory>
        try {
          pushToast('info', 'Select a folder in the file dialog…');
          const list = await pickDirectoryWithInput();
          const scanned = await scanFileList(list);
          nodes = scanned.nodes;
          project = scanned.project;
        } catch (e2) {
          if (isCancelledError(e2) || e2 instanceof UserCancelledError) return;
          throw e2;
        }
      }

      if (!nodes || !project) {
        pushToast('error', 'No folder data received');
        return;
      }

      browserProjectRef.current = project;
      if (project.skipped && project.skipped.length > 0) {
        const gitCount = project.skipped.filter((s) => s.reason === 'gitignore').length;
        const pttCount = project.skipped.filter((s) => s.reason === 'pttignore').length;
        const unreadableCount = project.skipped.filter((s) => s.reason === 'unreadable').length;
        const parts: string[] = [];
        if (gitCount > 0) parts.push(`${gitCount} .gitignore`);
        if (pttCount > 0) parts.push(`${pttCount} .pttignore`);
        if (unreadableCount > 0) parts.push(`${unreadableCount} unreadable`);
        if (parts.length > 0) {
          pushToast('info', `Browser scan excluded: ${parts.join(', ')}`);
        }
      }
      // End "scanning" before packing so the tree can paint
      setScanning(false);
      await applyScanResult(nodes, project.rootName, preset, true);
    } catch (e) {
      console.error(e);
      if (isCancelledError(e) || e instanceof UserCancelledError) return;
      const msg = e instanceof Error ? e.message : String(e);
      pushToast(
        'error',
        msg || 'Could not open folder in the browser. Prefer Chrome/Edge, or run: cargo tauri dev',
      );
      setGenerating(false);
    } finally {
      setScanning(false);
    }
  }, [applyScanResult, preset, pushToast]);

  const openFolder = useCallback(async () => {
    // Desktop (Tauri): native dialog. Browser: File System Access / webkitdirectory.
    if (!IN_TAURI) {
      await openFolderBrowser();
      return;
    }
    try {
      const selected = await openDialog({
        directory: true,
        multiple: false,
        title: 'Select folder to pack',
      });
      if (!selected) return;
      const path = Array.isArray(selected) ? selected[0] : selected;
      // Guard against unexpected object returns from future plugin versions
      const pathStr =
        typeof path === 'string'
          ? path
          : path && typeof path === 'object' && 'path' in path
            ? String((path as { path: string }).path)
            : String(path ?? '');
      if (!pathStr) {
        pushToast('error', 'Dialog returned an empty path');
        return;
      }
      browserProjectRef.current = null;
      await scan(pathStr);
    } catch (e) {
      console.error(e);
      const msg = e instanceof Error ? e.message : String(e);
      pushToast('error', `Open folder failed: ${msg}`);
      // Fallback: browser picker inside webview (still useful)
      try {
        await openFolderBrowser();
      } catch {
        /* already toasted */
      }
    }
  }, [scan, openFolderBrowser, pushToast]);

  const openHistoryFolder = useCallback(
    (entry: FolderHistoryEntry) => {
      if (!IN_TAURI) {
        pushToast(
          'info',
          'Folder history can be reopened in the desktop app, where native paths are available.',
        );
        return;
      }
      setShowHistory(false);
      browserProjectRef.current = null;
      void scan(entry.path);
    },
    [pushToast, scan],
  );

  const openCustomProject = useCallback(
    (entry: ProjectPref) => {
      if (!IN_TAURI) {
        pushToast(
          'info',
          'Custom projects can be reopened in the desktop app, where native paths are available.',
        );
        return;
      }
      setShowCustom(false);
      browserProjectRef.current = null;
      void scan(entry.path);
    },
    [pushToast, scan],
  );


  useEffect(() => {
    writeFolderHistory(folderHistory);
  }, [folderHistory]);

  useEffect(() => {
    writeProjectPrefs(customProjects);
  }, [customProjects]);


  // Focus management for help dialog
  useEffect(() => {
    if (!showHelp) return;
    const id = window.setTimeout(() => {
      document.querySelector<HTMLElement>('.help-card button')?.focus();
    }, 0);
    return () => window.clearTimeout(id);
  }, [showHelp]);

  const handleCopyFileList = useCallback(async () => {
    if (!fileListText) return;
    try {
      await navigator.clipboard.writeText(fileListText);
      pushToast('success', 'File list copied');
    } catch {
      try {
        await invoke('copy_to_clipboard', { text: fileListText });
        pushToast('success', 'File list copied');
      } catch {
        pushToast('error', 'Could not copy file list');
      }
    }
  }, [fileListText, pushToast]);

  /* ─── Keyboard shortcuts ───────────────────────────── */

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const meta = isModKey(e);
      const target = e.target as HTMLElement | null;
      const inField =
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable);

      if (meta && e.key.toLowerCase() === 'o') {
        e.preventDefault();
        void openFolder();
        return;
      }
      if (meta && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void handleSave();
        return;
      }
      if (meta && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        filterRef.current?.focus();
        filterRef.current?.select();
        return;
      }
      if (meta && e.key.toLowerCase() === 'r' && !e.shiftKey) {
        // Allow refresh without browser reload in tauri
        if (currentPath) {
          e.preventDefault();
          void scan(currentPath);
        }
        return;
      }
      if (meta && e.key.toLowerCase() === 'c' && !inField) {
        if (view === 'list') {
          if (fileListText) {
            e.preventDefault();
            void handleCopyFileList();
          }
        } else if (output) {
          e.preventDefault();
          void handleCopy();
        }
        return;
      }
      if (e.key === 'Escape') {
        if (showHelp) {
          setShowHelp(false);
          return;
        }
        if (showAbout) {
          setShowAbout(false);
          return;
        }
        if (showHistory) {
          setShowHistory(false);
          return;
        }
        if (showCustom) {
          setShowCustom(false);
          return;
        }
        if (filterText) {
          setFilterText('');
          filterRef.current?.blur();
        }
        return;
      }
      if (!inField && (e.key === '?' || (e.shiftKey && e.key === '/'))) {
        e.preventDefault();
        setShowHelp((v) => !v);
      }
    };

    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [
    openFolder,
    handleSave,
    handleCopy,
    handleCopyFileList,
    currentPath,
    scan,
    view,
    fileListText,
    output,
    filterText,
    showHelp,
    showAbout,
    showHistory,
    showCustom,
  ]);


  /* ─── Drag & drop (Tauri) ──────────────────────────── */

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;

    (async () => {
      try {
        const webview = getCurrentWebview();
        unlisten = await webview.onDragDropEvent((event) => {
          if (cancelled) return;
          const payload = event.payload;
          if (payload.type === 'enter' || payload.type === 'over') {
            setDragOver(true);
          } else if (payload.type === 'leave') {
            setDragOver(false);
          } else if (payload.type === 'drop') {
            setDragOver(false);
            const paths = payload.paths ?? [];
            if (paths.length > 0) {
              void scan(paths[0]);
            }
          }
        });
      } catch {
        // Running in browser without Tauri — ignore
      }
    })();

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [scan]);

  /* ─── Render helpers ───────────────────────────────── */

  const showInitialLoading = scanning || (generating && !hasLoadedOnce.current && !output);
  const folderName = currentPath
    ? currentPath.split(/[/\\]/).filter(Boolean).pop() ?? currentPath
    : '';

  const readyBadge = (() => {
    if (generating) {
      return (
        <span className="badge badge-loading">
          <Loader2 size={11} className="spin" /> updating…
        </span>
      );
    }
    if (output && view === 'packed') {
      const isExact = stats.tokenizerExact === true;
      const breakdown =
        stats.contentTokens !== undefined
          ? ` (Content: ${isExact ? '' : '~'}${formatTokens(stats.contentTokens)}, Overhead: ${isExact ? '' : '~'}${formatTokens(stats.overheadTokens ?? 0)})`
          : '';
      const hint = isExact
        ? `Exact BPE token count (o200k_base) on complete serialized artifact.${breakdown}`
        : `${TOKEN_ESTIMATE_HINT}${breakdown}`;
      return (
        <span className={tokenBadgeClass(stats.tokens)} title={hint} data-testid="ready-token-badge">
          <Check size={11} /> ready · {isExact ? '' : '~'}
          {formatTokens(stats.tokens)} tokens ({isExact ? 'exact BPE' : 'approx'})
        </span>
      );
    }
    return null;
  })();


  return {
    ROW_HEIGHT,
    applySelectionPreset,
    autoFitToBudget,
    availableUpdate,
    browserMode,
    budgetPreset,
    changeCustomNote,
    changeFormat,
    clearCurrentProject,
    clearCustomDeselect,
    clearFolderHistory,
    collapseAll,
    contextMenu,
    currentPath,
    customBudget,
    customProjects,
    cycleTheme,
    deselectAll,
    dismissToast,
    dragOver,
    expandAll,
    expanded,
    exportPrefs,
    fileListText,
    filePreview,
    fileTokens,
    fileTree,
    filterRef,
    filterText,
    filteredTree,
    focusedPath,
    folderHistory,
    folderName,
    format,
    fullOutputPreview,
    fullOutputText,
    generate,
    generating,
    gitContext,
    handleCopy,
    handleCopyFileList,
    handleSave,
    handleToggleFullPreview,
    handleTreeContextMenu,
    importPrefs,
    includeGitDiff,
    installUpdate,
    listFormat,
    nodes,
    openCustomProject,
    openFilePreview,
    openFolder,
    openHistoryFolder,
    openInDefaultApp,
    openWithApp,
    output,
    outputBytes,
    pickAppAndOpen,
    preset,
    previewError,
    previewLoading,
    previewRelPath,
    promptTemplateId,
    pushToast,
    readyBadge,
    redactSecretsEnabled,
    redactionSummary,
    removeCustomProject,
    removeFolderFromHistory,
    resizing,
    resolvedTheme,
    scan,
    scanning,
    selectAll,
    selectGitFiles,
    selectRelatedFiles,
    selectedCount,
    selectedSet,
    setBudgetPreset,
    setContextMenu,
    setCustomBudget,
    setFilterText,
    setFocusedPath,
    setListFormat,
    setPromptTemplateId,
    setResizing,
    setShowAbout,
    setShowCustom,
    setShowHelp,
    setShowHistory,
    setShowPromptStudio,
    setShowTopConsumers,
    setTaskPrompt,
    setThemePref,
    setTokenSort,
    setTreeScrollTop,
    setTreeWidth,
    setView,
    showAbout,
    showCustom,
    showHelp,
    showHistory,
    showInitialLoading,
    showPromptStudio,
    showTopConsumers,
    skeletonSet,
    startRowIdx,
    stats,
    subtreeStats,
    targetBudgetTokens,
    taskPrompt,
    themePref,
    toasts,
    toggleCustomFavorite,
    toggleExpand,
    toggleFolderPin,
    toggleIncludeGitDiff,
    toggleRedactSecrets,
    toggleSelect,
    toggleSkeleton,
    tokenSort,
    totalFiles,
    totalTreeHeight,
    treeScrollRef,
    treeWidth,
    truncatedPreview,
    updateBusy,
    updateError,
    view,
    virtualSlice,
    visibleTreeRows,
    workspaceChangedOnDisk,
  };
}

export type WorkspaceState = ReturnType<typeof useWorkspace>;
