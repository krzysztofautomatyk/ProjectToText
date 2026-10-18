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
import {
  interpolatePromptVariables,
  loadPromptStudioStore,
  PROMPT_STUDIO_UPDATED_EVENT,
  projectPrefKey,
  readProjectPrefs,
  rememberProject,
  removeProject,
  resolveDefaultPromptForWorkspace,
  setActivePromptId,
  setProjectFavorite,
  setProjectNote,
  writeProjectPrefs,
  type CustomPromptTemplate,
  type ProjectPref,
  type PromptPresetConfig,
  type PromptStudioUpdateDetail,
} from './projectPrefs';
import {
  applyI18nImport,
  applyPromptStudioImport,
  buildPrefSnapshot,
  exportPromptStudioOnly,
  mergePrefSnapshot,
  parsePrefSnapshot,
  previewPrefImport,
  promptStudioFileName,
  snapshotFileName,
  type PrefImportMode,
  type PrefImportPreview,
} from './prefTransfer';
import { isTauriRuntime } from './tauriEnv';
import { isModKey } from './platform';
import { type FileNode, type GitRepoContext, type ScanResult, type OutputFormat, type ViewMode, type ListFormat, type SelectionPreset, type ToastKind, type BudgetPreset, BUDGET_LIMITS, type ToastItem, normalizePath, applySavedDeselects, formatTokens, isLowPriorityPath, applyPreset, generateFileList, generatePathsList, readStoredFormat, tokenBadgeClass } from './treeModel';
import { useThemeAndLayout } from './useThemeAndLayout';
import { useGeneration } from './useGeneration';
import { useSelection } from './useSelection';
import { useFilePreviewAndMenu } from './useFilePreviewAndMenu';
import { loadI18nState, useI18n } from './i18n';

export const IN_TAURI = isTauriRuntime();

export { readThemePref, resolveTheme, themeLabel, type ThemePref } from './useThemeAndLayout';

export function useWorkspace() {
  const { t } = useI18n();
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
  const [showPromptManager, setShowPromptManager] = useState(false);
  const [promptTemplateId, setPromptTemplateId] = useState('none');
  const [taskPrompt, setTaskPrompt] = useState('');
  const [promptStudioRevision, setPromptStudioRevision] = useState(0);
  const [showDocs, setShowDocs] = useState(false);
  const [importPreview, setImportPreview] = useState<PrefImportPreview | null>(null);
  const [pendingImportText, setPendingImportText] = useState<string | null>(null);
  const [importMode, setImportMode] = useState<PrefImportMode>('merge');
  const [importApplyDefault, setImportApplyDefault] = useState(true);
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
  const { output, setOutput, generating, setGenerating, stats, setStats, fullOutputPreview, fullOutputText, setFullOutputText, truncatedPreview, setTruncatedPreview, totalBytes, setTotalBytes, redactSecretsEnabled, setRedactSecretsEnabled, redactionSummary, setRedactionSummary, skeletonSet, setSkeletonSet, fileTokens, setFileTokens, includeGitDiff, setIncludeGitDiff, genSeq, hasLoadedOnce, generateTimer, generate, generateNow, handleToggleFullPreview, handleCopy, handleSave } = useGeneration({
    currentPath,
    nodes,
    format,
    taskPrompt,
    pushToast,
    browserProjectRef,
    workspaceRevision,
    gitContext,
    targetBudgetTokens,
  });
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

  const refreshPromptStudio = useCallback(() => {
    setPromptStudioRevision((n) => n + 1);
  }, []);

  /** Apply workspace/global default prompt into the active Prompt Studio bar. */
  const applyDefaultPromptForPath = useCallback(
    (
      pathLabel: string,
      opts?: {
        selectedCount?: number;
        skeletonEnabled?: boolean;
        /** Ignore autoApplyDefaultOnOpen and always sync from store defaults. */
        force?: boolean;
      },
    ) => {
      const studio = loadPromptStudioStore();
      const def = resolveDefaultPromptForWorkspace(pathLabel || null);
      if (!def) {
        if (opts?.force) {
          setPromptTemplateId('none');
          setTaskPrompt('');
          setActivePromptId(null);
        }
        return false;
      }
      const wsKey = pathLabel ? projectPrefKey(pathLabel) : '';
      const hasWorkspaceDefault = Boolean(wsKey && studio.workspaceDefaultPromptMap[wsKey]);
      if (!opts?.force && !hasWorkspaceDefault && !studio.autoApplyDefaultOnOpen) {
        return false;
      }
      const projectName =
        (pathLabel.split(/[/\\]/).filter(Boolean).pop() ?? pathLabel) || 'Workspace';
      const text = interpolatePromptVariables(def.content, {
        projectName,
        gitBranch: gitContext?.currentBranch ?? undefined,
        selectedFilesCount: opts?.selectedCount ?? 0,
        tokenBudget: targetBudgetTokens,
        skeletonEnabled: opts?.skeletonEnabled ?? false,
      });
      setPromptTemplateId(def.id);
      setActivePromptId(def.id);
      setTaskPrompt(text);
      setShowPromptStudio(true);
      refreshPromptStudio();
      return true;
    },
    [gitContext, targetBudgetTokens, refreshPromptStudio],
  );

  // Cross-component sync without full reload (import / delete / default changes)
  useEffect(() => {
    const onUpdate = (ev: Event) => {
      const detail = (ev as CustomEvent<PromptStudioUpdateDetail>).detail ?? {};
      refreshPromptStudio();
      if (detail.deletedId) {
        const deleted = detail.deletedId;
        setPromptTemplateId((curr) => {
          if (curr === deleted) {
            const fallback = resolveDefaultPromptForWorkspace(currentPath || null);
            if (fallback) {
              setTaskPrompt(
                interpolatePromptVariables(fallback.content, {
                  projectName:
                    (currentPath.split(/[/\\]/).filter(Boolean).pop() ?? currentPath) ||
                    'Workspace',
                  gitBranch: gitContext?.currentBranch ?? undefined,
                  selectedFilesCount: nodes.filter((n) => n.selected && !n.is_dir).length,
                  tokenBudget: targetBudgetTokens,
                  skeletonEnabled: skeletonSet.size > 0,
                }),
              );
              setActivePromptId(fallback.id);
              return fallback.id;
            }
            setTaskPrompt('');
            setActivePromptId(null);
            return 'none';
          }
          return curr;
        });
      }
      if (detail.reason === 'import') {
        applyDefaultPromptForPath(currentPath || '', {
          selectedCount: nodes.filter((n) => n.selected && !n.is_dir).length,
          skeletonEnabled: skeletonSet.size > 0,
          force: true,
        });
      }
    };
    window.addEventListener(PROMPT_STUDIO_UPDATED_EVENT, onUpdate);
    return () => window.removeEventListener(PROMPT_STUDIO_UPDATED_EVENT, onUpdate);
  }, [
    refreshPromptStudio,
    currentPath,
    gitContext,
    nodes,
    targetBudgetTokens,
    skeletonSet,
    applyDefaultPromptForPath,
  ]);

  /* ─── Preferences export / import ──────────────────── */

  const exportPrefs = useCallback(() => {
    const snapshot = buildPrefSnapshot(
      customProjects,
      folderHistory,
      loadPromptStudioStore(),
      loadI18nState(),
    );
    const text = JSON.stringify(snapshot, null, 2);
    downloadText(snapshotFileName(), text);
    const studio = snapshot.promptStudio;
    const languageCount = snapshot.i18n?.customPacks.length ?? 0;
    pushToast(
      'success',
      t('toast.exported', {
        projects: customProjects.length,
        history: folderHistory.length,
        prompts: studio?.customPrompts.length ?? 0,
        languages: languageCount > 0 ? t('toast.exportedLanguages', { count: languageCount }) : '',
      }),
    );
  }, [customProjects, folderHistory, pushToast, t]);

  const exportPromptStudioPack = useCallback(() => {
    downloadText(promptStudioFileName(), exportPromptStudioOnly());
    pushToast('success', t('toast.exportedPrompts'));
  }, [pushToast, t]);

  const cancelImportPrefs = useCallback(() => {
    setImportPreview(null);
    setPendingImportText(null);
  }, []);

  const confirmImportPrefs = useCallback(() => {
    if (!pendingImportText) return;
    try {
      const snapshot = parsePrefSnapshot(pendingImportText);
      const result = mergePrefSnapshot(
        snapshot,
        customProjects,
        folderHistory,
        loadPromptStudioStore(),
        { mode: importMode, applyImportedDefault: importApplyDefault },
      );
      setCustomProjects(result.projects);
      setFolderHistory(result.history);
      if (result.promptStudio) {
        applyPromptStudioImport(result.promptStudio);
        refreshPromptStudio();
      }
      if (result.i18n) applyI18nImport(result.i18n);
      const promptMsg = result.promptStats
        ? t('toast.importedPrompts', {
            added: result.promptStats.addedCount,
            updated: result.promptStats.updatedCount,
          })
        : '';
      const languageMsg = result.i18n
        ? t('toast.importedLanguages', { count: result.i18n.customPacks.length })
        : '';
      const secretMsg =
        result.secretWarnings.length > 0
          ? t('toast.importedSecrets', { count: result.secretWarnings.length })
          : '';
      pushToast(
        'success',
        t('toast.imported', {
          projects: result.projectsImported,
          history: result.historyImported,
          prompts: promptMsg,
          languages: languageMsg,
          skipped: result.skipped > 0 ? t('toast.importedSkipped', { count: result.skipped }) : '',
          secrets: secretMsg,
        }),
      );
    } catch (e) {
      pushToast('error', e instanceof Error ? e.message : t('toast.importFailed'));
    } finally {
      cancelImportPrefs();
    }
  }, [
    pendingImportText,
    customProjects,
    folderHistory,
    importMode,
    importApplyDefault,
    pushToast,
    refreshPromptStudio,
    cancelImportPrefs,
    t,
  ]);

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
      const text = await file.text();
      const snapshot = parsePrefSnapshot(text);
      const preview = previewPrefImport(
        snapshot,
        customProjects,
        folderHistory,
        loadPromptStudioStore(),
      );
      setPendingImportText(text);
      setImportPreview(preview);
      setImportMode('merge');
      setImportApplyDefault(Boolean(preview.defaultPromptId));
    } catch (e) {
      pushToast('error', e instanceof Error ? e.message : t('toast.importFailed'));
    }
  }, [customProjects, folderHistory, pushToast, t]);

  const applyPlaybook = useCallback(
    (prompt: CustomPromptTemplate, config?: PromptPresetConfig) => {
      setShowPromptStudio(true);
      setPromptTemplateId(prompt.id);
      setActivePromptId(prompt.id);
      const folder =
        (currentPath.split(/[/\\]/).filter(Boolean).pop() ?? currentPath) || 'Workspace';
      const text = interpolatePromptVariables(prompt.content, {
        projectName: folder,
        gitBranch: gitContext?.currentBranch ?? undefined,
        selectedFilesCount: nodes.filter((n) => n.selected && !n.is_dir).length,
        tokenBudget:
          config?.recommendedBudget ??
          (budgetPreset === 'custom' ? customBudget : BUDGET_LIMITS[budgetPreset]),
        skeletonEnabled: config?.enableSkeleton ?? skeletonSet.size > 0,
      });
      setTaskPrompt(text);
      if (config?.recommendedBudget) {
        const b = config.recommendedBudget;
        if (b <= 32_000) setBudgetPreset('32k');
        else if (b <= 64_000) setBudgetPreset('64k');
        else if (b <= 128_000) setBudgetPreset('128k');
        else if (b <= 200_000) setBudgetPreset('200k');
        else {
          setBudgetPreset('custom');
          setCustomBudget(b);
        }
      }
      if (config?.recommendedFormat) {
        setFormat(config.recommendedFormat === 'plain' ? 'plain' : config.recommendedFormat);
      }
      if (config?.includeGitDiff != null) setIncludeGitDiff(config.includeGitDiff);
      refreshPromptStudio();
      pushToast('success', t('toast.loadedPlaybook', { name: prompt.name }));
      if (currentPath && nodes.length > 0) {
        generate(nodes, currentPath, format, true, { prompt: text });
      }
    },
    [
      currentPath,
      gitContext,
      nodes,
      budgetPreset,
      customBudget,
      skeletonSet,
      format,
      generate,
      pushToast,
      refreshPromptStudio,
      setFormat,
      setIncludeGitDiff,
      t,
    ],
  );

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
    pushToast('info', t('toast.projectCleared'));
  }, [currentPath, nodes.length, output, pushToast, t]);


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

      // Inherit default prompt on project open / switch (not on in-place refresh)
      if (!preserve) {
        applyDefaultPromptForPath(pathLabel, {
          selectedCount: withSelection.filter((n) => n.selected && !n.is_dir).length,
          skeletonEnabled: nextSkels.size > 0,
        });
      }

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
    [
      format,
      generateNow,
      pushToast,
      rememberLoadedFolder,
      customProjects,
      junkDirs,
      targetBudgetTokens,
      applyDefaultPromptForPath,
    ],
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
      pushToast('success', t('toast.fileListCopied'));
    } catch {
      try {
        await invoke('copy_to_clipboard', { text: fileListText });
        pushToast('success', t('toast.fileListCopied'));
      } catch {
        pushToast('error', t('toast.fileListCopyFailed'));
      }
    }
  }, [fileListText, pushToast, t]);

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
        // Close only the topmost overlay — never clear file selection here.
        if (showDocs) {
          e.preventDefault();
          setShowDocs(false);
          return;
        }
        if (showPromptManager) {
          e.preventDefault();
          setShowPromptManager(false);
          return;
        }
        if (importPreview) {
          e.preventDefault();
          cancelImportPrefs();
          return;
        }
        if (showHelp) {
          e.preventDefault();
          setShowHelp(false);
          return;
        }
        if (showAbout) {
          e.preventDefault();
          setShowAbout(false);
          return;
        }
        if (showHistory) {
          e.preventDefault();
          setShowHistory(false);
          return;
        }
        if (showCustom) {
          e.preventDefault();
          setShowCustom(false);
          return;
        }
        if (filterText) {
          setFilterText('');
          filterRef.current?.blur();
        }
        return;
      }
      if (e.key === 'F1' || (meta && e.key === '/')) {
        e.preventDefault();
        setShowDocs((v) => !v);
        return;
      }
      if (!inField && (e.key === '?' || (e.shiftKey && e.key === '/'))) {
        e.preventDefault();
        setShowHelp((v) => !v);
      }
    };

    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
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
    showDocs,
    showPromptManager,
    importPreview,
    cancelImportPrefs,
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
          <Loader2 size={11} className="spin" /> {t('badge.updating')}
        </span>
      );
    }
    if (output && view === 'packed') {
      const isExact = stats.tokenizerExact === true;
      const breakdown =
        stats.contentTokens !== undefined
          ? t('badge.breakdown', {
              content: `${isExact ? '' : '~'}${formatTokens(stats.contentTokens)}`,
              overhead: `${isExact ? '' : '~'}${formatTokens(stats.overheadTokens ?? 0)}`,
            })
          : '';
      const hint = `${isExact ? t('status.tokens.exactFull') : t('tokens.estimateHint')}${breakdown}`;
      return (
        <span className={tokenBadgeClass(stats.tokens)} title={hint} data-testid="ready-token-badge">
          <Check size={11} />{' '}
          {t('badge.ready', {
            tokens: `${isExact ? '' : '~'}${formatTokens(stats.tokens)}`,
            kind: isExact ? t('tokens.kindExactBpe') : t('tokens.kindApprox'),
          })}
        </span>
      );
    }
    return null;
  })();


  return {
    ROW_HEIGHT,
    applyPlaybook,
    applySelectionPreset,
    autoFitToBudget,
    availableUpdate,
    browserMode,
    budgetPreset,
    cancelImportPrefs,
    changeCustomNote,
    changeFormat,
    clearCurrentProject,
    clearCustomDeselect,
    clearFolderHistory,
    collapseAll,
    confirmImportPrefs,
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
    exportPromptStudioPack,
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
    importApplyDefault,
    importMode,
    importPrefs,
    importPreview,
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
    promptStudioRevision,
    promptTemplateId,
    pushToast,
    readyBadge,
    redactSecretsEnabled,
    redactionSummary,
    refreshPromptStudio,
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
    setImportApplyDefault,
    setImportMode,
    setListFormat,
    setPromptTemplateId,
    setResizing,
    setShowAbout,
    setShowCustom,
    setShowDocs,
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
    showDocs,
    showHelp,
    showHistory,
    showInitialLoading,
    showPromptManager,
    showPromptStudio,
    showTopConsumers,
    setShowPromptManager,
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
