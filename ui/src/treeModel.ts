import { CANONICAL_JUNK_DIRS } from './browserFs';
import { type RedactionSummary } from './secrets';
import './index.css';

/* ─── Types ──────────────────────────────────────────── */

export interface FileNode {
  path: string;
  name: string;
  is_dir: boolean;
  size?: number;
  selected: boolean;
  git_status?: string;
}

export interface GitRepoContext {
  isGitRepo: boolean;
  currentBranch?: string | null;
  baseBranch?: string | null;
  fileStatuses: Record<string, string>;
  modifiedFiles: string[];
  branchChangedFiles: string[];
  recentCommits: string[];
}

export interface ScanResult {
  root: string;
  revision: number;
  nodes: FileNode[];
  junkDirs?: string[];
  gitContext?: GitRepoContext;
}

export interface PackOptions {
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

export interface FileTokenStat {
  path: string;
  bytes: number;
  tokens: number;
  mode: 'full' | 'skeleton';
}

export interface PackTokenStats {
  files: number;
  tokens: number;
  contentTokens?: number;
  overheadTokens?: number;
  tokenizerExact?: boolean;
}

export interface GenerateOutputResponse {
  preview: string;
  truncatedPreview: boolean;
  totalBytes: number;
  totalChars: number;
  totalTokens: number;
  contentTokens?: number;
  overheadTokens?: number;
  tokenizerExact?: boolean;
  filesPacked: number;
  fileTokens?: FileTokenStat[];
  redactions: RedactionSummary;
}

export interface RelatedFiles {
  target: string;
  imports: string[];
  importers: string[];
  tests: string[];
}

export interface TreeNode {
  name: string;
  path: string;
  isDir: boolean;
  size?: number;
  selected: boolean;
  gitStatus?: string;
  children: TreeNode[];
}

export interface VisibleTreeRow {
  node: TreeNode;
  depth: number;
  hasChildren: boolean;
  showChildren: boolean;
}

export type OutputFormat = 'xml' | 'markdown' | 'json' | 'plain';
export type ViewMode = 'packed' | 'list' | 'file';
export type ListFormat = 'tree' | 'paths';
export type SelectionPreset = 'source' | 'docs' | 'all' | 'core_skeleton';
export type ToastKind = 'success' | 'error' | 'info';
export type BudgetPreset = '32k' | '64k' | '128k' | '200k' | '1m' | 'custom';

export const BUDGET_LIMITS: Record<Exclude<BudgetPreset, 'custom'>, number> = {
  '32k': 32_000,
  '64k': 64_000,
  '128k': 128_000,
  '200k': 200_000,
  '1m': 1_000_000,
};

export const PROMPT_TEMPLATES: { id: string; label: string; prompt: string }[] = [
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

export interface ContextMenuState {
  x: number;
  y: number;
  path: string;
  isDir: boolean;
}

export interface ToastItem {
  id: number;
  kind: ToastKind;
  message: string;
}

/* ─── Constants ──────────────────────────────────────── */

export const JUNK_DIRS: readonly string[] = CANONICAL_JUNK_DIRS;

export const SOURCE_EXTS = [
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
export function isSourcePath(path: string): boolean {
  const lower = path.toLowerCase().replace(/\\/g, '/');
  if (SOURCE_EXTS.some((ext) => lower.endsWith(ext))) return true;
  // Double extensions used heavily in .NET
  if (lower.endsWith('.xaml.cs') || lower.endsWith('.razor.cs') || lower.endsWith('.designer.cs')) {
    return true;
  }
  return false;
}

export const DOC_EXTS = ['.md', '.txt', '.rst', '.adoc'];

export const TOKEN_SOFT = 80_000;
export const TOKEN_HARD = 150_000;



/* ─── Helpers ────────────────────────────────────────── */

export function normalizePath(p: string): string {
  return p.replace(/\\/g, '/');
}

/** Unchecks files the user previously excluded in this project's Custom replay list. */
export function applySavedDeselects(nodes: FileNode[], deselectPaths: string[]): FileNode[] {
  if (deselectPaths.length === 0) return nodes;
  const excluded = new Set(deselectPaths.map((p) => normalizePath(p)));
  return nodes.map((n) =>
    !n.is_dir && excluded.has(normalizePath(n.path)) ? { ...n, selected: false } : n,
  );
}



export function formatBytes(size?: number): string {
  if (size == null || size <= 0) return '';
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(size < 10_240 ? 1 : 0)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatTokens(n: number): string {
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
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.max(0, Math.round(text.length / 3.8));
}

/** Same heuristic as estimateTokens, applied to a file's byte size (no content read). */
export function estimateTokensFromBytes(bytes: number): number {
  return Math.max(0, Math.round(bytes / 3.8));
}

export const TOKEN_ESTIMATE_HINT =
  'Approximate only (chars ÷ 3.8). Not a model-specific tokenizer.';

export function isJunkPath(path: string, junkDirs: readonly string[] = JUNK_DIRS): boolean {
  const lower = normalizePath(path).toLowerCase();
  return junkDirs.some(
    (d) =>
      lower.includes(`/${d}/`) ||
      lower.startsWith(`${d}/`) ||
      lower.endsWith(`/${d}`) ||
      lower === d,
  );
}

export function isLowPriorityPath(path: string): boolean {
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

/** Lockfiles and generated paths: visible in the tree, unchecked by every preset. */
export const DEFAULT_EXCLUDED_FILE_NAMES = new Set([
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'Cargo.lock',
  'composer.lock',
  'Gemfile.lock',
  'poetry.lock',
  'uv.lock',
]);
export const DEFAULT_EXCLUDED_DIR_PREFIXES = ['gen/schemas/', 'benchmarks/'];

export function isDefaultExcludedPath(path: string): boolean {
  const normalized = normalizePath(path);
  const name = normalized.slice(normalized.lastIndexOf('/') + 1);
  return (
    DEFAULT_EXCLUDED_FILE_NAMES.has(name) ||
    DEFAULT_EXCLUDED_DIR_PREFIXES.some((p) => normalized.startsWith(p))
  );
}

export function applyPreset(
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

export function generateFileList(nodes: FileNode[]): string {
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

export function generatePathsList(nodes: FileNode[]): string {
  return nodes
    .filter((n) => n.selected && !n.is_dir)
    .map((n) => n.path)
    .sort()
    .join('\n');
}

export interface BuildTreeNode extends TreeNode {
  childMap?: Map<string, BuildTreeNode>;
}

export function buildFileTree(flatNodes: FileNode[]): TreeNode {
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

export function sortTreeByTokens(
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

export function flattenVisibleTree(
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

export type SubtreeStats = {
  selected: number;
  total: number;
  partial: boolean;
  allSelected: boolean;
  allSkeleton: boolean;
  /** Estimated tokens of every file in the subtree (selected or not). */
  tokens: number;
};

export function computeSubtree(
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
      // A skeleton keeps about 30% of the file's tokens, matching the Rust packer's estimate.
      tokens: skel
        ? Math.max(1, Math.round(estimateTokensFromBytes(node.size ?? 0) * 0.3))
        : estimateTokensFromBytes(node.size ?? 0),
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


export function filterTree(node: TreeNode, query: string): TreeNode | null {
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

export function collectDirPaths(node: TreeNode, into: string[] = []): string[] {
  if (node.isDir && node.path) into.push(node.path);
  node.children.forEach((c) => collectDirPaths(c, into));
  return into;
}

export function collectFilePaths(node: TreeNode, into: string[] = []): string[] {
  if (!node.isDir && node.path) into.push(node.path);
  node.children.forEach((c) => collectFilePaths(c, into));
  return into;
}

export function readStoredFormat(): OutputFormat {
  try {
    const raw = localStorage.getItem('ptt.format');
    if (raw === 'xml' || raw === 'markdown' || raw === 'json' || raw === 'plain') return raw;
  } catch {
    /* ignore */
  }
  return 'xml';
}

export function tokenBadgeClass(tokens: number): string {
  if (tokens >= TOKEN_HARD) return 'badge badge-hot';
  if (tokens >= TOKEN_SOFT) return 'badge badge-warn';
  return 'badge badge-ready';
}

/* ─── Small components ───────────────────────────────── */
