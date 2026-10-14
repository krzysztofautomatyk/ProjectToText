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
import { listen } from '@tauri-apps/api/event';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { check, type Update } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
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
  GitBranch,
  History as HistoryIcon,
  Info,
  List,
  Loader2,
  Monitor,
  Moon,
  Pin,
  PinOff,
  RefreshCw,
  Save,
  Search,
  Shield,
  SlidersHorizontal,
  Sparkles,
  MessageSquare,
  Download,
  Upload,
  Star,
  Sun,
  Trash2,
  X,
  AlertCircle,
  CheckCircle2,
} from 'lucide-react';
import FileViewer, { type FilePreviewData } from './FileViewer';
import {
  CANONICAL_JUNK_DIRS,
  downloadText,
  generateBrowserOutputWithStats,
  isCancelledError,
  pickDirectoryWithInput,
  pickDirectoryWithPicker,
  readBrowserFilePreview,
  scanDirectoryHandle,
  scanFileList,
  UserCancelledError,
  type BrowserProject,
} from './browserFs';
import { redactSecretsWithReport, type RedactionSummary } from './secrets';
import {
  folderHistoryKey,
  readFolderHistory,
  rememberFolder,
  removeFolder,
  setFolderPinned,
  writeFolderHistory,
  type FolderHistoryEntry,
} from './folderHistory';
import {
  applyDeselectDelta,
  clearDeselectPaths,
  projectPrefKey,
  readProjectPrefs,
  rememberProject,
  removeProject,
  setProjectFavorite,
  setProjectNote,
  writeProjectPrefs,
  type ProjectPref,
} from './projectPrefs';
import {
  buildPrefSnapshot,
  mergePrefSnapshot,
  parsePrefSnapshot,
  snapshotFileName,
} from './prefTransfer';
import APP_VERSION from './version';
import { isTauriRuntime } from './tauriEnv';
import { formatShortcut, isModKey } from './platform';
import './index.css';

const IN_TAURI = isTauriRuntime();

/* ─── Types ──────────────────────────────────────────── */

interface FileNode {
  path: string;
  name: string;
  is_dir: boolean;
  size?: number;
  selected: boolean;
  git_status?: string;
}

interface GitRepoContext {
  isGitRepo: boolean;
  currentBranch?: string | null;
  baseBranch?: string | null;
  fileStatuses: Record<string, string>;
  modifiedFiles: string[];
  branchChangedFiles: string[];
  recentCommits: string[];
}

interface ScanResult {
  root: string;
  revision: number;
  nodes: FileNode[];
  junkDirs?: string[];
  gitContext?: GitRepoContext;
}

interface PackOptions {
  format: string;
  include_summary: boolean;
  max_file_size?: number;
  redact_secrets?: boolean;
  full_preview?: boolean;
  skeleton_files?: string[];
  include_git_diff?: boolean;
  task_prompt?: string;
  tokenizer_model?: string;
}

interface FileTokenStat {
  path: string;
  bytes: number;
  tokens: number;
  mode: 'full' | 'skeleton';
}

interface GenerateOutputResponse {
  preview: string;
  truncatedPreview: boolean;
  totalBytes: number;
  totalChars: number;
  totalTokens: number;
  filesPacked: number;
  fileTokens?: FileTokenStat[];
  redactions: RedactionSummary;
}

interface RelatedFiles {
  target: string;
  imports: string[];
  importers: string[];
  tests: string[];
}

interface TreeNode {
  name: string;
  path: string;
  isDir: boolean;
  size?: number;
  selected: boolean;
  gitStatus?: string;
  children: TreeNode[];
}

interface VisibleTreeRow {
  node: TreeNode;
  depth: number;
  hasChildren: boolean;
  showChildren: boolean;
}

type OutputFormat = 'xml' | 'markdown' | 'json' | 'plain';
type ViewMode = 'packed' | 'list' | 'file';
type ListFormat = 'tree' | 'paths';
type SelectionPreset = 'source' | 'docs' | 'all' | 'core_skeleton';
type ToastKind = 'success' | 'error' | 'info';
type BudgetPreset = '32k' | '64k' | '128k' | '200k' | '1m' | 'custom';

const BUDGET_LIMITS: Record<Exclude<BudgetPreset, 'custom'>, number> = {
  '32k': 32_000,
  '64k': 64_000,
  '128k': 128_000,
  '200k': 200_000,
  '1m': 1_000_000,
};

const PROMPT_TEMPLATES: { id: string; label: string; prompt: string }[] = [
  { id: 'none', label: 'No task prompt', prompt: '' },
  {
    id: 'review',
    label: 'Architecture & Code Review',
    prompt:
      'Review the attached project context for architectural soundness, correctness, edge cases, and maintainability. Cite exact file paths and line numbers for every finding and propose concrete, minimal fixes.',
  },
  {
    id: 'bug',
    label: 'Bug Investigation & Root Cause',
    prompt:
      'Investigate the defect described below using the provided project context. Trace the data and control flow, identify the exact root cause, and provide a regression-tested fix.',
  },
  {
    id: 'security',
    label: 'Security & Vulnerability Audit',
    prompt:
      'Perform a thorough security audit of the attached codebase. Check for path traversal, injection, authentication/authorization flaws, unsafe deserialization, and secret exposure. Rate severity and provide remediation diffs.',
  },
  {
    id: 'tests',
    label: 'Write Unit / Integration Tests',
    prompt:
      'Write comprehensive unit and integration tests for the selected modules, covering happy paths, boundary conditions, error handling, and security invariants.',
  },
  {
    id: 'custom',
    label: 'Custom Task Prompt…',
    prompt: '',
  },
];

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

const JUNK_DIRS: readonly string[] = CANONICAL_JUNK_DIRS;

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

const TREE_WIDTH_KEY = 'ptt.treeWidth';
const THEME_KEY = 'ptt.theme';

type ThemePref = 'light' | 'dark' | 'system';
type ResolvedTheme = 'light' | 'dark';

/* ─── Helpers ────────────────────────────────────────── */

function normalizePath(p: string): string {
  return p.replace(/\\/g, '/');
}

/** Unchecks files the user previously excluded in this project's Custom replay list. */
function applySavedDeselects(nodes: FileNode[], deselectPaths: string[]): FileNode[] {
  if (deselectPaths.length === 0) return nodes;
  const excluded = new Set(deselectPaths.map((p) => normalizePath(p)));
  return nodes.map((n) =>
    !n.is_dir && excluded.has(normalizePath(n.path)) ? { ...n, selected: false } : n,
  );
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

/**
 * Approximate token count for UX warnings only.
 * Heuristic: characters ÷ 3.8 (rough code / mixed English average).
 * Not model-specific (not GPT/Claude tokenizer) and not billing-grade.
 */
function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.max(0, Math.round(text.length / 3.8));
}

/** Same heuristic as estimateTokens, applied to a file's byte size (no content read). */
function estimateTokensFromBytes(bytes: number): number {
  return Math.max(0, Math.round(bytes / 3.8));
}

const TOKEN_ESTIMATE_HINT =
  'Approximate only (chars ÷ 3.8). Not a model-specific tokenizer.';

function isJunkPath(path: string, junkDirs: readonly string[] = JUNK_DIRS): boolean {
  const lower = normalizePath(path).toLowerCase();
  return junkDirs.some(
    (d) =>
      lower.includes(`/${d}/`) ||
      lower.startsWith(`${d}/`) ||
      lower.endsWith(`/${d}`) ||
      lower === d,
  );
}

function isLowPriorityPath(path: string): boolean {
  const lower = normalizePath(path).toLowerCase();
  return (
    lower.includes('test') ||
    lower.includes('spec') ||
    lower.includes('fixture') ||
    lower.includes('bench') ||
    lower.includes('example') ||
    lower.endsWith('.lock') ||
    lower.endsWith('-lock.json') ||
    lower.endsWith('.md') ||
    lower.endsWith('.txt')
  );
}

/** Lockfiles and generated manifests: visible in the tree, unchecked by every preset. */
const DEFAULT_EXCLUDED_FILE_NAMES = new Set([
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'Cargo.lock',
  'composer.lock',
  'Gemfile.lock',
  'poetry.lock',
  'uv.lock',
]);
const DEFAULT_EXCLUDED_DIR_PREFIXES = ['gen/schemas/'];

function isDefaultExcludedPath(path: string): boolean {
  const normalized = normalizePath(path);
  const name = normalized.slice(normalized.lastIndexOf('/') + 1);
  return (
    DEFAULT_EXCLUDED_FILE_NAMES.has(name) ||
    DEFAULT_EXCLUDED_DIR_PREFIXES.some((p) => normalized.startsWith(p))
  );
}

function applyPreset(
  nodes: FileNode[],
  preset: SelectionPreset,
  junkDirs: readonly string[] = JUNK_DIRS,
): FileNode[] {
  return nodes.map((n) => {
    if (n.is_dir) return { ...n, selected: false };
    const lower = n.path.toLowerCase();
    const junk = isJunkPath(n.path, junkDirs) || isDefaultExcludedPath(n.path);

    if (preset === 'all') {
      return { ...n, selected: !junk };
    }
    if (preset === 'docs') {
      const isDoc = DOC_EXTS.some((ext) => lower.endsWith(ext));
      return { ...n, selected: (isSourcePath(n.path) || isDoc) && !junk };
    }
    if (preset === 'core_skeleton') {
      return { ...n, selected: isSourcePath(n.path) && !junk };
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

interface BuildTreeNode extends TreeNode {
  childMap?: Map<string, BuildTreeNode>;
}

function buildFileTree(flatNodes: FileNode[]): TreeNode {
  const root: BuildTreeNode = {
    name: '',
    path: '',
    isDir: true,
    selected: false,
    children: [],
    childMap: new Map(),
  };

  for (const node of flatNodes) {
    const parts = node.path.split(/[/\\]/).filter(Boolean);
    let current = root;
    let currentPath = '';

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      currentPath = currentPath ? `${currentPath}/${part}` : part;

      if (!current.childMap) current.childMap = new Map();
      let child = current.childMap.get(part);
      if (!child) {
        child = {
          name: part,
          path: currentPath,
          isDir: i < parts.length - 1 || node.is_dir,
          size: i === parts.length - 1 ? node.size : undefined,
          selected: i === parts.length - 1 ? node.selected : false,
          gitStatus: i === parts.length - 1 ? node.git_status : undefined,
          children: [],
          childMap: new Map(),
        };
        current.childMap.set(part, child);
      } else if (i === parts.length - 1) {
        child.selected = node.selected;
        child.size = node.size;
        child.isDir = node.is_dir;
        child.gitStatus = node.git_status;
      }
      current = child;
    }
  }

  function finalizeAndSort(node: BuildTreeNode) {
    if (node.childMap && node.childMap.size > 0) {
      node.children = Array.from(node.childMap.values());
      node.children.sort((a, b) => {
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
      for (const c of node.children) {
        finalizeAndSort(c as BuildTreeNode);
      }
    }
    delete node.childMap;
  }
  finalizeAndSort(root);
  return root;
}

function sortTreeByTokens(
  node: TreeNode,
  tokenSort: boolean,
  subtreeStats: Map<string, SubtreeStats>,
): TreeNode {
  if (!tokenSort || node.children.length === 0) return node;
  const sortedChildren = [...node.children]
    .sort(
      (a, b) =>
        (subtreeStats.get(b.path)?.tokens ?? 0) - (subtreeStats.get(a.path)?.tokens ?? 0),
    )
    .map((c) => sortTreeByTokens(c, tokenSort, subtreeStats));
  return { ...node, children: sortedChildren };
}

function flattenVisibleTree(
  root: TreeNode | null,
  expanded: Set<string>,
  filterText: string,
): VisibleTreeRow[] {
  if (!root || root.children.length === 0) return [];
  const rows: VisibleTreeRow[] = [];
  const hasFilter = !!filterText.trim();

  function walk(node: TreeNode, depth: number) {
    const hasChildren = node.children.length > 0;
    const showChildren = hasChildren && (expanded.has(node.path) || hasFilter);
    rows.push({ node, depth, hasChildren, showChildren });
    if (showChildren) {
      for (const child of node.children) {
        walk(child, depth + 1);
      }
    }
  }

  for (const child of root.children) {
    walk(child, 0);
  }
  return rows;
}

type SubtreeStats = {
  selected: number;
  total: number;
  partial: boolean;
  allSelected: boolean;
  allSkeleton: boolean;
  /** Estimated tokens of every file in the subtree (selected or not). */
  tokens: number;
};

function computeSubtree(
  node: TreeNode,
  selectedSet: Set<string>,
  skeletonSet: Set<string>,
  stats: Map<string, SubtreeStats>,
): SubtreeStats {
  if (!node.isDir) {
    const sel = selectedSet.has(node.path);
    const skel = skeletonSet.has(node.path);
    const result: SubtreeStats = {
      selected: sel ? 1 : 0,
      total: 1,
      partial: false,
      allSelected: sel,
      allSkeleton: skel,
      tokens: estimateTokensFromBytes(node.size ?? 0),
    };
    stats.set(node.path, result);
    return result;
  }

  let selected = 0;
  let total = 0;
  let allSelected = true;
  let anySelected = false;
  let allSkeleton = true;
  let tokens = 0;

  for (const child of node.children) {
    const res = computeSubtree(child, selectedSet, skeletonSet, stats);
    selected += res.selected;
    total += res.total;
    tokens += res.tokens;
    if (!res.allSelected) allSelected = false;
    if (res.selected > 0) anySelected = true;
    if (!res.allSkeleton) allSkeleton = false;
  }

  const result: SubtreeStats = {
    selected,
    total,
    partial: anySelected && !allSelected,
    allSelected: total > 0 && allSelected,
    allSkeleton: total > 0 && allSkeleton,
    tokens,
  };
  stats.set(node.path, result);
  return result;
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

const ABOUT_REPO_URL = 'https://github.com/krzysztofautomatyk/ProjectToText';
const ABOUT_AUTHOR = 'Krzysztof Wozniczak';
const ABOUT_FRONTEND_LIBS = [
  '@tauri-apps/api',
  '@tauri-apps/plugin-dialog',
  '@tauri-apps/plugin-process',
  '@tauri-apps/plugin-updater',
  'react',
  'react-dom',
  'lucide-react',
  'highlight.js',
];
const ABOUT_BACKEND_LIBS = [
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
];

function AboutDialog({
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

function formatHistoryDate(timestamp: number): string {
  if (!timestamp) return 'Previously opened';
  return `Opened ${new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    year: timestamp > Date.now() - 365 * 24 * 60 * 60 * 1000 ? undefined : 'numeric',
  }).format(timestamp)}`;
}

function CustomProjectsPanel({
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
          <button type="button" className="panel-link" onClick={onExport}>
            <Download size={12} aria-hidden /> Export all
          </button>
          <button type="button" className="panel-link" onClick={onImport}>
            <Upload size={12} aria-hidden /> Import…
          </button>
          <span className="custom-transfer-hint">JSON · merges into existing entries</span>
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

function FolderHistoryPanel({
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

function TreeRow({
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
  const [tokenSort, setTokenSort] = useState(false);
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
  const [showAbout, setShowAbout] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [folderHistory, setFolderHistory] = useState<FolderHistoryEntry[]>(() =>
    IN_TAURI ? readFolderHistory() : [],
  );
  const [showCustom, setShowCustom] = useState(false);
  const [customProjects, setCustomProjects] = useState<ProjectPref[]>(readProjectPrefs);
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
  const workspaceRevision = useRef(0);
  const scanSeq = useRef(0);
  const startupRequested = useRef(false);
  const [fullOutputPreview, setFullOutputPreview] = useState(false);
  const [fullOutputText, setFullOutputText] = useState<string | null>(null);
  const [truncatedPreview, setTruncatedPreview] = useState(false);
  const [totalBytes, setTotalBytes] = useState(0);
  const [redactSecretsEnabled, setRedactSecretsEnabled] = useState(true);
  const [redactionSummary, setRedactionSummary] = useState<RedactionSummary>({
    totalRedactions: 0,
    kinds: [],
  });
  const [skeletonSet, setSkeletonSet] = useState<Set<string>>(new Set());
  const [fileTokens, setFileTokens] = useState<FileTokenStat[]>([]);
  const [budgetPreset, setBudgetPreset] = useState<BudgetPreset>('128k');
  const [customBudget, setCustomBudget] = useState(128_000);
  const [showTopConsumers, setShowTopConsumers] = useState(false);
  const [junkDirs, setJunkDirs] = useState<readonly string[]>(CANONICAL_JUNK_DIRS);
  const [gitContext, setGitContext] = useState<GitRepoContext | null>(null);
  const [includeGitDiff, setIncludeGitDiff] = useState(false);
  const [showPromptStudio, setShowPromptStudio] = useState(false);
  const [promptTemplateId, setPromptTemplateId] = useState('none');
  const [taskPrompt, setTaskPrompt] = useState('');
  const [workspaceChangedOnDisk, setWorkspaceChangedOnDisk] = useState(false);
  const [treeScrollTop, setTreeScrollTop] = useState(0);
  const [treeViewportHeight, setTreeViewportHeight] = useState(600);
  const treeScrollRef = useRef<HTMLDivElement>(null);
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
    })
      .then((fn) => {
        unlisten = fn;
      })
      .catch(() => {
        /* ignore in mock/test environments */
      });
    return () => {
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    const el = treeScrollRef.current;
    if (!el) return;
    const updateHeight = () => {
      setTreeViewportHeight(el.clientHeight || 600);
    };
    updateHeight();
    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(updateHeight);
      ro.observe(el);
      return () => ro.disconnect();
    }
  }, [currentPath]);

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

  const ROW_HEIGHT = 28;
  const OVERSCAN = 15;
  const totalTreeHeight = visibleTreeRows.length * ROW_HEIGHT;
  const startRowIdx = Math.max(0, Math.floor(treeScrollTop / ROW_HEIGHT) - OVERSCAN);
  const endRowIdx = Math.min(
    visibleTreeRows.length,
    Math.ceil((treeScrollTop + treeViewportHeight) / ROW_HEIGHT) + OVERSCAN,
  );
  const virtualSlice = visibleTreeRows.slice(startRowIdx, endRowIdx);

  const targetBudgetTokens =
    budgetPreset === 'custom' ? Math.max(1000, customBudget) : BUDGET_LIMITS[budgetPreset];

  const fileListText = useMemo(
    () => (listFormat === 'tree' ? generateFileList(nodes) : generatePathsList(nodes)),
    [nodes, listFormat],
  );

  const totalFiles = useMemo(() => nodes.filter((n) => !n.is_dir).length, [nodes]);

  const outputBytes = useMemo(
    () => (totalBytes > 0 ? totalBytes : new Blob([output]).size),
    [totalBytes, output],
  );

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

  /* ─── Generate ─────────────────────────────────────── */

  interface GenerateOverrides {
    redact?: boolean;
    skeletons?: Set<string>;
    gitDiff?: boolean;
    prompt?: string;
    fullPreview?: boolean;
  }

  const generateNow = useCallback(
    async (
      currentNodes: FileNode[],
      rootPath: string,
      fmt: OutputFormat,
      overrides: GenerateOverrides = {},
    ) => {
      const seq = ++genSeq.current;
      const sel = currentNodes
        .filter((n) => n.selected && !n.is_dir)
        .map((n) => normalizePath(n.path));
      if (sel.length === 0 || !rootPath) {
        setOutput('');
        setFullOutputText(null);
        setTruncatedPreview(false);
        setTotalBytes(0);
        setRedactionSummary({ totalRedactions: 0, kinds: [] });
        setFileTokens([]);
        setStats({ files: 0, tokens: 0 });
        setGenerating(false);
        return;
      }

      const activeRedact = overrides.redact ?? redactSecretsEnabled;
      const activeSkeletons = overrides.skeletons ?? skeletonSet;
      const activeGitDiff = overrides.gitDiff ?? includeGitDiff;
      const activePrompt = overrides.prompt ?? taskPrompt;
      const wantFullPreview = overrides.fullPreview ?? false;

      setGenerating(true);
      try {
        const browserProject = browserProjectRef.current;
        if (browserProject) {
          const res = await generateBrowserOutputWithStats(browserProject, sel, fmt, {
            redactSecrets: activeRedact,
            skeletonFiles: activeSkeletons,
            taskPrompt: activePrompt,
          });
          if (seq !== genSeq.current) return;
          setOutput(res.text);
          setFullOutputText(res.text);
          setTruncatedPreview(res.text.length > 150_000 && !wantFullPreview);
          setTotalBytes(new Blob([res.text]).size);
          setRedactionSummary(res.redactions);
          setFileTokens(res.fileTokens);
          setFullOutputPreview(wantFullPreview);
          setStats({ files: sel.length, tokens: estimateTokens(res.text) });
          hasLoadedOnce.current = true;
        } else {
          const opts: PackOptions = {
            format: fmt,
            include_summary: true,
            redact_secrets: activeRedact,
            full_preview: wantFullPreview,
            skeleton_files: Array.from(activeSkeletons),
            include_git_diff: activeGitDiff,
            task_prompt: activePrompt.trim() ? activePrompt : undefined,
          };
          const raw = await invoke<GenerateOutputResponse | string>('generate_output', {
            path: rootPath,
            selectedPaths: sel,
            options: opts,
            revision: workspaceRevision.current,
          });
          if (seq !== genSeq.current) return;

          if (typeof raw === 'string') {
            // Backward-compatible string return (e.g. legacy mock in tests)
            const rep = activeRedact
              ? redactSecretsWithReport(raw).summary
              : { totalRedactions: 0, kinds: [] };
            setOutput(raw);
            setFullOutputText(raw);
            setTruncatedPreview(raw.length > 150_000 && !wantFullPreview);
            setTotalBytes(new Blob([raw]).size);
            setRedactionSummary(rep);
            setFullOutputPreview(wantFullPreview);
            setStats({ files: sel.length, tokens: estimateTokens(raw) });
          } else {
            setOutput(raw.preview);
            setFullOutputText(raw.truncatedPreview ? null : raw.preview);
            setTruncatedPreview(raw.truncatedPreview);
            setTotalBytes(raw.totalBytes);
            setRedactionSummary(
              raw.redactions ?? { totalRedactions: 0, kinds: [] },
            );
            setFileTokens(raw.fileTokens ?? []);
            setFullOutputPreview(wantFullPreview);
            setStats({
              files: raw.filesPacked ?? sel.length,
              tokens: raw.totalTokens || estimateTokens(raw.preview),
            });
          }
          hasLoadedOnce.current = true;
        }
      } catch (e) {
        if (seq !== genSeq.current) return;
        console.error(e);
        setOutput('');
        setFullOutputText(null);
        setTruncatedPreview(false);
        setTotalBytes(0);
        setStats({ files: 0, tokens: 0 });
        pushToast('error', `Failed to generate packed output: ${String(e)}`);
      } finally {
        if (seq === genSeq.current) setGenerating(false);
      }
    },
    [
      pushToast,
      redactSecretsEnabled,
      skeletonSet,
      includeGitDiff,
      taskPrompt,
    ],
  );

  /** Immediate generate (scan/format) or debounced (rapid selection toggles). */
  const generate = useCallback(
    (
      currentNodes: FileNode[],
      rootPath: string,
      fmt: OutputFormat,
      immediate = false,
      overrides: GenerateOverrides = {},
    ) => {
      if (generateTimer.current != null) {
        window.clearTimeout(generateTimer.current);
        generateTimer.current = null;
      }
      if (immediate) {
        void generateNow(currentNodes, rootPath, fmt, overrides);
        return;
      }
      ++genSeq.current;
      setGenerating(true);
      generateTimer.current = window.setTimeout(() => {
        generateTimer.current = null;
        void generateNow(currentNodes, rootPath, fmt, overrides);
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
      const withBase = applyPreset(result, nextPreset, junkDirs);
      // Apply saved per-project deselects (files user unchecked previously)
      const saved = customProjects.find(
        (p) => projectPrefKey(p.path) === projectPrefKey(pathLabel),
      );
      const withSelection = applySavedDeselects(withBase, saved?.deselectPaths ?? []);
      const nextSkels = new Set<string>();
      if (nextPreset === 'core_skeleton') {
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
    async (path: string, nextPreset: SelectionPreset = preset) => {
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
        await applyScanResult(result.nodes, result.root, nextPreset, false);
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
          const scanned = scanFileList(list);
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

  const selectRelatedFiles = useCallback(
    async (targetPath: string, relation: 'imports' | 'importers' | 'tests') => {
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
              : rel.tests;
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
        pushToast(
          'success',
          extra.length > 0
            ? `Selected ${targetPath.split('/').pop()} + ${extra.length} ${relation}`
            : `Selected ${targetPath.split('/').pop()} (no matching ${relation} found)`,
        );
      } catch (e) {
        pushToast('error', `Dependency lookup failed: ${String(e)}`);
      }
    },
    [currentPath, nodes, format, generate, pushToast],
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

  // Persist splitter width
  useEffect(() => {
    if (resizing) return;
    try {
      localStorage.setItem(TREE_WIDTH_KEY, String(treeWidth));
    } catch {
      /* ignore */
    }
  }, [treeWidth, resizing]);

  useEffect(() => {
    writeFolderHistory(folderHistory);
  }, [folderHistory]);

  useEffect(() => {
    writeProjectPrefs(customProjects);
  }, [customProjects]);

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

  const handleToggleFullPreview = useCallback(async () => {
    if (fullOutputPreview) {
      setFullOutputPreview(false);
      return;
    }
    if (fullOutputText !== null) {
      setFullOutputPreview(true);
      return;
    }
    if (IN_TAURI && !browserProjectRef.current && currentPath) {
      try {
        const full = await invoke<string | null>('get_full_packed_preview');
        if (typeof full === 'string' && full.length > 0) {
          setFullOutputText(full);
          setFullOutputPreview(true);
          return;
        }
      } catch {
        /* fallback to regenerate with full_preview: true */
      }
      await generateNow(nodes, currentPath, format, { fullPreview: true });
    } else {
      setFullOutputPreview(true);
    }
  }, [fullOutputPreview, fullOutputText, currentPath, nodes, format, generateNow]);

  const handleCopy = useCallback(async () => {
    if (!output) return;
    if (IN_TAURI && !browserProjectRef.current) {
      try {
        await invoke('copy_packed_output');
        // If running under Playwright mock bridge where copy_packed_output is a no-op,
        // also call copy_to_clipboard when fullOutputText is available in memory.
        if (fullOutputText !== null) {
          await invoke('copy_to_clipboard', { text: fullOutputText }).catch(() => {});
        }
        pushToast(
          'success',
          `Copied ${stats.files} files · ~${formatTokens(stats.tokens)} tokens`,
        );
        return;
      } catch {
        /* fallback to clipboard or copy_to_clipboard */
      }
    }
    const textToCopy = fullOutputText ?? output;
    try {
      await navigator.clipboard.writeText(textToCopy);
      pushToast(
        'success',
        `Copied ${stats.files} files · ~${formatTokens(stats.tokens)} tokens`,
      );
    } catch {
      try {
        await invoke('copy_to_clipboard', { text: textToCopy });
        pushToast('success', 'Copied to clipboard');
      } catch {
        pushToast('error', 'Could not copy to clipboard');
      }
    }
  }, [output, fullOutputText, stats, pushToast]);

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
    const textToSave = fullOutputText ?? output;
    if (browserProjectRef.current || !IN_TAURI) {
      downloadText(name, textToSave);
      pushToast('success', `Downloaded ${name}`);
      return;
    }
    try {
      const saved = await invoke<boolean | null>('save_packed_output', {
        defaultName: name,
      });
      if (saved === true) {
        pushToast('success', 'Saved packed output');
        return;
      }
      if (saved === null) {
        // Fallback for mock bridge that only implements save_to_file
        const legacySaved = await invoke<boolean>('save_to_file', {
          text: textToSave,
          defaultName: name,
        });
        if (legacySaved) pushToast('success', 'Saved packed output');
        return;
      }
    } catch (e) {
      console.error(e);
      try {
        const legacySaved = await invoke<boolean>('save_to_file', {
          text: textToSave,
          defaultName: name,
        });
        if (legacySaved) {
          pushToast('success', 'Saved packed output');
          return;
        }
      } catch {
        // Last resort: download in webview
        try {
          downloadText(name, textToSave);
          pushToast('success', `Downloaded ${name}`);
        } catch {
          pushToast('error', 'Failed to save file');
        }
      }
    }
  }, [output, fullOutputText, format, pushToast]);

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
        <span className={tokenBadgeClass(stats.tokens)} title={TOKEN_ESTIMATE_HINT}>
          <Check size={11} /> ready · ~{formatTokens(stats.tokens)} tokens (approx)
        </span>
      );
    }
    return null;
  })();

  return (
    <div
      className={`app-container${dragOver ? ' drag-over' : ''}`}
      style={{ ['--tree-width' as string]: `${treeWidth}px` }}
      data-testid="app-root"
    >
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
          {redactSecretsEnabled && redactionSummary.totalRedactions > 0 && (
            <span
              className="redact-badge"
              data-testid="redaction-badge"
              title={redactionSummary.kinds
                .map(([k, c]) => `${k}: ${c}`)
                .join(', ')}
            >
              🛡️ {redactionSummary.totalRedactions} secrets masked
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

      {/* Context Budget Bar */}
      {currentPath && (
        <div className="budget-bar-row" data-testid="context-budget-bar">
          <span className="panel-title">Context Budget</span>
          <select
            className="select"
            aria-label="Target token budget"
            data-testid="budget-select"
            value={budgetPreset}
            onChange={(e) => setBudgetPreset(e.target.value as BudgetPreset)}
          >
            <option value="32k">32k</option>
            <option value="64k">64k</option>
            <option value="128k">128k</option>
            <option value="200k">200k</option>
            <option value="1m">1M</option>
            <option value="custom">Custom</option>
          </select>
          {budgetPreset === 'custom' && (
            <input
              type="number"
              className="select"
              style={{ width: 92, paddingRight: 6 }}
              min={1000}
              step={1000}
              value={customBudget}
              onChange={(e) => setCustomBudget(Number(e.target.value) || 128_000)}
              aria-label="Custom token budget"
            />
          )}
          <div className="budget-meter-wrap">
            <div className="budget-track" role="progressbar" aria-valuenow={stats.tokens} aria-valuemax={targetBudgetTokens}>
              <div
                className={[
                  'budget-fill',
                  stats.tokens > targetBudgetTokens
                    ? 'is-over'
                    : stats.tokens > targetBudgetTokens * 0.85
                      ? 'is-warn'
                      : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
                style={{
                  width: `${Math.min(100, Math.round((stats.tokens / Math.max(1, targetBudgetTokens)) * 100))}%`,
                }}
              />
            </div>
            <span className="budget-label" data-testid="budget-progress-label">
              {formatTokens(stats.tokens)} / {formatTokens(targetBudgetTokens)} tokens (
              {Math.round((stats.tokens / Math.max(1, targetBudgetTokens)) * 100)}%)
            </span>
          </div>

          <button
            type="button"
            className="btn btn-ghost"
            onClick={autoFitToBudget}
            disabled={selectedCount === 0}
            data-testid="btn-auto-fit-budget"
            title="Automatically skeletonize or deselect low-priority files to fit <= 90% of target budget"
          >
            Auto-Fit to Budget
          </button>

          <button
            type="button"
            className={`btn btn-ghost ${showTopConsumers ? 'is-active' : ''}`}
            onClick={() => setShowTopConsumers((v) => !v)}
            aria-expanded={showTopConsumers}
            data-testid="btn-top-consumers"
          >
            Top Token Consumers
          </button>
        </div>
      )}

      {/* Prompt Studio collapsible bar */}
      {showPromptStudio && (
        <div className="prompt-studio-bar" data-testid="prompt-studio-panel">
          <div className="prompt-studio-controls">
            <span className="panel-title">Prompt Studio</span>
            <select
              className="select"
              aria-label="Prompt template"
              data-testid="prompt-template-select"
              value={promptTemplateId}
              onChange={(e) => {
                const id = e.target.value;
                setPromptTemplateId(id);
                const tpl = PROMPT_TEMPLATES.find((t) => t.id === id);
                if (tpl && id !== 'custom') {
                  setTaskPrompt(tpl.prompt);
                  if (currentPath && nodes.length > 0) {
                    generate(nodes, currentPath, format, true, { prompt: tpl.prompt });
                  }
                }
              }}
            >
              {PROMPT_TEMPLATES.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label}
                </option>
              ))}
            </select>
            <span className="meta-inline">
              Appended at the very end inside <code>&lt;task_instructions&gt;</code> for optimal long-context LLM reasoning.
            </span>
          </div>
          <textarea
            className="prompt-studio-textarea"
            placeholder="Describe the engineering task, bug, or review question to append inside <task_instructions>…"
            value={taskPrompt}
            data-testid="prompt-studio-input"
            onChange={(e) => {
              const val = e.target.value;
              setTaskPrompt(val);
              setPromptTemplateId('custom');
              if (currentPath && nodes.length > 0) {
                generate(nodes, currentPath, format, false, { prompt: val });
              }
            }}
          />
        </div>
      )}

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
          onImport={importPrefs}
        />
      )}

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
                    ? `Large pack — may exceed smaller model windows. ${TOKEN_ESTIMATE_HINT}`
                    : TOKEN_ESTIMATE_HINT
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
