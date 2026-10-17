import { useCallback, useEffect, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { type FilePreviewData } from './FileViewer';
import { readBrowserFilePreview, type BrowserProject } from './browserFs';
import { isTauriRuntime } from './tauriEnv';
import { type FileNode, type RelatedFiles, type OutputFormat, type ViewMode, type ToastKind, type ContextMenuState, normalizePath } from './treeModel';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import type { useGeneration } from './useGeneration';

const IN_TAURI = isTauriRuntime();

interface FilePreviewParams {
  currentPath: string;
  nodes: FileNode[];
  format: OutputFormat;
  browserProjectRef: MutableRefObject<BrowserProject | null>;
  setView: Dispatch<SetStateAction<ViewMode>>;
  setFocusedPath: Dispatch<SetStateAction<string | null>>;
  setNodes: Dispatch<SetStateAction<FileNode[]>>;
  pushToast: (kind: ToastKind, message: string) => void;
  generate: ReturnType<typeof useGeneration>['generate'];
  workspaceRevision: MutableRefObject<number>;
}

export function useFilePreviewAndMenu({ currentPath, nodes, format, browserProjectRef, setView, setFocusedPath, setNodes, pushToast, generate, workspaceRevision }: FilePreviewParams) {
  const [filePreview, setFilePreview] = useState<FilePreviewData | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewRelPath, setPreviewRelPath] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);

  /* ─── File preview / open with ─────────────────────── */

  const openFilePreview = useCallback(
    async (relPath: string) => {
      if (!currentPath) return;
      setContextMenu(null);
      setPreviewRelPath(relPath);
      setView('file');
      setPreviewLoading(true);
      setPreviewError(null);
      try {
        const browserProject = browserProjectRef.current;
        if (browserProject) {
          const result = await readBrowserFilePreview(
            browserProject,
            normalizePath(relPath),
          );
          setFilePreview(result);
        } else {
          const result = await invoke<FilePreviewData>('read_file_preview', {
            root: currentPath,
            relativePath: normalizePath(relPath),
            maxBytes: 512 * 1024,
          });
          setFilePreview(result);
        }
      } catch (e) {
        console.error(e);
        setFilePreview(null);
        setPreviewError(e instanceof Error ? e.message : String(e));
        pushToast('error', 'Failed to load file preview');
      } finally {
        setPreviewLoading(false);
      }
    },
    [currentPath, pushToast],
  );

  const openInDefaultApp = useCallback(
    async (relPath?: string) => {
      const path = relPath ?? previewRelPath;
      if (!currentPath || !path) return;
      setContextMenu(null);
      if (browserProjectRef.current || !IN_TAURI) {
        pushToast(
          'info',
          'Opening with system apps requires the desktop app: cargo tauri dev',
        );
        return;
      }
      try {
        await invoke('open_in_default_app', {
          root: currentPath,
          relativePath: normalizePath(path),
        });
        pushToast('success', 'Opened in default application');
      } catch (e) {
        console.error(e);
        pushToast('error', e instanceof Error ? e.message : 'Could not open file');
      }
    },
    [currentPath, previewRelPath, pushToast],
  );

  const openWithApp = useCallback(
    async (app: string, relPath?: string) => {
      const path = relPath ?? previewRelPath;
      if (!currentPath || !path) return;
      setContextMenu(null);
      if (browserProjectRef.current || !IN_TAURI) {
        pushToast(
          'info',
          `Open with ${app} needs the desktop app (cargo tauri dev)`,
        );
        return;
      }
      try {
        await invoke('open_with_app', {
          root: currentPath,
          relativePath: normalizePath(path),
          app,
        });
        pushToast('success', `Opened with ${app}`);
      } catch (e) {
        console.error(e);
        pushToast(
          'error',
          e instanceof Error
            ? e.message
            : `Could not open with ${app} (is it on PATH?)`,
        );
      }
    },
    [currentPath, previewRelPath, pushToast],
  );

  const pickAppAndOpen = useCallback(
    async (relPath?: string) => {
      const path = relPath ?? previewRelPath;
      if (!currentPath || !path) return;
      setContextMenu(null);
      if (browserProjectRef.current || !IN_TAURI) {
        pushToast(
          'info',
          'Choose program requires the desktop app: cargo tauri dev',
        );
        return;
      }
      try {
        const opened = await invoke<boolean>('pick_app_and_open', {
          root: currentPath,
          relativePath: normalizePath(path),
        });
        if (opened) pushToast('success', 'Opened with selected program');
      } catch (e) {
        console.error(e);
        pushToast('error', e instanceof Error ? e.message : 'Could not open with selected app');
      }
    },
    [currentPath, previewRelPath, pushToast],
  );

  const handleTreeContextMenu = useCallback(
    (e: ReactMouseEvent, path: string, isDir: boolean) => {
      e.preventDefault();
      if (isDir) return;
      setFocusedPath(path);
      setContextMenu({ x: e.clientX, y: e.clientY, path, isDir });
    },
    [],
  );

  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') close();
    };
    window.addEventListener('click', close);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('keydown', onKey);
    };
  }, [contextMenu]);

  const selectRelatedFiles = useCallback(
    async (
      targetPath: string,
      relation: 'imports' | 'importers' | 'tests' | 'all',
    ) => {
      setContextMenu(null);
      if (!currentPath || !IN_TAURI || browserProjectRef.current) {
        pushToast('info', 'Dependency graph resolution requires the desktop app');
        return;
      }
      try {
        const rel = await invoke<RelatedFiles>('resolve_related_files', {
          path: currentPath,
          targetFile: normalizePath(targetPath),
          revision: workspaceRevision.current,
        });
        const extra =
          relation === 'imports'
            ? rel.imports
            : relation === 'importers'
              ? rel.importers
              : relation === 'tests'
                ? rel.tests
                : Array.from(new Set([...rel.imports, ...rel.importers, ...rel.tests]));
        const toSelect = new Set(
          [targetPath, ...extra].map((p) => normalizePath(p)),
        );
        const updated = nodes.map((n) =>
          !n.is_dir && toSelect.has(normalizePath(n.path))
            ? { ...n, selected: true }
            : n,
        );
        setNodes(updated);
        generate(updated, currentPath, format, true);
        const fileName = targetPath.split('/').pop() ?? targetPath;
        pushToast(
          'success',
          relation === 'all'
            ? extra.length > 0
              ? `Selected ${fileName} + ${extra.length} related files (${rel.imports.length} imports, ${rel.importers.length} importers, ${rel.tests.length} tests)`
              : `Selected ${fileName} (no related files found)`
            : extra.length > 0
              ? `Selected ${fileName} + ${extra.length} ${relation}`
              : `Selected ${fileName} (no matching ${relation} found)`,
        );
      } catch (e) {
        pushToast('error', `Dependency lookup failed: ${String(e)}`);
      }
    },
    [currentPath, nodes, format, generate, pushToast, workspaceRevision],
  );

  return {
    filePreview,
    previewLoading,
    previewError,
    previewRelPath,
    contextMenu,
    setContextMenu,
    openFilePreview,
    openInDefaultApp,
    openWithApp,
    pickAppAndOpen,
    handleTreeContextMenu,
    selectRelatedFiles,
    setFilePreview,
    setPreviewRelPath,
    setPreviewError,
  };
}
