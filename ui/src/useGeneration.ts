import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { downloadText, generateBrowserOutputWithStats, type BrowserProject } from './browserFs';
import { redactSecretsWithReport, type RedactionSummary } from './secrets';
import { isTauriRuntime } from './tauriEnv';
import { type FileNode, type PackOptions, type FileTokenStat, type PackTokenStats, type GenerateOutputResponse, type OutputFormat, type ToastKind, normalizePath, formatTokens, estimateTokens } from './treeModel';
import type { MutableRefObject } from 'react';

const IN_TAURI = isTauriRuntime();

interface GenerationParams {
  currentPath: string;
  nodes: FileNode[];
  format: OutputFormat;
  taskPrompt: string;
  pushToast: (kind: ToastKind, message: string) => void;
  browserProjectRef: MutableRefObject<BrowserProject | null>;
  workspaceRevision: MutableRefObject<number>;
}

export function useGeneration({ currentPath, nodes, format, taskPrompt, pushToast, browserProjectRef, workspaceRevision }: GenerationParams) {
  const [output, setOutput] = useState('');
  const [generating, setGenerating] = useState(false);
  const [stats, setStats] = useState<PackTokenStats>({ files: 0, tokens: 0 });
  const genSeq = useRef(0);
  const hasLoadedOnce = useRef(false);
  const generateTimer = useRef<number | null>(null);
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
  const [includeGitDiff, setIncludeGitDiff] = useState(false);
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
            includeSummary: true,
          });
          if (seq !== genSeq.current) return;
          setOutput(res.text);
          setFullOutputText(res.text);
          setTruncatedPreview(res.text.length > 150_000 && !wantFullPreview);
          setTotalBytes(new Blob([res.text]).size);
          setRedactionSummary(res.redactions);
          setFileTokens(res.fileTokens);
          setFullOutputPreview(wantFullPreview);
          const totalContentTokens = res.fileTokens.reduce((sum, f) => sum + f.tokens, 0);
          const totalTokens = estimateTokens(res.text);
          const overheadTokens = Math.max(0, totalTokens - totalContentTokens);
          setStats({
            files: sel.length,
            tokens: totalTokens,
            contentTokens: totalContentTokens,
            overheadTokens: overheadTokens,
            tokenizerExact: false,
          });
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
            setStats({
              files: sel.length,
              tokens: estimateTokens(raw),
              tokenizerExact: false,
            });
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
              contentTokens: raw.contentTokens,
              overheadTokens: raw.overheadTokens,
              tokenizerExact: raw.tokenizerExact ?? Boolean(raw.totalTokens),
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

  // Cleanup debounce on unmount
  useEffect(() => {
    return () => {
      if (generateTimer.current != null) window.clearTimeout(generateTimer.current);
    };
  }, []);

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

  return {
    output,
    setOutput,
    generating,
    setGenerating,
    stats,
    setStats,
    fullOutputPreview,
    setFullOutputPreview,
    fullOutputText,
    setFullOutputText,
    truncatedPreview,
    setTruncatedPreview,
    totalBytes,
    setTotalBytes,
    redactSecretsEnabled,
    setRedactSecretsEnabled,
    redactionSummary,
    setRedactionSummary,
    skeletonSet,
    setSkeletonSet,
    fileTokens,
    setFileTokens,
    includeGitDiff,
    setIncludeGitDiff,
    genSeq,
    hasLoadedOnce,
    generateTimer,
    generate,
    generateNow,
    handleToggleFullPreview,
    handleCopy,
    handleSave,
  };
}
