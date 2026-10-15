import { useCallback, useEffect, useRef, useState } from 'react';
import { type ToastKind } from './treeModel';

const TREE_WIDTH_KEY = 'ptt.treeWidth';
const THEME_KEY = 'ptt.theme';

export type ThemePref = 'light' | 'dark' | 'system';
type ResolvedTheme = 'light' | 'dark';

export function readThemePref(): ThemePref {
  try {
    const raw = localStorage.getItem(THEME_KEY);
    if (raw === 'light' || raw === 'dark' || raw === 'system') return raw;
  } catch {
    /* ignore */
  }
  return 'system';
}

export function resolveTheme(pref: ThemePref): ResolvedTheme {
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

export function themeLabel(pref: ThemePref): string {
  if (pref === 'light') return 'Light';
  if (pref === 'dark') return 'Dark';
  return 'System';
}

interface ThemeAndLayoutParams {
  currentPath: string;
  pushToast: (kind: ToastKind, message: string) => void;
}

export function useThemeAndLayout({ currentPath, pushToast }: ThemeAndLayoutParams) {
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

  const [themePref, setThemePref] = useState<ThemePref>(() => readThemePref());
  const [resolvedTheme, setResolvedTheme] = useState<ResolvedTheme>(() =>
    resolveTheme(readThemePref()),
  );

  const [treeScrollTop, setTreeScrollTop] = useState(0);
  const [treeViewportHeight, setTreeViewportHeight] = useState(600);
  const treeScrollRef = useRef<HTMLDivElement>(null);

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

  return {
    themePref,
    setThemePref,
    resolvedTheme,
    cycleTheme,
    treeWidth,
    setTreeWidth,
    resizing,
    setResizing,
    treeScrollTop,
    setTreeScrollTop,
    treeViewportHeight,
    treeScrollRef,
  };
}
