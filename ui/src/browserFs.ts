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
  'build',
  'out',
  'bin',
  'obj',
  '.next',
  'coverage',
  '__pycache__',
  '.turbo',
  '.cache',
  '.idea',
  '.vs',
  'vendor',
]);

export type BrowserFileMap = Map<string, File>;

export interface BrowserProject {
  rootName: string;
  /** Relative POSIX paths → File blobs */
  files: BrowserFileMap;
}

function isJunkDir(name: string): boolean {
  return JUNK_DIR_NAMES.has(name.toLowerCase());
}

/** Recursively list a FileSystemDirectoryHandle into flat nodes + file map. */
export async function scanDirectoryHandle(
  root: FileSystemDirectoryHandle,
): Promise<{ nodes: BrowserFileNode[]; project: BrowserProject }> {
  const files: BrowserFileMap = new Map();
  const dirPaths = new Set<string>();

  async function walk(dir: FileSystemDirectoryHandle, prefix: string) {
    // for-await over directory entries
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for await (const [name, handle] of (dir as any).entries() as AsyncIterable<
      [string, FileSystemHandle]
    >) {
      const rel = prefix ? `${prefix}/${name}` : name;
      if (handle.kind === 'directory') {
        if (isJunkDir(name)) continue;
        dirPaths.add(rel);
        await walk(handle as FileSystemDirectoryHandle, rel);
      } else if (handle.kind === 'file') {
        const file = await (handle as FileSystemFileHandle).getFile();
        files.set(rel.replace(/\\/g, '/'), file);
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
    project: { rootName: root.name, files },
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
    const relFull = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
    const parts = relFull.replace(/\\/g, '/').split('/').filter(Boolean);
    if (parts.length === 0) continue;
    if (parts.length === 1) {
      files.set(parts[0], file);
      continue;
    }
    rootName = parts[0];
    // Skip junk directory segments
    if (parts.some((p, i) => i > 0 && i < parts.length - 1 && isJunkDir(p))) {
      // if any intermediate folder is junk, skip (except root name)
      let skip = false;
      for (let i = 1; i < parts.length - 1; i++) {
        if (isJunkDir(parts[i])) {
          skip = true;
          break;
        }
      }
      if (skip) continue;
    }
    const rel = parts.slice(1).join('/');
    // collect parent dirs
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
  return w.showDirectoryPicker({ mode: 'read' });
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
    input.style.display = 'none';
    const cleanup = () => {
      input.remove();
    };
    input.addEventListener('change', () => {
      const files = input.files;
      cleanup();
      if (files && files.length > 0) resolve(files);
      else reject(new Error('No folder selected'));
    });
    // If user cancels, some browsers never fire change — soft timeout not reliable.
    // focus return heuristic:
    const onFocus = () => {
      window.setTimeout(() => {
        if (!input.files || input.files.length === 0) {
          cleanup();
          window.removeEventListener('focus', onFocus);
          // Don't reject immediately; change may still fire. Only reject if empty after delay.
        }
      }, 500);
    };
    window.addEventListener('focus', onFocus, { once: true });
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
  const file = project.files.get(relativePath.replace(/\\/g, '/'));
  if (!file) throw new Error(`File not found: ${relativePath}`);
  const size = file.size;
  if (size === 0) {
    return {
      path: file.name,
      relativePath,
      language: guessLang(relativePath),
      content: '',
      size: 0,
      truncated: false,
      binary: false,
      absolutePath: `${project.rootName}/${relativePath}`,
    };
  }
  const slice = file.slice(0, Math.min(size, PREVIEW_MAX));
  const buf = new Uint8Array(await slice.arrayBuffer());
  const binary = buf.includes(0) || looksBinary(buf);
  if (binary) {
    return {
      path: file.name,
      relativePath,
      language: 'plaintext',
      content: `[Binary file — ${size} bytes. Open with an external app to view.]`,
      size,
      truncated: false,
      binary: true,
      absolutePath: `${project.rootName}/${relativePath}`,
    };
  }
  let content = new TextDecoder('utf-8', { fatal: false }).decode(buf);
  const truncated = size > PREVIEW_MAX;
  if (truncated) {
    content += `\n\n// … truncated for preview (${size} bytes total) …`;
  }
  return {
    path: file.name,
    relativePath,
    language: guessLang(relativePath),
    content,
    size,
    truncated,
    binary: false,
    absolutePath: `${project.rootName}/${relativePath}`,
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
  const buf = new Uint8Array(await file.arrayBuffer());
  if (buf.includes(0) || looksBinary(buf)) {
    return `[Binary file - ${file.size} bytes, content omitted for LLM safety]`;
  }
  const text = new TextDecoder('utf-8', { fatal: false }).decode(buf);
  return `// [ptt read info] size=${file.size} bytes, encoding=utf-8, browser-mode=true\n${text}`;
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

  if (format === 'json') {
    const files = [];
    for (const e of entries) {
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
    const parts = [`# Project Context`, `Generated from: \`${project.rootName}\` (browser mode)\n`];
    for (const e of entries) {
      const content = await readPackContent(e.file);
      const ext = e.path.includes('.') ? e.path.split('.').pop() : '';
      const fence = content.includes('```') ? '~~~~' : '```';
      parts.push(`## \`${e.path}\`\n${fence}${ext}\n${content}\n${fence}\n`);
    }
    return parts.join('\n');
  }

  if (format === 'plain') {
    const parts = [`Project: ${project.rootName}`, '================================\n'];
    for (const e of entries) {
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
    `    Total files included: ${entries.length}`,
    '  </file_summary>',
    '  <directory_structure>',
  ];
  for (const e of entries) lines.push(`    ${e.path}`);
  lines.push('  </directory_structure>', '  <files>');
  for (const e of entries) {
    const content = await readPackContent(e.file);
    // CDATA-safe split
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
