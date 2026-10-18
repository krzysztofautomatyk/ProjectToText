import { useEffect, useState } from 'react';
import {
  AppWindow,
  Code2,
  ExternalLink,
  FileCode2,
  Loader2,
  MoreHorizontal,
} from 'lucide-react';
import { highlightCode } from './syntax';
import { useI18n, type TranslationKey } from './i18n';

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

const QUICK_APPS: { label: string; cmd: string; titleKey: TranslationKey }[] = [
  { label: 'VS Code', cmd: 'code', titleKey: 'viewer.app.code' },
  { label: 'VS Code Insiders', cmd: 'code-insiders', titleKey: 'viewer.app.codeInsiders' },
  { label: 'Cursor', cmd: 'cursor', titleKey: 'viewer.app.cursor' },
  { label: 'Notepad++', cmd: 'notepad++', titleKey: 'viewer.app.notepad' },
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
  const { t } = useI18n();
  const [highlightedHtml, setHighlightedHtml] = useState<string>('');
  const [isHighlighting, setIsHighlighting] = useState(false);

  useEffect(() => {
    if (!preview || preview.binary) {
      setHighlightedHtml('');
      setIsHighlighting(false);
      return;
    }

    // Fast path: small files (< 20 KB) highlight immediately
    if (preview.content.length < 20_000) {
      setHighlightedHtml(highlightCode(preview.content, preview.language));
      setIsHighlighting(false);
      return;
    }

    // Large files: display plain text immediately, defer heavy AST highlight off the main animation frame
    setIsHighlighting(true);
    let active = true;
    const timer = setTimeout(() => {
      if (!active) return;
      // Cap highlight at 250 KB for memory & DOM performance
      const capped =
        preview.content.length > 250_000
          ? preview.content.slice(0, 250_000)
          : preview.content;
      const res = highlightCode(capped, preview.language);
      if (active) {
        setHighlightedHtml(
          preview.content.length > 250_000
            ? `${res}\n\n/* ... [syntax highlighting capped at 250 KB for smooth UI performance] ... */`
            : res,
        );
        setIsHighlighting(false);
      }
    }, 16);

    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [preview]);

  if (loading) {
    return (
      <div className="loading-center">
        <div className="title">
          <Loader2 size={18} className="spin icon-accent" /> {t('viewer.loading')}
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="empty-state">
        <div className="empty-title">{t('viewer.errorTitle')}</div>
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
        <div className="empty-title">{t('viewer.noneTitle')}</div>
        <div className="empty-desc">{t('viewer.noneDesc')}</div>
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
          {preview.truncated && <span className="file-viewer-chip warn">{t('viewer.truncated')}</span>}
          {preview.binary && <span className="file-viewer-chip warn">{t('viewer.binary')}</span>}
          {isHighlighting && <span className="file-viewer-chip">{t('viewer.highlighting')}</span>}
        </div>
        <div className="file-viewer-actions" role="group" aria-label={t('viewer.openGroup')}>
          <button
            type="button"
            className="btn"
            onClick={onOpenDefault}
            title={t('viewer.defaultTitle')}
          >
            <ExternalLink size={14} /> {t('viewer.defaultApp')}
          </button>
          <button
            type="button"
            className="btn"
            onClick={onOpenWithCode}
            title={t('viewer.codeTitle')}
          >
            <AppWindow size={14} /> VS Code
          </button>
          <div className="open-with-menu">
            <details className="open-with-details">
              <summary className="btn" title={t('viewer.moreTitle')}>
                <MoreHorizontal size={14} /> {t('viewer.openWith')}
              </summary>
              <div className="open-with-dropdown" role="menu">
                {QUICK_APPS.map((a) => (
                  <button
                    key={a.cmd}
                    type="button"
                    role="menuitem"
                    className="open-with-item"
                    title={t(a.titleKey)}
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
                  {t('viewer.chooseProgram')}
                </button>
              </div>
            </details>
          </div>
        </div>
      </div>

      {preview.binary ? (
        <pre className="output-text file-viewer-code">{preview.content}</pre>
      ) : highlightedHtml ? (
        <pre className="hljs file-viewer-code">
          <code
            className={`language-${preview.language}`}
            dangerouslySetInnerHTML={{ __html: highlightedHtml }}
          />
        </pre>
      ) : (
        <pre className="hljs file-viewer-code">
          <code className={`language-${preview.language}`}>
            {preview.content}
          </code>
        </pre>
      )}
    </div>
  );
}
