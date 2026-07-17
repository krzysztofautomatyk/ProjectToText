import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from 'react';
import { invoke } from '@tauri-apps/api/core';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import {
  Check,
  Copy,
  ExternalLink,
  File,
  FileCode2,
  FileText,
  Folder,
  FolderOpen,
  Info,
  List,
  Loader2,
  Monitor,
  Moon,
  RefreshCw,
  Save,
  Search,
  Sun,
  X,
  AlertCircle,
  CheckCircle2,
} from 'lucide-react';
import FileViewer, { type FilePreviewData } from './FileViewer';
import {
  downloadText,
  generateBrowserOutput,
  pickDirectoryWithInput,
  pickDirectoryWithPicker,
  readBrowserFilePreview,
  scanDirectoryHandle,
  scanFileList,
  type BrowserProject,
} from './browserFs';
import { isTauriRuntime } from './tauriEnv';
import './index.css';

const IN_TAURI = isTauriRuntime();

/* ─── Types ──────────────────────────────────────────── */

interface FileNode {
  path: string;
  name: string;
  is_dir: boolean;
  size?: number;
  selected: boolean;
}

interface PackOptions {
  format: string;
  include_summary: boolean;
  relative_paths: boolean;
  max_file_size?: number;
}

interface TreeNode {
  name: string;
  path: string;
  isDir: boolean;
  size?: number;
  selected: boolean;
  children: TreeNode[];
}

type OutputFormat = 'xml' | 'markdown' | 'json' | 'plain';
type ViewMode = 'packed' | 'list' | 'file';
type ListFormat = 'tree' | 'paths';
type SelectionPreset = 'source' | 'docs' | 'all';
type ToastKind = 'success' | 'error' | 'info';

interface ContextMenuState {
  x: number;
  y: number;
  path: string;
  isDir: boolean;
}

interface ToastItem {
  id: number;
  kind: ToastKind;
  message: string;
}

/* ─── Constants ──────────────────────────────────────── */

const JUNK_DIRS = [
  'node_modules',
  'dist',
  '.vite',
  'build',
  'out',
  'target',
  '.git',
  'bin',
  'obj',
  '.next',
  'coverage',
  '__pycache__',
  '.turbo',
  '.cache',
  'vendor',
];

const SOURCE_EXTS = [
  // Web / JS
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.vue',
  '.svelte',
  // Systems / general
  '.rs',
  '.go',
  '.py',
  '.java',
  '.cpp',
  '.c',
  '.h',
  '.hpp',
  // .NET / XAML / WPF / MAUI / Blazor
  '.cs',
  '.fs',
  '.fsx',
  '.fsi',
  '.vb',
  '.xaml',
  '.axaml',
  '.razor',
  '.cshtml',
  '.csproj',
  '.fsproj',
  '.vbproj',
  '.sln',
  '.props',
  '.targets',
  '.resx',
  '.editorconfig',
  // Config / markup / styles
  '.md',
  '.txt',
  '.json',
  '.jsonc',
  '.toml',
  '.yaml',
  '.yml',
  '.xml',
  '.css',
  '.scss',
  '.html',
  '.sql',
  '.sh',
  '.ps1',
  '.rb',
  '.kt',
  '.swift',
];

/** Extensions that are source even when nested (e.g. MainWindow.xaml.cs). */
function isSourcePath(path: string): boolean {
  const lower = path.toLowerCase().replace(/\\/g, '/');
  if (SOURCE_EXTS.some((ext) => lower.endsWith(ext))) return true;
  // Double extensions used heavily in .NET
  if (lower.endsWith('.xaml.cs') || lower.endsWith('.razor.cs') || lower.endsWith('.designer.cs')) {
    return true;
  }
  return false;
}

const DOC_EXTS = ['.md', '.txt', '.rst', '.adoc'];

const TOKEN_SOFT = 80_000;
const TOKEN_HARD = 150_000;

const isMac =
  typeof navigator !== 'undefined' &&
  /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent);

const TREE_WIDTH_KEY = 'ptt.treeWidth';
const THEME_KEY = 'ptt.theme';

type ThemePref = 'light' | 'dark' | 'system';
type ResolvedTheme = 'light' | 'dark';

/* ─── Helpers ────────────────────────────────────────── */

function normalizePath(p: string): string {
  return p.replace(/\\/g, '/');
}

function readThemePref(): ThemePref {
  try {
    const raw = localStorage.getItem(THEME_KEY);
    if (raw === 'light' || raw === 'dark' || raw === 'system') return raw;
  } catch {
    /* ignore */
  }
  return 'system';
}

function resolveTheme(pref: ThemePref): ResolvedTheme {
  if (pref === 'system') {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  return pref;
}

function applyTheme(pref: ThemePref) {
  const resolved = resolveTheme(pref);
  document.documentElement.setAttribute('data-theme', resolved);
  document.documentElement.setAttribute('data-theme-pref', pref);
  try {
    localStorage.setItem(THEME_KEY, pref);
  } catch {
    /* ignore */
  }
  return resolved;
}

function nextThemePref(current: ThemePref): ThemePref {
  // GitHub-style cycle: light → dark → system → light
  if (current === 'light') return 'dark';
  if (current === 'dark') return 'system';
  return 'light';
}

function themeLabel(pref: ThemePref): string {
  if (pref === 'light') return 'Light';
  if (pref === 'dark') return 'Dark';
  return 'System';
}

function formatBytes(size?: number): string {
  if (size == null || size <= 0) return '';
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(size < 10_240 ? 1 : 0)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `${Math.round(n / 1000)}k`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function estimateTokens(text: string): number {
  return Math.round(text.length / 3.8);
}

function isJunkPath(path: string): boolean {
  const lower = normalizePath(path).toLowerCase();
  return JUNK_DIRS.some(
    (d) =>
      lower.includes(`/${d}/`) ||
      lower.startsWith(`${d}/`) ||
      lower.endsWith(`/${d}`) ||
      lower === d,
  );
}

function applyPreset(nodes: FileNode[], preset: SelectionPreset): FileNode[] {
  return nodes.map((n) => {
    if (n.is_dir) return { ...n, selected: false };
    const lower = n.path.toLowerCase();
    const junk = isJunkPath(n.path);

    if (preset === 'all') {
      return { ...n, selected: !junk };
    }
    if (preset === 'docs') {
      const isDoc = DOC_EXTS.some((ext) => lower.endsWith(ext));
      return { ...n, selected: (isSourcePath(n.path) || isDoc) && !junk };
    }
    // source (default) — includes .xaml, .csproj, Blazor, etc.
    return { ...n, selected: isSourcePath(n.path) && !junk };
  });
}

function generateFileList(nodes: FileNode[]): string {
  const selectedFiles = nodes
    .filter((n) => n.selected && !n.is_dir)
    .map((n) => n.path)
    .sort();

  if (selectedFiles.length === 0) return '';

  interface PathTree {
    [key: string]: PathTree | null;
  }
  const tree: PathTree = {};

  selectedFiles.forEach((path) => {
    const parts = path.split(/[/\\]/).filter(Boolean);
    let current: PathTree = tree;
    parts.forEach((part, i) => {
      if (i === parts.length - 1) {
        current[part] = null;
      } else {
        if (!current[part] || current[part] === null) current[part] = {};
        current = current[part] as PathTree;
      }
    });
  });

  function buildTree(obj: PathTree, prefix = ''): string {
    const entries = Object.keys(obj).sort();
    return entries
      .map((key, idx) => {
        const isLast = idx === entries.length - 1;
        const connector = isLast ? '└── ' : '├── ';
        const value = obj[key];
        if (value === null) {
          return prefix + connector + key;
        }
        return (
          prefix +
          connector +
          key +
          '\n' +
          buildTree(value, prefix + (isLast ? '    ' : '│   '))
        );
      })
      .join('\n');
  }

  return buildTree(tree);
}

function generatePathsList(nodes: FileNode[]): string {
  return nodes
    .filter((n) => n.selected && !n.is_dir)
    .map((n) => n.path)
    .sort()
    .join('\n');
}

function buildFileTree(flatNodes: FileNode[]): TreeNode {
  const root: TreeNode = {
    name: '',
    path: '',
    isDir: true,
    selected: false,
    children: [],
  };

  const sorted = [...flatNodes].sort((a, b) => a.path.localeCompare(b.path));

  for (const node of sorted) {
    const parts = node.path.split(/[/\\]/).filter(Boolean);
    let current = root;
    let currentPath = '';

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      currentPath = currentPath ? `${currentPath}/${part}` : part;

      let child = current.children.find((c) => c.name === part);
      if (!child) {
        child = {
          name: part,
          path: currentPath,
          isDir: i < parts.length - 1 || node.is_dir,
          size: i === parts.length - 1 ? node.size : undefined,
          selected: i === parts.length - 1 ? node.selected : false,
          children: [],
        };
        current.children.push(child);
      } else if (i === parts.length - 1) {
        child.selected = node.selected;
        child.size = node.size;
        child.isDir = node.is_dir;
      }
      current = child;
    }
  }

  function sortChildren(node: TreeNode) {
    node.children.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    node.children.forEach(sortChildren);
  }
  sortChildren(root);
  return root;
}

function computeSubtree(
  node: TreeNode,
  selectedSet: Set<string>,
): { selected: number; total: number; partial: boolean; allSelected: boolean } {
  if (!node.isDir) {
    const sel = selectedSet.has(node.path);
    return { selected: sel ? 1 : 0, total: 1, partial: false, allSelected: sel };
  }

  let selected = 0;
  let total = 0;
  let allSelected = true;
  let anySelected = false;

  for (const child of node.children) {
    const res = computeSubtree(child, selectedSet);
    selected += res.selected;
    total += res.total;
    if (!res.allSelected) allSelected = false;
    if (res.selected > 0) anySelected = true;
  }

  if (total === 0) {
    return { selected: 0, total: 0, partial: false, allSelected: false };
  }

  return {
    selected,
    total,
    partial: anySelected && !allSelected,
    allSelected,
  };
}

function highlightMatch(text: string, query: string): ReactNode {
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

function filterTree(node: TreeNode, query: string): TreeNode | null {
  const q = query.trim().toLowerCase();
  if (!q) return node;

  if (!node.isDir) {
    return node.path.toLowerCase().includes(q) || node.name.toLowerCase().includes(q)
      ? node
      : null;
  }

  const children = node.children
    .map((c) => filterTree(c, query))
    .filter((c): c is TreeNode => c !== null);

  const selfMatch =
    node.path.toLowerCase().includes(q) || node.name.toLowerCase().includes(q);

  if (children.length === 0 && !selfMatch) return null;

  return { ...node, children };
}

function collectDirPaths(node: TreeNode, into: string[] = []): string[] {
  if (node.isDir && node.path) into.push(node.path);
  node.children.forEach((c) => collectDirPaths(c, into));
  return into;
}

function collectFilePaths(node: TreeNode, into: string[] = []): string[] {
  if (!node.isDir && node.path) into.push(node.path);
  node.children.forEach((c) => collectFilePaths(c, into));
  return into;
}

function readStoredFormat(): OutputFormat {
  try {
    const raw = localStorage.getItem('ptt.format');
    if (raw === 'xml' || raw === 'markdown' || raw === 'json' || raw === 'plain') return raw;
  } catch {
    /* ignore */
  }
  return 'xml';
}

function tokenBadgeClass(tokens: number): string {
  if (tokens >= TOKEN_HARD) return 'badge badge-hot';
  if (tokens >= TOKEN_SOFT) return 'badge badge-warn';
  return 'badge badge-ready';
}

/* ─── Small components ───────────────────────────────── */

function ToastViewport({
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

function TreeItem({
  node,
  depth,
  expanded,
  selectedSet,
  filterText,
  onToggleExpand,
  onToggleSelect,
  onFocusPath,
  onOpenFile,
  onContextMenu,
  focusedPath,
  previewPath,
}: {
  node: TreeNode;
  depth: number;
  expanded: Set<string>;
  selectedSet: Set<string>;
  filterText: string;
  onToggleExpand: (path: string) => void;
  onToggleSelect: (path: string, isDir: boolean) => void;
  onFocusPath: (path: string) => void;
  onOpenFile: (path: string) => void;
  onContextMenu: (e: ReactMouseEvent, path: string, isDir: boolean) => void;
  focusedPath: string | null;
  previewPath: string | null;
}) {
  const checkRef = useRef<HTMLInputElement>(null);
  const hasChildren = node.children.length > 0;
  const isExpanded = expanded.has(node.path) || (depth < 1 && !filterText);
  // When filtering, auto-expand matched branches
  const showChildren = hasChildren && (isExpanded || !!filterText.trim());

  const subtree = useMemo(
    () => computeSubtree(node, selectedSet),
    [node, selectedSet],
  );

  const isSelected = node.isDir
    ? subtree.allSelected && subtree.total > 0
    : selectedSet.has(node.path);
  const isPartial = node.isDir && subtree.partial;
  const isPreviewing = !node.isDir && previewPath === node.path;

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
    <div role={node.isDir ? 'group' : undefined}>
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
        style={{ paddingLeft: `${depth * 14 + 4}px` } as CSSProperties}
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

        {!node.isDir && node.size != null && node.size > 0 && (
          <span className="tree-size">{formatBytes(node.size)}</span>
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

      {hasChildren && showChildren && (
        <div role="group">
          {node.children.map((child) => (
            <TreeItem
              key={child.path}
              node={child}
              depth={depth + 1}
              expanded={expanded}
              selectedSet={selectedSet}
              filterText={filterText}
              onToggleExpand={onToggleExpand}
              onToggleSelect={onToggleSelect}
              onFocusPath={onFocusPath}
              onOpenFile={onOpenFile}
              onContextMenu={onContextMenu}
              focusedPath={focusedPath}
              previewPath={previewPath}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/* ─── App ────────────────────────────────────────────── */

function App() {
  const [currentPath, setCurrentPath] = useState('');
  const [nodes, setNodes] = useState<FileNode[]>([]);
  const [output, setOutput] = useState('');
  const [format, setFormat] = useState<OutputFormat>(() => readStoredFormat());
  const [scanning, setScanning] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [stats, setStats] = useState({ files: 0, tokens: 0 });
  const [view, setView] = useState<ViewMode>('packed');
  const [listFormat, setListFormat] = useState<ListFormat>('tree');
  const [filterText, setFilterText] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [preset, setPreset] = useState<SelectionPreset>('source');
  const [filePreview, setFilePreview] = useState<FilePreviewData | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewRelPath, setPreviewRelPath] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [treeWidth, setTreeWidth] = useState(() => {
    try {
      const raw = localStorage.getItem(TREE_WIDTH_KEY);
      const n = raw ? Number(raw) : 340;
      return Number.isFinite(n) ? Math.min(Math.max(n, 220), 720) : 340;
    } catch {
      return 340;
    }
  });
  const [resizing, setResizing] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [focusedPath, setFocusedPath] = useState<string | null>(null);
  const [showHelp, setShowHelp] = useState(false);
  const [themePref, setThemePref] = useState<ThemePref>(() => readThemePref());
  const [resolvedTheme, setResolvedTheme] = useState<ResolvedTheme>(() =>
    resolveTheme(readThemePref()),
  );

  const filterRef = useRef<HTMLInputElement>(null);
  const toastId = useRef(0);
  const genSeq = useRef(0);
  const hasLoadedOnce = useRef(false);
  const generateTimer = useRef<number | null>(null);
  /** Browser-mode project (files in memory). Null in Tauri desktop mode. */
  const browserProjectRef = useRef<BrowserProject | null>(null);
  const [browserMode, setBrowserMode] = useState(!IN_TAURI);

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

  const fileListText = useMemo(
    () => (listFormat === 'tree' ? generateFileList(nodes) : generatePathsList(nodes)),
    [nodes, listFormat],
  );

  const totalFiles = useMemo(() => nodes.filter((n) => !n.is_dir).length, [nodes]);

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

  /* ─── Generate ─────────────────────────────────────── */

  const generateNow = useCallback(
    async (
      currentNodes: FileNode[],
      rootPath: string,
      fmt: OutputFormat,
    ) => {
      const sel = currentNodes
        .filter((n) => n.selected && !n.is_dir)
        .map((n) => normalizePath(n.path));
      if (sel.length === 0 || !rootPath) {
        setOutput('');
        setStats({ files: 0, tokens: 0 });
        setGenerating(false);
        return;
      }

      const seq = ++genSeq.current;
      setGenerating(true);
      try {
        let result: string;
        const browserProject = browserProjectRef.current;
        if (browserProject) {
          result = await generateBrowserOutput(browserProject, sel, fmt);
        } else {
          const opts: PackOptions = {
            format: fmt,
            include_summary: true,
            relative_paths: true,
          };
          result = await invoke<string>('generate_output', {
            path: rootPath,
            selectedPaths: sel,
            options: opts,
          });
        }
        if (seq !== genSeq.current) return;
        setOutput(result);
        setStats({ files: sel.length, tokens: estimateTokens(result) });
        hasLoadedOnce.current = true;
      } catch (e) {
        if (seq !== genSeq.current) return;
        console.error(e);
        pushToast('error', 'Failed to generate packed output');
      } finally {
        if (seq === genSeq.current) setGenerating(false);
      }
    },
    [pushToast],
  );

  /** Immediate generate (scan/format) or debounced (rapid selection toggles). */
  const generate = useCallback(
    (
      currentNodes: FileNode[],
      rootPath: string,
      fmt: OutputFormat,
      immediate = false,
    ) => {
      if (generateTimer.current != null) {
        window.clearTimeout(generateTimer.current);
        generateTimer.current = null;
      }
      if (immediate) {
        void generateNow(currentNodes, rootPath, fmt);
        return;
      }
      setGenerating(true);
      generateTimer.current = window.setTimeout(() => {
        generateTimer.current = null;
        void generateNow(currentNodes, rootPath, fmt);
      }, 180);
    },
    [generateNow],
  );

  const applyScanResult = useCallback(
    async (
      result: FileNode[],
      pathLabel: string,
      nextPreset: SelectionPreset,
      fromBrowser: boolean,
    ) => {
      const withSelection = applyPreset(result, nextPreset);
      setNodes(withSelection);
      setCurrentPath(pathLabel);
      setBrowserMode(fromBrowser);
      setFilterText('');
      setFilePreview(null);
      setPreviewRelPath(null);
      setPreviewError(null);
      setContextMenu(null);

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
      await generateNow(withSelection, pathLabel, format);
    },
    [format, generateNow],
  );

  const scan = useCallback(
    async (path: string, nextPreset: SelectionPreset = preset) => {
      if (!IN_TAURI || browserProjectRef.current) {
        pushToast(
          'info',
          'In browser mode use Open to pick the folder again (native path refresh needs the desktop app).',
        );
        return;
      }
      setScanning(true);
      setGenerating(true);
      try {
        browserProjectRef.current = null;
        const result = await invoke<FileNode[]>('scan_folder', { path });
        await applyScanResult(result, path, nextPreset, false);
      } catch (e) {
        console.error(e);
        pushToast('error', 'Failed to scan folder');
        setGenerating(false);
      } finally {
        setScanning(false);
      }
    },
    [preset, applyScanResult, pushToast],
  );

  const openFolderBrowser = useCallback(async () => {
    setScanning(true);
    setGenerating(true);
    try {
      // Prefer modern directory picker (Chrome, Edge, Opera)
      try {
        const handle = await pickDirectoryWithPicker();
        const { nodes, project } = await scanDirectoryHandle(handle);
        browserProjectRef.current = project;
        await applyScanResult(nodes, project.rootName, preset, true);
        pushToast('info', 'Browser mode — packing works here; Open with apps needs desktop app');
        return;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        // User cancelled picker
        if (msg.includes('abort') || msg.includes('AbortError') || msg.includes('canceled')) {
          return;
        }
        if (msg !== 'SHOW_DIRECTORY_PICKER_UNSUPPORTED') {
          // Permission denied etc. — try input fallback
          console.warn('showDirectoryPicker failed, trying input fallback', e);
        }
      }

      // Fallback: <input webkitdirectory> (Firefox / Safari / older browsers)
      pushToast('info', 'Select a folder in the file dialog…');
      const list = await pickDirectoryWithInput();
      const { nodes, project } = scanFileList(list);
      browserProjectRef.current = project;
      await applyScanResult(nodes, project.rootName, preset, true);
      pushToast('info', 'Browser mode — packing works; use cargo tauri dev for full desktop features');
    } catch (e) {
      console.error(e);
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes('No folder')) return;
      pushToast(
        'error',
        'Could not open folder in the browser. Prefer Chrome/Edge, or run: cargo tauri dev',
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
      if (selected) {
        const path = Array.isArray(selected) ? selected[0] : selected;
        if (path) {
          browserProjectRef.current = null;
          await scan(path);
        }
      }
    } catch (e) {
      console.error(e);
      // If Tauri dialog fails (misconfigured), fall back to browser picker inside webview
      pushToast('info', 'Native dialog failed — trying browser folder picker…');
      await openFolderBrowser();
    }
  }, [scan, openFolderBrowser, pushToast]);

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

  /* ─── Selection ────────────────────────────────────── */

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
        }
        return updated;
      });
    },
    [currentPath, format, generate],
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
    if (currentPath) generate(updated, currentPath, format, true);
  }, [nodes, currentPath, format, generate, filterText, filteredTree]);

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
    if (remaining === 0) {
      setOutput('');
      setStats({ files: 0, tokens: 0 });
      setGenerating(false);
    } else if (currentPath) {
      generate(updated, currentPath, format, true);
    }
  }, [nodes, filterText, filteredTree, currentPath, format, generate]);

  const applySelectionPreset = useCallback(
    (next: SelectionPreset) => {
      setPreset(next);
      if (nodes.length === 0) return;
      const updated = applyPreset(nodes, next);
      setNodes(updated);
      if (currentPath) generate(updated, currentPath, format, true);
      const labels: Record<SelectionPreset, string> = {
        source: 'Source files selected',
        docs: 'Source + docs selected',
        all: 'All non-junk files selected',
      };
      pushToast('info', labels[next]);
    },
    [nodes, currentPath, format, generate, pushToast],
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

  // Persist splitter width
  useEffect(() => {
    if (resizing) return;
    try {
      localStorage.setItem(TREE_WIDTH_KEY, String(treeWidth));
    } catch {
      /* ignore */
    }
  }, [treeWidth, resizing]);

  // Theme: apply + follow system when pref is "system"
  useEffect(() => {
    setResolvedTheme(applyTheme(themePref));
  }, [themePref]);

  useEffect(() => {
    if (themePref !== 'system') return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => setResolvedTheme(applyTheme('system'));
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [themePref]);

  const cycleTheme = useCallback(() => {
    setThemePref((prev) => {
      const next = nextThemePref(prev);
      // Subtle confirmation — world-class tools always acknowledge preference changes
      window.setTimeout(() => {
        pushToast(
          'info',
          next === 'system'
            ? `Theme: System (${resolveTheme('system')})`
            : `Theme: ${themeLabel(next)}`,
        );
      }, 0);
      return next;
    });
  }, [pushToast]);

  // Cleanup debounce on unmount
  useEffect(() => {
    return () => {
      if (generateTimer.current != null) window.clearTimeout(generateTimer.current);
    };
  }, []);

  // Focus management for help dialog
  useEffect(() => {
    if (!showHelp) return;
    const id = window.setTimeout(() => {
      document.querySelector<HTMLElement>('.help-card button')?.focus();
    }, 0);
    return () => window.clearTimeout(id);
  }, [showHelp]);

  /* ─── Copy / Save ──────────────────────────────────── */

  const handleCopy = useCallback(async () => {
    if (!output) return;
    try {
      await navigator.clipboard.writeText(output);
      pushToast(
        'success',
        `Copied ${stats.files} files · ~${formatTokens(stats.tokens)} tokens`,
      );
    } catch {
      try {
        await invoke('copy_to_clipboard', { text: output });
        pushToast('success', 'Copied to clipboard');
      } catch {
        pushToast('error', 'Could not copy to clipboard');
      }
    }
  }, [output, stats, pushToast]);

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

  const handleSave = useCallback(async () => {
    if (!output) return;
    const name =
      format === 'xml'
        ? 'project.xml'
        : format === 'markdown'
          ? 'project.md'
          : format === 'json'
            ? 'project.json'
            : 'project.txt';
    if (browserProjectRef.current || !IN_TAURI) {
      downloadText(name, output);
      pushToast('success', `Downloaded ${name}`);
      return;
    }
    try {
      const saved = await invoke<boolean>('save_to_file', {
        text: output,
        defaultName: name,
      });
      if (saved) pushToast('success', 'Saved packed output');
    } catch (e) {
      console.error(e);
      // Last resort: download in webview
      try {
        downloadText(name, output);
        pushToast('success', `Downloaded ${name}`);
      } catch {
        pushToast('error', 'Failed to save file');
      }
    }
  }, [output, format, pushToast]);

  /* ─── Keyboard shortcuts ───────────────────────────── */

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const meta = isMac ? e.metaKey : e.ctrlKey;
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
  ]);

  /* ─── Resizable panel ──────────────────────────────── */

  useEffect(() => {
    if (!resizing) return;

    const onMove = (e: MouseEvent) => {
      const next = Math.min(Math.max(e.clientX, 220), window.innerWidth * 0.55);
      setTreeWidth(next);
    };
    const onUp = () => setResizing(false);

    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [resizing]);

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
      return (
        <span className={tokenBadgeClass(stats.tokens)} title="Approximate token count">
          <Check size={11} /> ready · ~{formatTokens(stats.tokens)} tokens
        </span>
      );
    }
    return null;
  })();

  return (
    <div
      className={`app-container${dragOver ? ' drag-over' : ''}`}
      style={{ ['--tree-width' as string]: `${treeWidth}px` }}
    >
      {/* Header */}
      <header className="header">
        <div className="header-left">
          <div className="brand" title="ProjectToText">
            <div className="brand-mark" aria-hidden>
              ptt
            </div>
            <div className="brand-text">
              <span className="brand-name">ProjectToText</span>
              <span className="brand-tag">Pack projects for LLMs</span>
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

          <div className="toolbar-sep" />

          <button type="button" onClick={() => void openFolder()} className="btn" title={`Open folder (${isMac ? '⌘' : 'Ctrl'}O)`}>
            <FolderOpen size={15} /> Open
            <span className="kbd">{isMac ? '⌘O' : '⌃O'}</span>
          </button>

          <button
            type="button"
            onClick={() => currentPath && void scan(currentPath)}
            className="btn"
            disabled={!currentPath || scanning}
            title={`Refresh (${isMac ? '⌘' : 'Ctrl'}R)`}
          >
            <RefreshCw size={15} className={scanning ? 'spin' : ''} /> Refresh
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
                  : `Copy packed content (${isMac ? '⌘' : 'Ctrl'}C)`
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
              title={`Save (${isMac ? '⌘' : 'Ctrl'}S)`}
              aria-label="Save packed output"
            >
              <Save size={15} />
            </button>
          </div>
        </div>
      </header>

      {browserMode && (
        <div className="browser-mode-banner" role="status">
          <Info size={13} aria-hidden />
          <span>
            <strong>Browser mode</strong> — folder dialog works here, but for native
            dialogs and “Open with VS Code / Notepad++” run{' '}
            <code>cargo tauri dev</code> (desktop app), not only the Vite URL.
          </span>
        </div>
      )}

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
        </div>

        <div className="toolbar-spacer" />

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
              </div>
            )}
          </div>

          <div className="file-tree" role="tree" aria-label="File tree">
            {scanning && !fileTree.children.length ? (
              <div className="loading-center">
                <div className="title">
                  <Loader2 size={18} className="spin icon-accent" /> Scanning…
                </div>
                <div className="sub">Respecting .gitignore</div>
              </div>
            ) : filteredTree && filteredTree.children.length > 0 ? (
              filteredTree.children.map((child) => (
                <TreeItem
                  key={child.path}
                  node={child}
                  depth={0}
                  expanded={expanded}
                  selectedSet={selectedSet}
                  filterText={filterText}
                  onToggleExpand={toggleExpand}
                  onToggleSelect={toggleSelect}
                  onFocusPath={setFocusedPath}
                  onOpenFile={(p) => void openFilePreview(p)}
                  onContextMenu={handleTreeContextMenu}
                  focusedPath={focusedPath}
                  previewPath={previewRelPath}
                />
              ))
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
              <div className="empty-state">
                <div className="empty-icon">
                  <FolderOpen size={26} />
                </div>
                <div className="empty-title">Open a project</div>
                <div className="empty-desc">
                  Drop a folder here or open one. We respect your{' '}
                  <strong className="text-emphasis">.gitignore</strong> exactly
                  like Git.
                </div>
                <button type="button" className="btn btn-primary" onClick={() => void openFolder()}>
                  <FolderOpen size={15} /> Open folder
                </button>
                <div className="empty-hints">
                  <span className="hint-chip">
                    <span className="kbd">{isMac ? '⌘O' : '⌃O'}</span> Open
                  </span>
                  <span className="hint-chip">
                    <span className="kbd">{isMac ? '⌘F' : '⌃F'}</span> Filter
                  </span>
                  <span className="hint-chip">
                    <span className="kbd">{isMac ? '⌘C' : '⌃C'}</span> Copy
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
                <pre className="output-text">{output}</pre>
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

      {contextMenu && (
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
        </div>
      )}

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
                    ? 'Large pack — may exceed smaller model windows'
                    : 'Approximate token estimate'
              }
            >
              ~
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
              tokens
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
        </div>
      </footer>

      {showHelp && (
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
                  <span className="kbd">{isMac ? '⌘O' : 'Ctrl O'}</span>
                </dt>
                <dd>Open folder</dd>
              </div>
              <div>
                <dt>
                  <span className="kbd">{isMac ? '⌘R' : 'Ctrl R'}</span>
                </dt>
                <dd>Refresh project</dd>
              </div>
              <div>
                <dt>
                  <span className="kbd">{isMac ? '⌘F' : 'Ctrl F'}</span>
                </dt>
                <dd>Focus filter</dd>
              </div>
              <div>
                <dt>
                  <span className="kbd">{isMac ? '⌘C' : 'Ctrl C'}</span>
                </dt>
                <dd>Copy packed output (or file list)</dd>
              </div>
              <div>
                <dt>
                  <span className="kbd">{isMac ? '⌘S' : 'Ctrl S'}</span>
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
      )}

      <ToastViewport toasts={toasts} onDismiss={dismissToast} />

      <div className="sr-only" aria-live="polite" aria-atomic="true">
        {generating
          ? 'Updating packed output'
          : output
            ? `Ready. ${stats.files} files, about ${formatTokens(stats.tokens)} tokens.`
            : ''}
      </div>
    </div>
  );
}

export default App;
