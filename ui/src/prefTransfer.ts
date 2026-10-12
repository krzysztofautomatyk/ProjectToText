/**
 * Export / import of all persistent ptt preferences (custom projects
 * `ptt.projectPrefs` + folder history `ptt.folderHistory`) as a single JSON
 * snapshot file. Import merges defensively: unknown fields are dropped and
 * entries are keyed by stable path keys (Windows/Unix path separator aware).
 */

import { projectPrefKey, type ProjectPref } from './projectPrefs';
import { folderHistoryKey, type FolderHistoryEntry } from './folderHistory';

export const PREF_SNAPSHOT_VERSION = 1;

export interface PrefSnapshot {
  app: 'ptt';
  version: number;
  exportedAt: string;
  projects: unknown[];
  history: unknown[];
}

export interface PrefMergeResult {
  projects: ProjectPref[];
  history: FolderHistoryEntry[];
  projectsImported: number;
  historyImported: number;
  skipped: number;
}

/* ─── raw item validators (mirror the parsers in the owning modules) ── */

interface RawProjectPref {
  path: string;
  name: string;
  favorite: boolean;
  note: string;
  deselectPaths: string[];
  lastUsedAt: number;
}

function parseRawProjectPref(raw: unknown): RawProjectPref | null {
  if (!raw || typeof raw !== 'object') return null;
  const item = raw as Record<string, unknown>;
  const path = typeof item.path === 'string' ? item.path.trim() : '';
  if (!path) return null;
  const deselectPaths = Array.isArray(item.deselectPaths)
    ? item.deselectPaths.filter(
        (p): p is string => typeof p === 'string' && p.trim().length > 0,
      )
    : [];
  return {
    path,
    name:
      typeof item.name === 'string' && item.name.trim() ? item.name.trim() : path,
    favorite: item.favorite === true,
    note: typeof item.note === 'string' ? item.note : '',
    deselectPaths,
    lastUsedAt:
      typeof item.lastUsedAt === 'number' && Number.isFinite(item.lastUsedAt)
        ? item.lastUsedAt
        : 0,
  };
}

interface RawHistoryEntry {
  path: string;
  name: string;
  pinned: boolean;
  lastOpenedAt: number;
}

function parseRawHistoryEntry(raw: unknown): RawHistoryEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const item = raw as Record<string, unknown>;
  const path = typeof item.path === 'string' ? item.path.trim() : '';
  if (!path) return null;
  return {
    path,
    name:
      typeof item.name === 'string' && item.name.trim() ? item.name.trim() : path,
    pinned: item.pinned === true,
    lastOpenedAt:
      typeof item.lastOpenedAt === 'number' && Number.isFinite(item.lastOpenedAt)
        ? item.lastOpenedAt
        : 0,
  };
}

/* ─── export ─────────────────────────────────────────── */

export function buildPrefSnapshot(
  projects: ProjectPref[],
  history: FolderHistoryEntry[],
): PrefSnapshot {
  return {
    app: 'ptt',
    version: PREF_SNAPSHOT_VERSION,
    exportedAt: new Date().toISOString(),
    projects: projects.map(({ path, name, favorite, note, deselectPaths, lastUsedAt }) => ({
      path,
      name,
      favorite,
      note,
      deselectPaths,
      lastUsedAt,
    })),
    history: history.map(({ path, name, pinned, lastOpenedAt }) => ({
      path,
      name,
      pinned,
      lastOpenedAt,
    })),
  };
}

/** Parse a snapshot file's text. Throws with a short user-facing reason. */
export function parsePrefSnapshot(text: string): PrefSnapshot {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error('Not a valid JSON file');
  }
  if (!value || typeof value !== 'object') {
    throw new Error('File does not contain a ptt snapshot');
  }
  const obj = value as Record<string, unknown>;
  if (obj.app !== 'ptt' || !Array.isArray(obj.projects)) {
    throw new Error('File is not a ptt preferences snapshot');
  }
  return {
    app: 'ptt',
    version: typeof obj.version === 'number' ? obj.version : 1,
    exportedAt: typeof obj.exportedAt === 'string' ? obj.exportedAt : '',
    projects: obj.projects,
    history: Array.isArray(obj.history) ? obj.history : [],
  };
}

/* ─── merge ──────────────────────────────────────────── */

/**
 * Merge snapshot entries into the current state.
 * Import never deletes existing local entries; for the same project key the
 * fresher timestamps win, and boolean flags are OR-ed (favorite/pinned stick).
 */
export function mergePrefSnapshot(
  snapshot: PrefSnapshot,
  currentProjects: ProjectPref[],
  currentHistory: FolderHistoryEntry[],
): PrefMergeResult {
  let skipped = 0;

  const projects = new Map(currentProjects.map((p) => [projectPrefKey(p.path), p]));
  let projectsImported = 0;
  for (const raw of snapshot.projects) {
    const incoming = parseRawProjectPref(raw);
    if (!incoming) {
      skipped++;
      continue;
    }
    const key = projectPrefKey(incoming.path);
    const existing = projects.get(key);
    if (
      !existing ||
      incoming.lastUsedAt > existing.lastUsedAt ||
      (incoming.favorite && !existing.favorite)
    ) {
      projects.set(key, existing ? mergeProject(existing, incoming) : incoming);
      projectsImported++;
    }
  }

  const history = new Map(currentHistory.map((e) => [folderHistoryKey(e.path), e]));
  let historyImported = 0;
  for (const raw of snapshot.history) {
    const incoming = parseRawHistoryEntry(raw);
    if (!incoming) {
      skipped++;
      continue;
    }
    const key = folderHistoryKey(incoming.path);
    const existing = history.get(key);
    if (
      !existing ||
      incoming.lastOpenedAt > existing.lastOpenedAt ||
      (incoming.pinned && !existing.pinned)
    ) {
      history.set(key, existing ? mergeHistory(existing, incoming) : incoming);
      historyImported++;
    }
  }

  return {
    projects: [...projects.values()],
    history: [...history.values()],
    projectsImported,
    historyImported,
    skipped,
  };
}

function mergeProject(a: ProjectPref, b: RawProjectPref): ProjectPref {
  return {
    ...a,
    favorite: a.favorite || b.favorite,
    note: (b.lastUsedAt >= a.lastUsedAt ? b.note : a.note) || a.note || b.note,
    deselectPaths:
      b.lastUsedAt >= a.lastUsedAt && b.deselectPaths.length > 0
        ? b.deselectPaths
        : a.deselectPaths,
    lastUsedAt: Math.max(a.lastUsedAt, b.lastUsedAt),
  };
}

function mergeHistory(a: FolderHistoryEntry, b: RawHistoryEntry): FolderHistoryEntry {
  return {
    ...a,
    name: b.name || a.name,
    pinned: a.pinned || b.pinned,
    lastOpenedAt: Math.max(a.lastOpenedAt, b.lastOpenedAt),
  };
}

/** Default filename for the snapshot download/save dialog. */
export function snapshotFileName(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `ptt-prefs-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}.json`;
}
