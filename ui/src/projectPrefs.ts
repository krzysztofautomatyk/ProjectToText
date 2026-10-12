/**
 * Custom project preferences — per-project “never pack” paths,
 * favorite flag, and a user-written note/comment.
 *
 * Persisted in localStorage under `ptt.projectPrefs`. Structure is kept
 * compatible with FolderHistoryEntry style parsing: defensive, tolerant of
 * missing fields, and de-duplicated by a stable path key.
 */

export interface ProjectPref {
  path: string;
  name: string;
  favorite: boolean;
  /** Free-form user comment describing why paths were deselected. */
  note: string;
  /** Relative (repo-root) paths deselected by the user that should be excluded. */
  deselectPaths: string[];
  lastUsedAt: number;
}

export const PROJECT_PREFS_KEY = 'ptt.projectPrefs';
export const MAX_PROJECT_PREFS = 60;

/** Stable key matching folderHistoryKey semantics. */
export function projectPrefKey(path: string): string {
  const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '');
  const stable = normalized || (path.startsWith('/') ? '/' : path);
  return /^[A-Za-z]:\//.test(stable) ? stable.toLowerCase() : stable;
}

function folderName(path: string): string {
  return path.split(/[/\\]/).filter(Boolean).pop() || path;
}

function parseProjectPref(raw: unknown): ProjectPref | null {
  if (!raw || typeof raw !== 'object') return null;
  const item = raw as Record<string, unknown>;
  const path = typeof item.path === 'string' ? item.path.trim() : '';
  if (!path) return null;

  const deselect = Array.isArray(item.deselectPaths)
    ? item.deselectPaths.filter((p): p is string => typeof p === 'string' && !!p.trim())
    : [];

  return {
    path,
    name:
      typeof item.name === 'string' && item.name.trim() ? item.name.trim() : folderName(path),
    favorite: item.favorite === true,
    note: typeof item.note === 'string' ? item.note : '',
    deselectPaths: deselect,
    lastUsedAt:
      typeof item.lastUsedAt === 'number' && Number.isFinite(item.lastUsedAt)
        ? item.lastUsedAt
        : 0,
  };
}

export function parseProjectPrefs(raw: string | null): ProjectPref[] {
  if (!raw) return [];
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    const seen = new Map<string, ProjectPref>();
    for (const item of value) {
      const pref = parseProjectPref(item);
      if (!pref) continue;
      const key = projectPrefKey(pref.path);
      const existing = seen.get(key);
      if (!existing || pref.lastUsedAt >= existing.lastUsedAt) seen.set(key, pref);
    }
    return [...seen.values()].sort(sortProjectPrefs);
  } catch {
    return [];
  }
}

/** Favorites first, then most-recently used. */
export function sortProjectPrefs(a: ProjectPref, b: ProjectPref): number {
  return Number(b.favorite) - Number(a.favorite) || b.lastUsedAt - a.lastUsedAt;
}

export function readProjectPrefs(): ProjectPref[] {
  try {
    return parseProjectPrefs(localStorage.getItem(PROJECT_PREFS_KEY));
  } catch {
    return [];
  }
}

export function writeProjectPrefs(prefs: ProjectPref[]): void {
  try {
    localStorage.setItem(PROJECT_PREFS_KEY, JSON.stringify(prefs));
  } catch {
    /* Storage disabled or full — prefs are a convenience feature. */
  }
}

export function rememberProject(
  prefs: ProjectPref[],
  path: string,
  now = Date.now(),
): ProjectPref[] {
  const cleanPath = path.trim();
  if (!cleanPath) return prefs;

  const key = projectPrefKey(cleanPath);
  const existing = prefs.find((p) => projectPrefKey(p.path) === key);
  const merged: ProjectPref = existing
    ? { ...existing, lastUsedAt: now }
    : {
        path: cleanPath,
        name: folderName(cleanPath),
        favorite: false,
        note: '',
        deselectPaths: [],
        lastUsedAt: now,
      };

  const next = prefs.filter((p) => projectPrefKey(p.path) !== key);
  next.push(merged);
  return next.sort(sortProjectPrefs).slice(0, MAX_PROJECT_PREFS);
}

export function setProjectFavorite(
  prefs: ProjectPref[],
  path: string,
  favorite: boolean,
): ProjectPref[] {
  const key = projectPrefKey(path);
  return prefs
    .map((p) => (projectPrefKey(p.path) === key ? { ...p, favorite } : p))
    .sort(sortProjectPrefs);
}

export function setProjectNote(
  prefs: ProjectPref[],
  path: string,
  note: string,
): ProjectPref[] {
  const key = projectPrefKey(path);
  return prefs.map((p) => (projectPrefKey(p.path) === key ? { ...p, note } : p));
}

export function addDeselectPaths(
  prefs: ProjectPref[],
  path: string,
  paths: string[],
): ProjectPref[] {
  return updateDeselectPaths(prefs, path, paths, unionNormalized);
}

export function removeDeselectPaths(
  prefs: ProjectPref[],
  path: string,
  paths: string[],
): ProjectPref[] {
  return updateDeselectPaths(prefs, path, paths, differenceNormalized);
}

function normalizeDeselectPath(p: string): string {
  return p.replace(/\\/g, '/');
}

function unionNormalized(a: string[], b: string[]): string[] {
  const merged = new Set([...a.map(normalizeDeselectPath), ...b.map(normalizeDeselectPath)]);
  return [...merged];
}

function differenceNormalized(a: string[], b: string[]): string[] {
  const removals = new Set(b.map(normalizeDeselectPath));
  return a.filter((p) => !removals.has(normalizeDeselectPath(p)));
}

function updateDeselectPaths(
  prefs: ProjectPref[],
  path: string,
  paths: string[],
  combine: (current: string[], incoming: string[]) => string[],
): ProjectPref[] {
  if (paths.length === 0) return prefs;
  const key = projectPrefKey(path);
  return prefs.map((p) => {
    if (projectPrefKey(p.path) !== key) return p;
    const next = combine(p.deselectPaths, paths);
    return next === p.deselectPaths ? p : { ...p, deselectPaths: next };
  });
}

export interface DeselectDelta {
  /** Files the user just unchecked — must be excluded on replay. */
  turnedOff: string[];
  /** Files the user just re-checked — must no longer be excluded. */
  turnedOn: string[];
}

/** Apply one user selection action to the saved replay list. */
export function applyDeselectDelta(
  prefs: ProjectPref[],
  path: string,
  delta: DeselectDelta,
): ProjectPref[] {
  if (delta.turnedOn.length > 0) prefs = removeDeselectPaths(prefs, path, delta.turnedOn);
  if (delta.turnedOff.length > 0) prefs = addDeselectPaths(prefs, path, delta.turnedOff);
  return prefs;
}

export function clearDeselectPaths(prefs: ProjectPref[], path: string): ProjectPref[] {
  const key = projectPrefKey(path);
  return prefs.map((p) =>
    projectPrefKey(p.path) === key ? { ...p, deselectPaths: [] } : p,
  );
}

export function removeProject(prefs: ProjectPref[], path: string): ProjectPref[] {
  const key = projectPrefKey(path);
  return prefs.filter((p) => projectPrefKey(p.path) !== key);
}
