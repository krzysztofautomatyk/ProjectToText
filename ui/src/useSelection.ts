import { useCallback, useMemo, useState } from 'react';
import { applyDeselectDelta, clearDeselectPaths, projectPrefKey, rememberProject, type ProjectPref } from './projectPrefs';
import { type FileNode, type GitRepoContext, type FileTokenStat, type PackTokenStats, type OutputFormat, type SelectionPreset, type ToastKind, normalizePath, applySavedDeselects, formatTokens, estimateTokensFromBytes, isLowPriorityPath, applyPreset, buildFileTree, sortTreeByTokens, flattenVisibleTree, type SubtreeStats, computeSubtree, filterTree, collectDirPaths, collectFilePaths } from './treeModel';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import type { useGeneration } from './useGeneration';

interface SelectionParams {
  currentPath: string;
  nodes: FileNode[];
  setNodes: Dispatch<SetStateAction<FileNode[]>>;
  format: OutputFormat;
  setFormat: Dispatch<SetStateAction<OutputFormat>>;
  tokenSort: boolean;
  gitContext: GitRepoContext | null;
  junkDirs: readonly string[];
  customProjects: ProjectPref[];
  setCustomProjects: Dispatch<SetStateAction<ProjectPref[]>>;
  targetBudgetTokens: number;
  stats: PackTokenStats;
  fileTokens: FileTokenStat[];
  skeletonSet: Set<string>;
  setSkeletonSet: Dispatch<SetStateAction<Set<string>>>;
  setRedactSecretsEnabled: Dispatch<SetStateAction<boolean>>;
  setIncludeGitDiff: Dispatch<SetStateAction<boolean>>;
  setOutput: Dispatch<SetStateAction<string>>;
  setStats: Dispatch<SetStateAction<PackTokenStats>>;
  setGenerating: Dispatch<SetStateAction<boolean>>;
  genSeq: MutableRefObject<number>;
  generateTimer: MutableRefObject<number | null>;
  generate: ReturnType<typeof useGeneration>['generate'];
  pushToast: (kind: ToastKind, message: string) => void;
}

export function useSelection({ currentPath, nodes, setNodes, format, setFormat, tokenSort, gitContext, junkDirs, customProjects, setCustomProjects, targetBudgetTokens, stats, fileTokens, skeletonSet, setSkeletonSet, setRedactSecretsEnabled, setIncludeGitDiff, setOutput, setStats, setGenerating, genSeq, generateTimer, generate, pushToast }: SelectionParams) {
  const [filterText, setFilterText] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [preset, setPreset] = useState<SelectionPreset>('source');
  const selectedSet = useMemo(
    () => new Set(nodes.filter((n) => n.selected && !n.is_dir).map((n) => n.path)),
    [nodes],
  );

  const selectedCount = selectedSet.size;
  const fileTree = useMemo(() => buildFileTree(nodes), [nodes]);
  const filteredTree = useMemo(
    () => filterTree(fileTree, filterText),
    [fileTree, filterText],
  );
  const subtreeStats = useMemo(() => {
    const stats = new Map<string, SubtreeStats>();
    computeSubtree(filteredTree ?? fileTree, selectedSet, skeletonSet, stats);
    return stats;
  }, [filteredTree, fileTree, selectedSet, skeletonSet]);

  const sortedDisplayTree = useMemo(
    () =>
      filteredTree ? sortTreeByTokens(filteredTree, tokenSort, subtreeStats) : null,
    [filteredTree, tokenSort, subtreeStats],
  );

  const visibleTreeRows = useMemo(
    () => flattenVisibleTree(sortedDisplayTree, expanded, filterText),
    [sortedDisplayTree, expanded, filterText],
  );

  /* ─── Selection ────────────────────────────────────── */

  /** Record just-toggled paths (delta) so Custom projects replay user intent exactly. */
  const recordDeselectionDelta = useCallback(
    (toggledPaths: string[], turnedOn: boolean) => {
      if (!currentPath) return;
      setCustomProjects((prev) => {
        const key = projectPrefKey(currentPath);
        const existing = prev.some((p) => projectPrefKey(p.path) === key);
        const base = existing ? prev : rememberProject(prev, currentPath);
        return applyDeselectDelta(
          base,
          currentPath,
          turnedOn
            ? { turnedOn: toggledPaths, turnedOff: [] }
            : { turnedOn: [], turnedOff: toggledPaths },
        );
      });
    },
    [currentPath],
  );

  const toggleSelect = useCallback(
    (path: string, isDir: boolean) => {
      const norm = normalizePath(path);
      setNodes((prev) => {
        const target = prev.find((n) => normalizePath(n.path) === norm);
        if (!target) return prev;

        // For dirs: decide based on current subtree selection among files
        let newState: boolean;
        if (isDir) {
          const descendants = prev.filter((n) => {
            if (n.is_dir) return false;
            const p = normalizePath(n.path);
            return p === norm || p.startsWith(norm + '/');
          });
          const allOn =
            descendants.length > 0 && descendants.every((n) => n.selected);
          newState = !allOn;
        } else {
          newState = !target.selected;
        }

        const updated = prev.map((n) => {
          const p = normalizePath(n.path);
          if (p === norm) return { ...n, selected: newState };
          if (isDir && p.startsWith(norm + '/')) {
            return { ...n, selected: newState };
          }
          return n;
        });

        if (currentPath) {
          generate(updated, currentPath, format, false);
          if (isDir) {
            const toggled = prev
              .filter(
                (n) =>
                  !n.is_dir &&
                  (normalizePath(n.path) === norm ||
                    normalizePath(n.path).startsWith(norm + '/')),
              )
              .map((n) => n.path);
            recordDeselectionDelta(toggled, newState);
          } else {
            recordDeselectionDelta([norm], newState);
          }
        }
        return updated;
      });
    },
    [currentPath, format, generate, recordDeselectionDelta],
  );

  const selectAll = useCallback(() => {
    const q = filterText.trim();
    let updated: FileNode[];
    if (q && filteredTree) {
      const matchPaths = new Set(
        collectFilePaths(filteredTree).map((p) => normalizePath(p)),
      );
      updated = nodes.map((n) => {
        if (n.is_dir) return n;
        if (matchPaths.has(normalizePath(n.path))) return { ...n, selected: true };
        return n;
      });
    } else {
      updated = nodes.map((n) => ({ ...n, selected: !n.is_dir }));
    }
    setNodes(updated);
    if (currentPath) {
      // Select-all must forget exclusions, otherwise a later preset/refresh re-deselects them.
      const turnedOn = updated
        .filter((n) => !n.is_dir && n.selected)
        .map((n) => normalizePath(n.path));
      recordDeselectionDelta(turnedOn, true);
      generate(updated, currentPath, format, true);
    }
  }, [nodes, currentPath, format, generate, filterText, filteredTree, recordDeselectionDelta]);

  const deselectAll = useCallback(() => {
    if (generateTimer.current != null) {
      window.clearTimeout(generateTimer.current);
      generateTimer.current = null;
    }
    const q = filterText.trim();
    let updated: FileNode[];
    if (q && filteredTree) {
      const matchPaths = new Set(
        collectFilePaths(filteredTree).map((p) => normalizePath(p)),
      );
      updated = nodes.map((n) => {
        if (n.is_dir) return { ...n, selected: false };
        if (matchPaths.has(normalizePath(n.path))) return { ...n, selected: false };
        return n;
      });
    } else {
      updated = nodes.map((n) => ({ ...n, selected: false }));
    }
    setNodes(updated);
    const remaining = updated.filter((n) => n.selected && !n.is_dir).length;
    if (currentPath) {
      // Record only files this action actually unchecked. Recording every
      // currently-unselected file would also persist preset/filter gaps
      // (e.g. docs excluded by the Source preset) as user deselections.
      const toggled = nodes
        .filter((n, i) => !n.is_dir && n.selected && !updated[i].selected)
        .map((n) => normalizePath(n.path));
      recordDeselectionDelta(toggled, false);
    }
    if (remaining === 0) {
      // Invalidate any generation still in flight so its late result cannot repopulate the output.
      genSeq.current += 1;
      setOutput('');
      setStats({ files: 0, tokens: 0 });
      setGenerating(false);
    } else if (currentPath) {
      generate(updated, currentPath, format, true);
    }
  }, [nodes, filterText, filteredTree, currentPath, format, generate, recordDeselectionDelta]);

  const applySelectionPreset = useCallback(
    (next: SelectionPreset) => {
      setPreset(next);
      if (nodes.length === 0) return;
      // Presets must keep files the user excluded in the Custom replay list unchecked.
      const saved = customProjects.find(
        (p) => projectPrefKey(p.path) === projectPrefKey(currentPath),
      );
      const updated = applySavedDeselects(
        applyPreset(nodes, next, junkDirs),
        saved?.deselectPaths ?? [],
      );
      setNodes(updated);

      let nextSkels = new Set<string>();
      if (next === 'core_skeleton') {
        for (const n of updated) {
          if (!n.is_dir && n.selected && isLowPriorityPath(n.path)) {
            nextSkels.add(normalizePath(n.path));
          }
        }
      }
      setSkeletonSet(nextSkels);

      if (currentPath) generate(updated, currentPath, format, true, { skeletons: nextSkels });
      const labels: Record<SelectionPreset, string> = {
        source: 'Source files selected',
        docs: 'Source + docs selected',
        all: 'All non-junk files selected',
        core_skeleton: 'Core Full + Rest Skeleton applied',
      };
      pushToast('info', labels[next]);
    },
    [nodes, currentPath, format, generate, pushToast, customProjects, junkDirs],
  );

  const toggleSkeleton = useCallback(
    (path: string, isDir: boolean) => {
      const norm = normalizePath(path);
      setSkeletonSet((prev) => {
        const next = new Set(prev);
        if (isDir) {
          const descendants = nodes.filter(
            (n) =>
              !n.is_dir &&
              (normalizePath(n.path) === norm ||
                normalizePath(n.path).startsWith(norm + '/')),
          );
          const allSkel =
            descendants.length > 0 &&
            descendants.every((n) => next.has(normalizePath(n.path)));
          for (const d of descendants) {
            const p = normalizePath(d.path);
            if (allSkel) next.delete(p);
            else next.add(p);
          }
        } else {
          if (next.has(norm)) next.delete(norm);
          else next.add(norm);
        }
        if (currentPath) {
          generate(nodes, currentPath, format, false, { skeletons: next });
        }
        return next;
      });
    },
    [nodes, currentPath, format, generate],
  );

  const toggleRedactSecrets = useCallback(() => {
    setRedactSecretsEnabled((prev) => {
      const next = !prev;
      if (currentPath && nodes.length > 0) {
        generate(nodes, currentPath, format, true, { redact: next });
      }
      pushToast(
        'info',
        next ? 'Secret masking enabled' : 'Secret masking disabled',
      );
      return next;
    });
  }, [currentPath, nodes, format, generate, pushToast]);

  const toggleIncludeGitDiff = useCallback(() => {
    setIncludeGitDiff((prev) => {
      const next = !prev;
      if (currentPath && nodes.length > 0) {
        generate(nodes, currentPath, format, true, { gitDiff: next });
      }
      return next;
    });
  }, [currentPath, nodes, format, generate]);

  const selectGitFiles = useCallback(
    (kind: 'modified' | 'branch') => {
      if (!gitContext) return;
      const list =
        kind === 'modified'
          ? gitContext.modifiedFiles
          : gitContext.branchChangedFiles;
      if (list.length === 0) {
        pushToast(
          'info',
          kind === 'modified'
            ? 'No modified or untracked files in working tree'
            : 'No branch changes detected vs base branch',
        );
        return;
      }
      const targetSet = new Set(list.map((p) => normalizePath(p)));
      const updated = nodes.map((n) =>
        n.is_dir ? n : { ...n, selected: targetSet.has(normalizePath(n.path)) },
      );
      setNodes(updated);
      if (currentPath) {
        generate(updated, currentPath, format, true);
      }
      pushToast(
        'info',
        `Selected ${list.length} ${kind === 'modified' ? 'Git modified' : 'branch changed'} files`,
      );
    },
    [gitContext, nodes, currentPath, format, generate, pushToast],
  );



  const autoFitToBudget = useCallback(() => {
    if (!currentPath || nodes.length === 0) return;
    const limit = Math.floor(targetBudgetTokens * 0.9);
    if (stats.tokens <= limit) {
      pushToast(
        'info',
        `Already within 90% of ${formatTokens(targetBudgetTokens)} budget`,
      );
      return;
    }

    const tokenMap = new Map<string, number>();
    for (const ft of fileTokens) {
      tokenMap.set(normalizePath(ft.path), ft.tokens);
    }

    const selectedFiles = nodes.filter((n) => !n.is_dir && n.selected);
    const candidates = selectedFiles
      .map((n) => {
        const norm = normalizePath(n.path);
        const tok =
          tokenMap.get(norm) ?? estimateTokensFromBytes(n.size ?? 0);
        return {
          path: norm,
          lowPriority: isLowPriorityPath(norm),
          tokens: tok,
        };
      })
      .sort((a, b) => {
        if (a.lowPriority !== b.lowPriority) return a.lowPriority ? -1 : 1;
        return b.tokens - a.tokens;
      });

    let currentTotal = stats.tokens;
    const nextSkels = new Set(skeletonSet);
    const toDeselect = new Set<string>();

    // Pass 1: skeletonize heavy files first (~70% reduction)
    for (const c of candidates) {
      if (currentTotal <= limit) break;
      if (!nextSkels.has(c.path) && c.tokens > 25) {
        nextSkels.add(c.path);
        currentTotal = Math.max(0, currentTotal - Math.floor(c.tokens * 0.7));
      }
    }

    // Pass 2: deselect low-priority or heaviest files if still over budget
    for (const c of candidates) {
      if (currentTotal <= limit) break;
      if (selectedFiles.length - toDeselect.size <= 1) break;
      toDeselect.add(c.path);
      const effective = nextSkels.has(c.path)
        ? Math.ceil(c.tokens * 0.3)
        : c.tokens;
      currentTotal = Math.max(0, currentTotal - effective);
    }

    const updated = nodes.map((n) =>
      !n.is_dir && toDeselect.has(normalizePath(n.path))
        ? { ...n, selected: false }
        : n,
    );
    setNodes(updated);
    setSkeletonSet(nextSkels);
    generate(updated, currentPath, format, true, { skeletons: nextSkels });
    pushToast(
      'success',
      `Auto-fit complete: ${nextSkels.size} skeletonized · ${toDeselect.size} excluded`,
    );
  }, [
    currentPath,
    nodes,
    targetBudgetTokens,
    stats.tokens,
    fileTokens,
    skeletonSet,
    format,
    generate,
    pushToast,
  ]);

  const clearCustomDeselect = useCallback(
    (entry: ProjectPref) => {
      const isCurrent =
        !!currentPath && projectPrefKey(entry.path) === projectPrefKey(currentPath);
      setCustomProjects((prev) => clearDeselectPaths(prev, entry.path));
      if (isCurrent && entry.deselectPaths.length > 0 && nodes.length > 0) {
        // Clearing the current project must immediately re-check its files;
        // otherwise the tree stays deselected until a preset change or refresh.
        const excluded = new Set(entry.deselectPaths.map((p) => normalizePath(p)));
        const updated = nodes.map((n) =>
          !n.is_dir && excluded.has(normalizePath(n.path)) ? { ...n, selected: true } : n,
        );
        setNodes(updated);
        if (currentPath) generate(updated, currentPath, format, true);
      }
    },
    [currentPath, nodes, format, generate],
  );

  const toggleExpand = useCallback((path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const expandAll = useCallback(() => {
    if (!fileTree) return;
    setExpanded(new Set(collectDirPaths(fileTree)));
  }, [fileTree]);

  const collapseAll = useCallback(() => {
    setExpanded(new Set());
  }, []);

  const changeFormat = useCallback(
    (newFormat: OutputFormat) => {
      setFormat(newFormat);
      try {
        localStorage.setItem('ptt.format', newFormat);
      } catch {
        /* ignore */
      }
      if (currentPath && nodes.length > 0) {
        generate(nodes, currentPath, newFormat, true);
      }
    },
    [currentPath, nodes, generate],
  );


  return {
    filterText,
    setFilterText,
    expanded,
    setExpanded,
    preset,
    setPreset,
    selectedSet,
    selectedCount,
    fileTree,
    filteredTree,
    subtreeStats,
    sortedDisplayTree,
    visibleTreeRows,
    toggleSelect,
    selectAll,
    deselectAll,
    applySelectionPreset,
    toggleSkeleton,
    toggleRedactSecrets,
    toggleIncludeGitDiff,
    selectGitFiles,
    autoFitToBudget,
    clearCustomDeselect,
    toggleExpand,
    expandAll,
    collapseAll,
    changeFormat,
    recordDeselectionDelta,
  };
}
