/**
 * Browser-mode project loading when Tauri IPC is unavailable
 * (e.g. opening Vite at http://localhost:5173 without `cargo tauri dev`).
 *
 * Uses the File System Access API (`showDirectoryPicker`) when available,
 * with a hidden <input webkitdirectory> fallback.
 */

import { redactSecrets, redactSecretsWithReport, type RedactionSummary } from './secrets';

export interface BrowserFileNode {
  path: string;
  name: string;
  is_dir: boolean;
  size?: number;
  selected: boolean;
}

export const CANONICAL_JUNK_DIRS = [
  '.git',
  'node_modules',
  'target',
  'dist',
  'build',
  'out',
  '.vite',
  '.next',
  'coverage',
  '__pycache__',
  '.venv',
  '.turbo',
  '.cache',
  '.idea',
  '.vs',
  'vendor',
  'bin',
  'obj',
  'packages',
  'TestResults',
] as const;

const JUNK_DIR_NAMES = new Set(CANONICAL_JUNK_DIRS.map((d) => d.toLowerCase()));

export type BrowserFileMap = Map<string, File>;

export interface BrowserProject {
  rootName: string;
  /** Relative POSIX paths → File blobs */
  files: BrowserFileMap;
}

export class UserCancelledError extends Error {
  constructor(message = 'User cancelled folder selection') {
    super(message);
    this.name = 'UserCancelledError';
  }
}

function isJunkDir(name: string): boolean {
  return JUNK_DIR_NAMES.has(name.toLowerCase());
}

function isCancelledError(e: unknown): boolean {
  if (e instanceof UserCancelledError) return true;
  if (e instanceof DOMException && (e.name === 'AbortError' || e.name === 'NotAllowedError')) {
    // NotAllowedError can mean user dismissed in some browsers
    return e.name === 'AbortError';
  }
  const msg = e instanceof Error ? e.message : String(e);
  return /abort|cancel/i.test(msg);
}

/** Iterate directory entries across browser implementations. */
async function* directoryEntries(
  dir: FileSystemDirectoryHandle,
): AsyncGenerator<[string, FileSystemHandle]> {
  const anyDir = dir as FileSystemDirectoryHandle & {
    entries?: () => AsyncIterableIterator<[string, FileSystemHandle]>;
    values?: () => AsyncIterableIterator<FileSystemHandle>;
  };

  if (typeof anyDir.entries === 'function') {
    for await (const entry of anyDir.entries()) {
      yield entry;
    }
    return;
  }

  if (typeof anyDir.values === 'function') {
    for await (const handle of anyDir.values()) {
      yield [handle.name, handle];
    }
    return;
  }

  throw new Error('This browser cannot list folder contents (File System Access incomplete).');
}

/** Recursively list a FileSystemDirectoryHandle into flat nodes + file map. */
export async function scanDirectoryHandle(
  root: FileSystemDirectoryHandle,
): Promise<{ nodes: BrowserFileNode[]; project: BrowserProject }> {
  const files: BrowserFileMap = new Map();
  const dirPaths = new Set<string>();
  let fileCount = 0;
  const MAX_FILES = 25_000;

  async function walk(dir: FileSystemDirectoryHandle, prefix: string) {
    for await (const [name, handle] of directoryEntries(dir)) {
      if (!name || name === '.' || name === '..') continue;
      const rel = prefix ? `${prefix}/${name}` : name;

      if (handle.kind === 'directory') {
        if (isJunkDir(name)) continue;
        dirPaths.add(rel);
        await walk(handle as FileSystemDirectoryHandle, rel);
        continue;
      }

      if (handle.kind === 'file') {
        if (fileCount >= MAX_FILES) {
          throw new Error(
            `Folder is too large (>${MAX_FILES} files). Use cargo tauri dev for big projects, or open a smaller subfolder.`,
          );
        }
        try {
          const file = await (handle as FileSystemFileHandle).getFile();
          files.set(rel.replace(/\\/g, '/'), file);
          fileCount++;
        } catch (err) {
          // Skip unreadable files (permissions / locks) instead of failing whole scan
          console.warn('Skip unreadable file', rel, err);
        }
      }
    }
  }

  await walk(root, '');

  const nodes: BrowserFileNode[] = [];
  for (const d of dirPaths) {
    nodes.push({
      path: d,
      name: d.split('/').pop() || d,
      is_dir: true,
      selected: false,
    });
  }
  for (const [path, file] of files) {
    nodes.push({
      path,
      name: path.split('/').pop() || path,
      is_dir: false,
      size: file.size,
      selected: false,
    });
  }
  nodes.sort((a, b) => a.path.localeCompare(b.path));

  return {
    nodes,
    project: { rootName: root.name || 'project', files },
  };
}

/**
 * Scan files from a legacy <input webkitdirectory> FileList.
 */
export function scanFileList(list: FileList | File[]): {
  nodes: BrowserFileNode[];
  project: BrowserProject;
} {
  const files: BrowserFileMap = new Map();
  const dirPaths = new Set<string>();
  let rootName = 'project';

  const arr = Array.from(list);
  for (const file of arr) {
    // webkitRelativePath like "MyApp/src/Main.cs"
    const relFull =
      (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
    const parts = relFull.replace(/\\/g, '/').split('/').filter(Boolean);
    if (parts.length === 0) continue;

    if (parts.length === 1) {
      files.set(parts[0], file);
      continue;
    }

    rootName = parts[0];

    // Skip junk intermediate folders
    let skip = false;
    for (let i = 1; i < parts.length - 1; i++) {
      if (isJunkDir(parts[i])) {
        skip = true;
        break;
      }
    }
    if (skip) continue;

    const rel = parts.slice(1).join('/');
    const segs = rel.split('/');
    let acc = '';
    for (let i = 0; i < segs.length - 1; i++) {
      acc = acc ? `${acc}/${segs[i]}` : segs[i];
      dirPaths.add(acc);
    }
    files.set(rel, file);
  }

  const nodes: BrowserFileNode[] = [];
  for (const d of dirPaths) {
    nodes.push({
      path: d,
      name: d.split('/').pop() || d,
      is_dir: true,
      selected: false,
    });
  }
  for (const [path, file] of files) {
    nodes.push({
      path,
      name: path.split('/').pop() || path,
      is_dir: false,
      size: file.size,
      selected: false,
    });
  }
  nodes.sort((a, b) => a.path.localeCompare(b.path));

  return { nodes, project: { rootName, files } };
}

/** Pick a directory via File System Access API (Chrome/Edge). */
export async function pickDirectoryWithPicker(): Promise<FileSystemDirectoryHandle> {
  const w = window as unknown as {
    showDirectoryPicker?: (opts?: { mode?: string }) => Promise<FileSystemDirectoryHandle>;
  };
  if (typeof w.showDirectoryPicker !== 'function') {
    throw new Error('SHOW_DIRECTORY_PICKER_UNSUPPORTED');
  }
  try {
    return await w.showDirectoryPicker({ mode: 'read' });
  } catch (e) {
    if (isCancelledError(e)) throw new UserCancelledError();
    throw e;
  }
}

/** Hidden webkitdirectory input fallback (Firefox/Safari). */
export function pickDirectoryWithInput(): Promise<FileList> {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.setAttribute('webkitdirectory', '');
    input.setAttribute('directory', '');
    (input as HTMLInputElement & { webkitdirectory?: boolean }).webkitdirectory = true;
    input.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0;';

    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      window.removeEventListener('focus', onWindowFocus);
      input.remove();
      fn();
    };

    input.addEventListener('change', () => {
      const files = input.files;
      if (files && files.length > 0) {
        finish(() => resolve(files));
      } else {
        finish(() => reject(new UserCancelledError()));
      }
    });

    // Cancel detection: window regains focus and no change event fired
    const onWindowFocus = () => {
      window.setTimeout(() => {
        if (!settled && (!input.files || input.files.length === 0)) {
          finish(() => reject(new UserCancelledError()));
        }
      }, 800);
    };
    window.addEventListener('focus', onWindowFocus);

    document.body.appendChild(input);
    input.click();
  });
}

const PREVIEW_MAX = 512 * 1024;
const PACK_MAX = 2 * 1024 * 1024;

type DecodeResult = { ok: true; text: string } | { ok: false; reason: 'binary' | 'encoding' };

const INVALID_ENCODING_MESSAGE = '[Invalid text encoding: use UTF-8 or UTF-16 with BOM]';

/** Mirrors `decode_text` in src/core/text.rs: UTF-8 or BOM-declared UTF-16, never guessed. */
function decodeText(buf: Uint8Array, truncated = false): DecodeResult {
  const encoding = buf[0] === 0xff && buf[1] === 0xfe ? 'utf-16le'
    : buf[0] === 0xfe && buf[1] === 0xff ? 'utf-16be' : 'utf-8';
  const hasBom = encoding !== 'utf-8' || (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf);
  if (!hasBom && looksBinary(buf)) return { ok: false, reason: 'binary' };
  let text: string;
  try {
    text = new TextDecoder(encoding, { fatal: true }).decode(buf, { stream: truncated });
  } catch {
    return { ok: false, reason: 'encoding' };
  }
  return text.includes('\0') ? { ok: false, reason: 'binary' } : { ok: true, text };
}

function markdownFence(content: string): string {
  let longest = 0;
  let run = 0;
  for (const char of content) {
    run = char === '`' ? run + 1 : 0;
    longest = Math.max(longest, run);
  }
  return '`'.repeat(Math.max(3, longest + 1));
}

export async function readBrowserFilePreview(
  project: BrowserProject,
  relativePath: string,
): Promise<{
  path: string;
  relativePath: string;
  language: string;
  content: string;
  size: number;
  truncated: boolean;
  binary: boolean;
  absolutePath: string;
}> {
  const key = relativePath.replace(/\\/g, '/');
  const file = project.files.get(key);
  if (!file) throw new Error(`File not found: ${relativePath}`);
  const size = file.size;
  if (size === 0) {
    return {
      path: file.name,
      relativePath: key,
      language: guessLang(key),
      content: '',
      size: 0,
      truncated: false,
      binary: false,
      absolutePath: `${project.rootName}/${key}`,
    };
  }
  const slice = file.slice(0, Math.min(size, PREVIEW_MAX));
  const buf = new Uint8Array(await slice.arrayBuffer());
  const truncated = size > PREVIEW_MAX;
  const decoded = decodeText(buf, truncated);
  if (!decoded.ok && decoded.reason === 'encoding') {
    return {
      path: file.name,
      relativePath: key,
      language: 'plaintext',
      content: INVALID_ENCODING_MESSAGE,
      size,
      truncated: false,
      binary: false,
      absolutePath: `${project.rootName}/${key}`,
    };
  }
  if (!decoded.ok) {
    return {
      path: file.name,
      relativePath: key,
      language: 'plaintext',
      content: `[Binary file — ${size} bytes. Open with an external app to view.]`,
      size,
      truncated: false,
      binary: true,
      absolutePath: `${project.rootName}/${key}`,
    };
  }
  let content = decoded.text;
  if (truncated) {
    content += `\n\n// … truncated for preview (${size} bytes total) …`;
  }
  return {
    path: file.name,
    relativePath: key,
    language: guessLang(key),
    content,
    size,
    truncated,
    binary: false,
    absolutePath: `${project.rootName}/${key}`,
  };
}

function looksBinary(buf: Uint8Array): boolean {
  const n = Math.min(buf.length, 8000);
  let suspicious = 0;
  for (let i = 0; i < n; i++) {
    const b = buf[i];
    if (b === 0) return true;
    if (b < 7 || (b > 14 && b < 32 && b !== 9 && b !== 10 && b !== 13)) suspicious++;
  }
  return suspicious / n > 0.3;
}

function guessLang(path: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith('.xaml') || lower.endsWith('.csproj') || lower.endsWith('.xml')) return 'xml';
  if (lower.endsWith('.cs') || lower.endsWith('.xaml.cs')) return 'csharp';
  if (lower.endsWith('.ts') || lower.endsWith('.tsx')) return 'typescript';
  if (lower.endsWith('.js') || lower.endsWith('.jsx')) return 'javascript';
  if (lower.endsWith('.json')) return 'json';
  if (lower.endsWith('.rs')) return 'rust';
  if (lower.endsWith('.py')) return 'python';
  if (lower.endsWith('.md')) return 'markdown';
  if (lower.endsWith('.css') || lower.endsWith('.scss')) return 'css';
  if (lower.endsWith('.html') || lower.endsWith('.razor')) return 'xml';
  if (lower.endsWith('.yml') || lower.endsWith('.yaml')) return 'yaml';
  if (lower.endsWith('.toml')) return 'toml';
  if (lower.endsWith('.sh')) return 'bash';
  return 'plaintext';
}

function escapeXmlAttr(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export interface BrowserGenerateOptions {
  redactSecrets?: boolean;
  skeletonFiles?: Set<string>;
  taskPrompt?: string;
}

function extractBrowserSkeleton(content: string): string {
  const lines = content.split('\n');
  const out: string[] = [];
  let braceDepth = 0;
  let elidedAt: number | null = null;

  for (const line of lines) {
    const trimmed = line.trim();
    const opens = (line.match(/\{/g) || []).length;
    const closes = (line.match(/\}/g) || []).length;

    if (elidedAt !== null) {
      braceDepth += opens - closes;
      if (braceDepth < elidedAt) {
        elidedAt = null;
      }
      continue;
    }

    const isType =
      /^(?:export\s+)?(?:interface|type|class|enum|struct|trait|impl|mod|namespace)\b/.test(
        trimmed,
      );
    const preDepth = braceDepth;
    braceDepth += opens - closes;

    if (opens > closes && preDepth >= 0 && !isType && trimmed.includes('(')) {
      const idx = line.lastIndexOf('{');
      if (idx !== -1) {
        out.push(`${line.slice(0, idx).trimEnd()} { /* ... */ }`);
        elidedAt = braceDepth;
        continue;
      }
    }
    out.push(line);
  }
  return out.join('\n');
}

async function readPackContentWithReport(
  file: File,
  doRedact = true,
  isSkeleton = false,
): Promise<{ content: string; summary: RedactionSummary }> {
  const emptySummary: RedactionSummary = { totalRedactions: 0, kinds: [] };
  if (file.size > PACK_MAX) {
    return {
      content: `[File too large: ${file.size} bytes (limit ${PACK_MAX}), skipped]`,
      summary: emptySummary,
    };
  }
  try {
    const buf = new Uint8Array(await file.arrayBuffer());
    const decoded = decodeText(buf);
    if (decoded.ok) {
      let text = decoded.text;
      let summary = emptySummary;
      if (doRedact) {
        const res = redactSecretsWithReport(text);
        text = res.text;
        summary = res.summary;
      } else {
        // silence unused import if needed
        void redactSecrets;
      }
      if (isSkeleton) {
        text = extractBrowserSkeleton(text);
      }
      return { content: text, summary };
    }
    if (decoded.reason === 'encoding') {
      return { content: INVALID_ENCODING_MESSAGE, summary: emptySummary };
    }
    return {
      content: `[Binary file - ${file.size} bytes, content omitted for LLM safety]`,
      summary: emptySummary,
    };
  } catch (e) {
    return {
      content: `[Error reading file: ${e instanceof Error ? e.message : String(e)}]`,
      summary: emptySummary,
    };
  }
}

/**
 * Architectural emission tier for `<files>` content (lower is emitted first). Mirrors
 * `architectural_tier` in src/core/output.rs: 0 source, 1 manifests, 2 tests/examples,
 * 3 docs, CI metadata and everything else.
 */
export function architecturalTier(path: string): number {
  const lower = path.replace(/\\/g, '/').toLowerCase();
  const name = lower.slice(lower.lastIndexOf('/') + 1);
  const inDir = (dir: string) => lower.startsWith(`${dir}/`) || lower.includes(`/${dir}/`);

  const manifests = [
    'cargo.toml',
    'package.json',
    'tauri.conf.json',
    'pyproject.toml',
    'go.mod',
    'makefile',
    'dockerfile',
    'build.rs',
  ];
  if (manifests.includes(name) || (name.startsWith('tsconfig') && name.endsWith('.json'))) {
    return 1;
  }

  const isTestName =
    name.includes('.test.') ||
    name.includes('.spec.') ||
    name.includes('_test.') ||
    name.startsWith('test_');
  if (isTestName || ['tests', 'e2e', 'examples', 'benches'].some(inDir)) {
    return 2;
  }

  const sourceExts = [
    '.rs', '.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.cs', '.java', '.c', '.cpp', '.h', '.hpp',
  ];
  const isRootSource = !lower.includes('/') && sourceExts.some((e) => lower.endsWith(e));
  const sourceDirs = ['src', 'lib', 'app', 'pkg', 'cmd', 'internal', 'crates', 'packages'];
  if (isRootSource || sourceDirs.some(inDir)) {
    return 0;
  }

  return 3;
}

export async function generateBrowserOutputWithStats(
  project: BrowserProject,
  selectedPaths: string[],
  format: string,
  opts: BrowserGenerateOptions = {},
): Promise<{
  text: string;
  redactions: RedactionSummary;
  fileTokens: { path: string; bytes: number; tokens: number; mode: 'full' | 'skeleton' }[];
}> {
  const doRedact = opts.redactSecrets !== false;
  const skelSet = opts.skeletonFiles ?? new Set<string>();
  const taskPrompt = opts.taskPrompt?.trim() || '';

  const selected = new Set(selectedPaths.map((p) => p.replace(/\\/g, '/').replace(/\/+$/, '')));
  const isSelected = (path: string): boolean => {
    let prefix = path;
    while (prefix) {
      if (selected.has(prefix)) return true;
      const slash = prefix.lastIndexOf('/');
      if (slash < 0) return false;
      prefix = prefix.slice(0, slash);
    }
    return false;
  };
  const entries: { path: string; file: File }[] = [];
  for (const [path, file] of project.files) {
    if (isSelected(path)) {
      entries.push({ path, file });
    }
  }
  entries.sort((a, b) => a.path.localeCompare(b.path));

  // Content is emitted by architectural tier (stable, so ties stay alphabetical). The file cap
  // applies after this ordering, so the cap drops docs and CI metadata before source code.
  const MAX_PACK_FILES = 400;
  const contentOrder = [...entries].sort((a, b) => architecturalTier(a.path) - architecturalTier(b.path));
  const limited = contentOrder.slice(0, MAX_PACK_FILES);
  const truncatedNote =
    entries.length > MAX_PACK_FILES
      ? `\n<!-- packed first ${MAX_PACK_FILES} of ${entries.length} selected files (browser limit) -->\n`
      : '';

  let totalRedactions = 0;
  const kindMap = new Map<string, number>();
  const fileTokens: { path: string; bytes: number; tokens: number; mode: 'full' | 'skeleton' }[] = [];

  const prepared: { path: string; size: number; content: string; isSkel: boolean }[] = [];
  for (const e of limited) {
    const isSkel = skelSet.has(e.path);
    const { content, summary } = await readPackContentWithReport(e.file, doRedact, isSkel);
    totalRedactions += summary.totalRedactions;
    for (const [k, c] of summary.kinds) {
      kindMap.set(k, (kindMap.get(k) ?? 0) + c);
    }
    const tokens = Math.max(0, Math.round(content.length / 3.8));
    fileTokens.push({
      path: e.path,
      bytes: content.length,
      tokens,
      mode: isSkel ? 'skeleton' : 'full',
    });
    prepared.push({ path: e.path, size: e.file.size, content, isSkel });
  }

  const redactions: RedactionSummary = {
    totalRedactions,
    kinds: Array.from(kindMap.entries()),
  };

  if (format === 'json') {
    const files = prepared.map((p) =>
      p.isSkel
        ? { path: p.path, size: p.size, mode: 'skeleton', content: p.content }
        : { path: p.path, size: p.size, content: p.content },
    );
    const doc: Record<string, unknown> = {
      generator: 'ptt (ProjectToText) browser-mode',
      root: project.rootName,
      file_count: files.length,
      files,
    };
    if (taskPrompt) doc.task_instructions = taskPrompt;
    return {
      text: JSON.stringify(doc, null, 2),
      redactions,
      fileTokens,
    };
  }

  if (format === 'markdown') {
    const parts = [
      `# Project Context`,
      `Generated from: \`${project.rootName}\` (browser mode)\n`,
      truncatedNote,
    ];
    for (const p of prepared) {
      const ext = p.path.includes('.') ? p.path.split('.').pop() : '';
      const fence = markdownFence(p.content);
      const header = p.isSkel ? `## \`${p.path}\` *(skeleton)*` : `## \`${p.path}\``;
      parts.push(`${header}\n${fence}${ext}\n${p.content}\n${fence}\n`);
    }
    if (taskPrompt) {
      parts.push(`<task_instructions>\n${taskPrompt}\n</task_instructions>`);
    }
    return { text: parts.join('\n'), redactions, fileTokens };
  }

  if (format === 'plain') {
    const parts = [
      `Project: ${project.rootName}`,
      '================================\n',
      truncatedNote,
    ];
    for (const p of prepared) {
      parts.push(
        p.isSkel ? `>>> ${p.path} [skeleton]` : `>>> ${p.path}`,
        p.content,
        '--------------------------------\n',
      );
    }
    if (taskPrompt) {
      parts.push(`<task_instructions>\n${taskPrompt}\n</task_instructions>`);
    }
    return { text: parts.join('\n'), redactions, fileTokens };
  }

  // XML default
  const lines: string[] = [
    '<project_context>',
    `  <source>This file was generated by ptt (ProjectToText) from ${escapeXmlAttr(project.rootName)} (browser mode)</source>`,
    '  <instruction>Below is the complete (curated) content of the project. Use it for code analysis, refactoring, or implementation tasks.</instruction>',
    '  <file_summary>',
    `    Total files included: ${limited.length}`,
    truncatedNote ? `    Note: browser mode capped at ${MAX_PACK_FILES} files` : '',
    '  </file_summary>',
    '  <directory_structure>',
  ].filter(Boolean) as string[];
  // The directory listing stays alphabetical; only the <files> content follows tier order.
  for (const p of [...prepared].sort((a, b) => a.path.localeCompare(b.path))) {
    lines.push(`    ${p.path}`);
  }
  lines.push('  </directory_structure>', '  <files>');
  for (const p of prepared) {
    const safe = p.content.split(']]>').join(']]]]><![CDATA[>');
    const attr = p.isSkel
      ? `path="${escapeXmlAttr(p.path)}" mode="skeleton"`
      : `path="${escapeXmlAttr(p.path)}"`;
    lines.push(
      `    <file ${attr}>`,
      '      <![CDATA[',
      safe,
      '      ]]>',
      '    </file>',
    );
  }
  lines.push('  </files>');
  if (taskPrompt) {
    lines.push('  <task_instructions>');
    for (const line of taskPrompt.split('\n')) {
      lines.push(`    ${line}`);
    }
    lines.push('  </task_instructions>');
  }
  lines.push('</project_context>');
  return { text: lines.join('\n'), redactions, fileTokens };
}

export async function generateBrowserOutput(
  project: BrowserProject,
  selectedPaths: string[],
  format: string,
  opts: BrowserGenerateOptions = {},
): Promise<string> {
  const res = await generateBrowserOutputWithStats(project, selectedPaths, format, opts);
  return res.text;
}

export function downloadText(filename: string, text: string) {
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export { isCancelledError };
