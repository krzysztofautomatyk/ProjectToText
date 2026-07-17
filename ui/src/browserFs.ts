/**
 * Browser-mode project loading when Tauri IPC is unavailable
 * (e.g. opening Vite at http://localhost:5173 without `cargo tauri dev`).
 *
 * Uses the File System Access API (`showDirectoryPicker`) when available,
 * with a hidden <input webkitdirectory> fallback.
 */

export interface BrowserFileNode {
  path: string;
  name: string;
  is_dir: boolean;
  size?: number;
  selected: boolean;
}

const JUNK_DIR_NAMES = new Set([
  'node_modules',
  '.git',
  'target',
  'dist',
  // note: do NOT skip generic "build"/"out" at all levels too aggressively for small projects;
  // keep common heavyweight folders only
  '.next',
  'coverage',
  '__pycache__',
  '.turbo',
  '.cache',
  '.idea',
  '.vs',
  'vendor',
  // .NET build outputs (folder names only, not file extensions)
  'bin',
  'obj',
  'packages',
  'TestResults',
]);

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
  const binary = buf.includes(0) || looksBinary(buf);
  if (binary) {
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
  let content = new TextDecoder('utf-8', { fatal: false }).decode(buf);
  const truncated = size > PREVIEW_MAX;
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

async function readPackContent(file: File): Promise<string> {
  if (file.size > PACK_MAX) {
    return `[File too large: ${file.size} bytes (limit ${PACK_MAX}), skipped]`;
  }
  try {
    const buf = new Uint8Array(await file.arrayBuffer());
    if (buf.includes(0) || looksBinary(buf)) {
      return `[Binary file - ${file.size} bytes, content omitted for LLM safety]`;
    }
    const text = new TextDecoder('utf-8', { fatal: false }).decode(buf);
    return `// [ptt read info] size=${file.size} bytes, encoding=utf-8, browser-mode=true\n${text}`;
  } catch (e) {
    return `[Error reading file: ${e instanceof Error ? e.message : String(e)}]`;
  }
}

export async function generateBrowserOutput(
  project: BrowserProject,
  selectedPaths: string[],
  format: string,
): Promise<string> {
  const selected = selectedPaths.map((p) => p.replace(/\\/g, '/'));
  const entries: { path: string; file: File }[] = [];
  for (const [path, file] of project.files) {
    if (selected.some((sp) => path === sp || path.startsWith(sp + '/'))) {
      entries.push({ path, file });
    }
  }
  entries.sort((a, b) => a.path.localeCompare(b.path));

  // Cap pack size in browser to keep UI responsive
  const MAX_PACK_FILES = 400;
  const limited = entries.slice(0, MAX_PACK_FILES);
  const truncatedNote =
    entries.length > MAX_PACK_FILES
      ? `\n<!-- packed first ${MAX_PACK_FILES} of ${entries.length} selected files (browser limit) -->\n`
      : '';

  if (format === 'json') {
    const files = [];
    for (const e of limited) {
      files.push({ path: e.path, size: e.file.size, content: await readPackContent(e.file) });
    }
    return JSON.stringify(
      {
        generator: 'ptt (ProjectToText) browser-mode',
        root: project.rootName,
        file_count: files.length,
        files,
      },
      null,
      2,
    );
  }

  if (format === 'markdown') {
    const parts = [
      `# Project Context`,
      `Generated from: \`${project.rootName}\` (browser mode)\n`,
      truncatedNote,
    ];
    for (const e of limited) {
      const content = await readPackContent(e.file);
      const ext = e.path.includes('.') ? e.path.split('.').pop() : '';
      const fence = content.includes('```') ? '~~~~' : '```';
      parts.push(`## \`${e.path}\`\n${fence}${ext}\n${content}\n${fence}\n`);
    }
    return parts.join('\n');
  }

  if (format === 'plain') {
    const parts = [
      `Project: ${project.rootName}`,
      '================================\n',
      truncatedNote,
    ];
    for (const e of limited) {
      parts.push(`>>> ${e.path}`, await readPackContent(e.file), '--------------------------------\n');
    }
    return parts.join('\n');
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
  for (const e of limited) lines.push(`    ${e.path}`);
  lines.push('  </directory_structure>', '  <files>');
  for (const e of limited) {
    const content = await readPackContent(e.file);
    const safe = content.split(']]>').join(']]]]><![CDATA[>');
    lines.push(
      `    <file path="${escapeXmlAttr(e.path)}">`,
      '      <![CDATA[',
      safe,
      '      ]]>',
      '    </file>',
    );
  }
  lines.push('  </files>', '</project_context>');
  return lines.join('\n');
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
