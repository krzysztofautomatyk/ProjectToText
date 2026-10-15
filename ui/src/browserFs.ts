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

export interface BrowserSkippedItem {
  path: string;
  reason: 'junk_dir' | 'gitignore' | 'pttignore' | 'unreadable';
  detail?: string;
}

export interface BrowserProject {
  rootName: string;
  /** Relative POSIX paths → File blobs */
  files: BrowserFileMap;
  /** Items excluded or skipped during the browser scan */
  skipped?: BrowserSkippedItem[];
}

interface CompiledIgnoreRule {
  negated: boolean;
  dirOnly: boolean;
  baseDir: string;
  matcher: RegExp;
}

function globToRegExpSource(pattern: string): string {
  let out = '';
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === '\\') {
      if (i + 1 >= pattern.length) {
        throw new Error('Trailing backslash in ignore pattern');
      }
      const next = pattern[i + 1];
      out += next.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      i += 2;
      continue;
    }
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        if (pattern[i + 2] === '/') {
          out += '(?:.*/)?';
          i += 3;
        } else {
          out += '.*';
          i += 2;
        }
      } else {
        out += '[^/]*';
        i += 1;
      }
      continue;
    }
    if (ch === '?') {
      out += '[^/]';
      i += 1;
      continue;
    }
    if (ch === '[') {
      const close = pattern.indexOf(']', i + 1);
      if (close === -1) {
        throw new Error('Unclosed character class in ignore pattern');
      }
      let cls = pattern.slice(i + 1, close);
      if (cls.startsWith('!')) cls = '^' + cls.slice(1);
      out += `[${cls}]`;
      i = close + 1;
      continue;
    }
    out += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    i += 1;
  }
  return out;
}

/**
 * Parses `.gitignore` or `.pttignore` text into compiled rules scoped to `baseDir`.
 * When `strict` is true (`.pttignore`), invalid syntax throws an error (fail-closed),
 * matching Rust `apply_pttignore_on_git_results` / `walk_with_ignore`.
 */
export function parseIgnoreFile(
  content: string,
  baseDir: string,
  strict: boolean,
): CompiledIgnoreRule[] {
  const rules: CompiledIgnoreRule[] = [];
  const lines = content.split(/\r?\n/);
  for (const rawLine of lines) {
    let line = rawLine;
    // Strip unescaped trailing spaces
    while (line.endsWith(' ') && !line.endsWith('\\ ')) {
      line = line.slice(0, -1);
    }
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('\\#') || line.startsWith('\\!')) {
      line = line.slice(1);
    } else if (line.startsWith('!')) {
      const rest = line.slice(1);
      if (!rest) {
        if (strict) throw new Error('Invalid empty negation pattern "!" in .pttignore');
        continue;
      }
      try {
        rules.push(compileSingleRule(rest, baseDir, true, strict));
      } catch (err) {
        if (strict) throw err;
      }
      continue;
    }
    try {
      rules.push(compileSingleRule(line, baseDir, false, strict));
    } catch (err) {
      if (strict) throw err;
    }
  }
  return rules;
}

function compileSingleRule(
  rawPattern: string,
  baseDir: string,
  negated: boolean,
  strict: boolean,
): CompiledIgnoreRule {
  let pat = rawPattern;
  const dirOnly = pat.endsWith('/');
  if (dirOnly) pat = pat.replace(/\/+$/, '');
  if (!pat) {
    throw new Error('Empty ignore pattern');
  }
  // Reject invalid `**` adjacency in strict mode (e.g. `a/**b`)
  if (strict && /(?<!^|\/)\*\*|\*\*(?!$|\/)/.test(pat)) {
    throw new Error(`Invalid globstar placement in .pttignore: ${rawPattern}`);
  }
  const leadingSlash = pat.startsWith('/');
  if (leadingSlash) pat = pat.slice(1);
  const anchored = leadingSlash || pat.includes('/');
  const regexBody = globToRegExpSource(pat);
  const fullRegexStr = anchored ? `^${regexBody}$` : `(?:^|/)${regexBody}$`;
  const matcher = new RegExp(fullRegexStr);
  return { negated, dirOnly, baseDir, matcher };
}

function evaluateIgnoreRules(
  rules: readonly CompiledIgnoreRule[],
  relPath: string,
  isDir: boolean,
): boolean {
  let ignored = false;
  for (const rule of rules) {
    if (rule.dirOnly && !isDir) continue;
    let subPath = relPath;
    if (rule.baseDir) {
      const prefix = `${rule.baseDir}/`;
      if (!relPath.startsWith(prefix)) continue;
      subPath = relPath.slice(prefix.length);
    }
    if (rule.matcher.test(subPath)) {
      ignored = !rule.negated;
    }
  }
  return ignored;
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

/**
 * Applies top-down `.gitignore` and `.pttignore` pruning and filtering to an arbitrary
 * candidate map of `relPath -> File`. Mirrors Rust `apply_pttignore_on_git_results` /
 * `walk_with_ignore`:
 * - Excluded parent directories cannot be resurrected by child negation rules.
 * - `.pttignore` syntax/read errors fail closed (throw), whereas `.gitignore` syntax errors
 *   skip only the offending line.
 */
export async function applyIgnoreSemanticsToFileMap(
  rawFiles: BrowserFileMap,
  initialSkipped: BrowserSkippedItem[] = [],
): Promise<{
  files: BrowserFileMap;
  dirPaths: Set<string>;
  skipped: BrowserSkippedItem[];
}> {
  const skipped: BrowserSkippedItem[] = [...initialSkipped];
  const allDirs = new Set<string>();
  for (const rel of rawFiles.keys()) {
    const segs = rel.split('/');
    let acc = '';
    for (let i = 0; i < segs.length - 1; i++) {
      acc = acc ? `${acc}/${segs[i]}` : segs[i];
      allDirs.add(acc);
    }
  }

  const sortedDirs = ['', ...Array.from(allDirs).sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b))];

  interface DirIgnoreContext {
    gitRules: CompiledIgnoreRule[];
    pttRules: CompiledIgnoreRule[];
    blockedBy: 'gitignore' | 'pttignore' | null;
  }

  const contexts = new Map<string, DirIgnoreContext>();

  async function loadRulesForDir(
    dir: string,
    parentGit: CompiledIgnoreRule[],
    parentPtt: CompiledIgnoreRule[],
  ): Promise<{ gitRules: CompiledIgnoreRule[]; pttRules: CompiledIgnoreRule[] }> {
    let gitRules = parentGit;
    let pttRules = parentPtt;
    const gitPath = dir ? `${dir}/.gitignore` : '.gitignore';
    const pttPath = dir ? `${dir}/.pttignore` : '.pttignore';

    const gitFile = rawFiles.get(gitPath);
    if (gitFile) {
      try {
        const text = await gitFile.text();
        gitRules = [...parentGit, ...parseIgnoreFile(text, dir, false)];
      } catch {
        // Foreign .gitignore read errors do not abort the walk
      }
    }

    const pttFile = rawFiles.get(pttPath);
    if (pttFile) {
      const text = await pttFile.text();
      pttRules = [...parentPtt, ...parseIgnoreFile(text, dir, true)];
    }

    return { gitRules, pttRules };
  }

  const rootLoaded = await loadRulesForDir('', [], []);
  contexts.set('', { ...rootLoaded, blockedBy: null });

  for (const dir of sortedDirs) {
    if (dir === '') continue;
    const slash = dir.lastIndexOf('/');
    const parent = slash < 0 ? '' : dir.slice(0, slash);
    const parentCtx = contexts.get(parent)!;

    if (parentCtx.blockedBy) {
      contexts.set(dir, {
        gitRules: parentCtx.gitRules,
        pttRules: parentCtx.pttRules,
        blockedBy: parentCtx.blockedBy,
      });
      continue;
    }

    const blockedByGit = evaluateIgnoreRules(parentCtx.gitRules, dir, true);
    const blockedByPtt = !blockedByGit && evaluateIgnoreRules(parentCtx.pttRules, dir, true);
    const blockedBy = blockedByGit ? 'gitignore' : blockedByPtt ? 'pttignore' : null;
    if (blockedBy) {
      skipped.push({ path: dir, reason: blockedBy });
      contexts.set(dir, {
        gitRules: parentCtx.gitRules,
        pttRules: parentCtx.pttRules,
        blockedBy,
      });
    } else {
      const loaded = await loadRulesForDir(dir, parentCtx.gitRules, parentCtx.pttRules);
      contexts.set(dir, { ...loaded, blockedBy: null });
    }
  }

  const keptFiles: BrowserFileMap = new Map();
  const keptDirs = new Set<string>();

  for (const [dir, ctx] of contexts.entries()) {
    if (dir !== '' && !ctx.blockedBy) {
      keptDirs.add(dir);
    }
  }

  for (const [rel, file] of rawFiles.entries()) {
    const slash = rel.lastIndexOf('/');
    const parent = slash < 0 ? '' : rel.slice(0, slash);
    const ctx = contexts.get(parent);
    if (!ctx || ctx.blockedBy) continue;

    if (evaluateIgnoreRules(ctx.gitRules, rel, false)) {
      skipped.push({ path: rel, reason: 'gitignore' });
      continue;
    }
    if (evaluateIgnoreRules(ctx.pttRules, rel, false)) {
      skipped.push({ path: rel, reason: 'pttignore' });
      continue;
    }
    keptFiles.set(rel, file);
  }

  return { files: keptFiles, dirPaths: keptDirs, skipped };
}

/** Recursively list a FileSystemDirectoryHandle into flat nodes + file map, honoring .gitignore and .pttignore. */
export async function scanDirectoryHandle(
  root: FileSystemDirectoryHandle,
): Promise<{ nodes: BrowserFileNode[]; project: BrowserProject }> {
  const rawFiles: BrowserFileMap = new Map();
  const skipped: BrowserSkippedItem[] = [];
  let fileCount = 0;
  const MAX_FILES = 25_000;

  async function walk(dir: FileSystemDirectoryHandle, prefix: string) {
    for await (const [name, handle] of directoryEntries(dir)) {
      if (!name || name === '.' || name === '..') continue;
      const rel = (prefix ? `${prefix}/${name}` : name).replace(/\\/g, '/');

      if (handle.kind === 'directory') {
        if (isJunkDir(name)) {
          skipped.push({ path: rel, reason: 'junk_dir' });
          continue;
        }
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
          rawFiles.set(rel, file);
          fileCount++;
        } catch (err) {
          skipped.push({
            path: rel,
            reason: 'unreadable',
            detail: err instanceof Error ? err.message : String(err),
          });
          console.warn('Skip unreadable file', rel, err);
        }
      }
    }
  }

  await walk(root, '');

  const filtered = await applyIgnoreSemanticsToFileMap(rawFiles, skipped);
  const nodes: BrowserFileNode[] = [];
  for (const d of filtered.dirPaths) {
    nodes.push({
      path: d,
      name: d.split('/').pop() || d,
      is_dir: true,
      selected: false,
    });
  }
  for (const [path, file] of filtered.files) {
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
    project: {
      rootName: root.name || 'project',
      files: filtered.files,
      skipped: filtered.skipped,
    },
  };
}

/**
 * Scan files from a legacy <input webkitdirectory> FileList, honoring .gitignore and .pttignore.
 */
export async function scanFileList(list: FileList | File[]): Promise<{
  nodes: BrowserFileNode[];
  project: BrowserProject;
}> {
  const rawFiles: BrowserFileMap = new Map();
  const skipped: BrowserSkippedItem[] = [];
  let rootName = 'project';

  const arr = Array.from(list);
  for (const file of arr) {
    // webkitRelativePath like "MyApp/src/Main.cs"
    const relFull =
      (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
    const parts = relFull.replace(/\\/g, '/').split('/').filter(Boolean);
    if (parts.length === 0) continue;

    if (parts.length === 1) {
      rawFiles.set(parts[0], file);
      continue;
    }

    rootName = parts[0];

    // Skip junk intermediate folders
    let skip = false;
    for (let i = 1; i < parts.length - 1; i++) {
      if (isJunkDir(parts[i])) {
        skipped.push({ path: parts.slice(1, i + 1).join('/'), reason: 'junk_dir' });
        skip = true;
        break;
      }
    }
    if (skip) continue;

    const rel = parts.slice(1).join('/');
    rawFiles.set(rel, file);
  }

  const filtered = await applyIgnoreSemanticsToFileMap(rawFiles, skipped);
  const nodes: BrowserFileNode[] = [];
  for (const d of filtered.dirPaths) {
    nodes.push({
      path: d,
      name: d.split('/').pop() || d,
      is_dir: true,
      selected: false,
    });
  }
  for (const [path, file] of filtered.files) {
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
    project: {
      rootName,
      files: filtered.files,
      skipped: filtered.skipped,
    },
  };
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
  const skippedSummary: RedactionSummary = {
    totalRedactions: 0,
    kinds: [],
    redactionEnabled: doRedact,
    filesScanned: 0,
    filesSkipped: 1,
  };
  if (file.size > PACK_MAX) {
    return {
      content: `[File too large: ${file.size} bytes (limit ${PACK_MAX}), skipped]`,
      summary: skippedSummary,
    };
  }
  try {
    const buf = new Uint8Array(await file.arrayBuffer());
    const decoded = decodeText(buf);
    if (decoded.ok) {
      let text = decoded.text;
      let summary: RedactionSummary = {
        totalRedactions: 0,
        kinds: [],
        redactionEnabled: doRedact,
        filesScanned: doRedact ? 1 : 0,
        filesSkipped: 0,
      };
      if (doRedact) {
        const res = redactSecretsWithReport(text);
        text = res.text;
        summary = {
          ...res.summary,
          redactionEnabled: true,
          filesScanned: 1,
          filesSkipped: 0,
        };
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
      return { content: INVALID_ENCODING_MESSAGE, summary: skippedSummary };
    }
    return {
      content: `[Binary file - ${file.size} bytes, content omitted for LLM safety]`,
      summary: skippedSummary,
    };
  } catch (e) {
    return {
      content: `[Error reading file: ${e instanceof Error ? e.message : String(e)}]`,
      summary: skippedSummary,
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
  // The prompt is masked with the same rules as file contents when redaction is on (parity with
  // the native `task_prompt_text` in src/core/output.rs). Its counts are included in the report.
  const rawTaskPrompt = opts.taskPrompt?.trim() || '';
  const promptRedaction = doRedact && rawTaskPrompt ? redactSecretsWithReport(rawTaskPrompt) : null;
  const taskPrompt = promptRedaction ? promptRedaction.text : rawTaskPrompt;

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

  let totalRedactions = promptRedaction?.summary.totalRedactions ?? 0;
  let filesScanned = 0;
  let filesSkipped = 0;
  const kindMap = new Map<string, number>(promptRedaction?.summary.kinds ?? []);
  const fileTokens: { path: string; bytes: number; tokens: number; mode: 'full' | 'skeleton' }[] = [];

  const prepared: { path: string; size: number; content: string; isSkel: boolean }[] = [];
  for (const e of limited) {
    const isSkel = skelSet.has(e.path);
    const { content, summary } = await readPackContentWithReport(e.file, doRedact, isSkel);
    totalRedactions += summary.totalRedactions;
    filesScanned += summary.filesScanned ?? 0;
    filesSkipped += summary.filesSkipped ?? 0;
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
    redactionEnabled: doRedact,
    filesScanned,
    filesSkipped,
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
    // Wrapped in CDATA like file contents; `]]>` is split so the section stays well-formed.
    lines.push(
      '  <task_instructions>',
      '      <![CDATA[',
      taskPrompt.split(']]>').join(']]]]><![CDATA[>'),
      '      ]]>',
      '  </task_instructions>',
    );
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
