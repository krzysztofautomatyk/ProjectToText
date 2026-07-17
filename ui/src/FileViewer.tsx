import { useMemo } from 'react';
import {
  AppWindow,
  Code2,
  ExternalLink,
  FileCode2,
  Loader2,
  MoreHorizontal,
} from 'lucide-react';
import { highlightCode } from './syntax';

export interface FilePreviewData {
  path: string;
  relativePath: string;
  language: string;
  content: string;
  size: number;
  truncated: boolean;
  binary: boolean;
  absolutePath: string;
}

export function formatBytes(size?: number): string {
  if (size == null || size <= 0) return '0 B';
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(size < 10_240 ? 1 : 0)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

type Props = {
  preview: FilePreviewData | null;
  loading: boolean;
  error: string | null;
  onOpenDefault: () => void;
  onOpenWithCode: () => void;
  onOpenWithPicker: () => void;
  onOpenWithCommand: (cmd: string) => void;
};

const QUICK_APPS: { label: string; cmd: string; title: string }[] = [
  { label: 'VS Code', cmd: 'code', title: 'Open with Visual Studio Code (`code`)' },
  { label: 'VS Code Insiders', cmd: 'code-insiders', title: 'Open with VS Code Insiders' },
  { label: 'Cursor', cmd: 'cursor', title: 'Open with Cursor' },
  { label: 'Notepad++', cmd: 'notepad++', title: 'Open with Notepad++ (if on PATH)' },
];

export default function FileViewer({
  preview,
  loading,
  error,
  onOpenDefault,
  onOpenWithCode,
  onOpenWithPicker,
  onOpenWithCommand,
}: Props) {
  const html = useMemo(() => {
    if (!preview || preview.binary) return '';
    return highlightCode(preview.content, preview.language);
  }, [preview]);

  if (loading) {
    return (
      <div className="loading-center">
        <div className="title">
          <Loader2 size={18} className="spin icon-accent" /> Loading file…
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="empty-state">
        <div className="empty-title">Could not open file</div>
        <div className="empty-desc">{error}</div>
      </div>
    );
  }

  if (!preview) {
    return (
      <div className="empty-state">
        <div className="empty-icon">
          <FileCode2 size={24} />
        </div>
        <div className="empty-title">No file selected</div>
        <div className="empty-desc">
          Click a file in the tree to preview it with syntax highlighting. Use the
          checkbox to include files in the packed LLM output.
        </div>
      </div>
    );
  }

  return (
    <div className="file-viewer">
      <div className="file-viewer-toolbar">
        <div className="file-viewer-meta" title={preview.absolutePath}>
          <Code2 size={14} aria-hidden />
          <span className="file-viewer-path">{preview.relativePath}</span>
          <span className="file-viewer-chip">{preview.language}</span>
          <span className="file-viewer-chip">{formatBytes(preview.size)}</span>
          {preview.truncated && <span className="file-viewer-chip warn">truncated</span>}
          {preview.binary && <span className="file-viewer-chip warn">binary</span>}
        </div>
        <div className="file-viewer-actions" role="group" aria-label="Open file">
          <button
            type="button"
            className="btn"
            onClick={onOpenDefault}
            title="Open with the system default application"
          >
            <ExternalLink size={14} /> Default app
          </button>
          <button
            type="button"
            className="btn"
            onClick={onOpenWithCode}
            title="Open with VS Code (`code` on PATH)"
          >
            <AppWindow size={14} /> VS Code
          </button>
          <div className="open-with-menu">
            <details className="open-with-details">
              <summary className="btn" title="More open options">
                <MoreHorizontal size={14} /> Open with…
              </summary>
              <div className="open-with-dropdown" role="menu">
                {QUICK_APPS.map((a) => (
                  <button
                    key={a.cmd}
                    type="button"
                    role="menuitem"
                    className="open-with-item"
                    title={a.title}
                    onClick={() => onOpenWithCommand(a.cmd)}
                  >
                    {a.label}
                  </button>
                ))}
                <button
                  type="button"
                  role="menuitem"
                  className="open-with-item"
                  onClick={onOpenWithPicker}
                >
                  Choose program…
                </button>
              </div>
            </details>
          </div>
        </div>
      </div>

      {preview.binary ? (
        <pre className="output-text file-viewer-code">{preview.content}</pre>
      ) : (
        <pre className="hljs file-viewer-code">
          <code
            className={`language-${preview.language}`}
            dangerouslySetInnerHTML={{ __html: html }}
          />
        </pre>
      )}
    </div>
  );
}
