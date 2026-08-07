export interface FolderHistoryEntry {
  path: string;
  name: string;
  pinned: boolean;
  lastOpenedAt: number;
}

export const FOLDER_HISTORY_KEY = 'ptt.folderHistory';
export const MAX_FOLDER_HISTORY = 24;

function folderName(path: string): string {
  return path.split(/[/\\]/).filter(Boolean).pop() || path;
}

/** Stable enough for deduplication across Windows path separators/casing. */
export function folderHistoryKey(path: string): string {
  const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '');
  const stable = normalized || (path.startsWith('/') ? '/' : path);
  return /^[A-Za-z]:\//.test(stable) ? stable.toLowerCase() : stable;
}

function sortHistory(entries: FolderHistoryEntry[]): FolderHistoryEntry[] {
  return [...entries].sort(
    (a, b) => Number(b.pinned) - Number(a.pinned) || b.lastOpenedAt - a.lastOpenedAt,
  );
}

/** Parse defensively so a malformed localStorage value cannot break the app. */
export function parseFolderHistory(raw: string | null): FolderHistoryEntry[] {
  if (!raw) return [];

  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return [];

    const unique = new Map<string, FolderHistoryEntry>();
    for (const item of value) {
      if (!item || typeof item !== 'object') continue;
      const candidate = item as Record<string, unknown>;
      const path = typeof candidate.path === 'string' ? candidate.path.trim() : '';
      if (!path) continue;

      const key = folderHistoryKey(path);
      const existing = unique.get(key);
      const timestamp =
        typeof candidate.lastOpenedAt === 'number' && Number.isFinite(candidate.lastOpenedAt)
          ? candidate.lastOpenedAt
          : 0;
      const entry: FolderHistoryEntry = {
        path,
        name:
          typeof candidate.name === 'string' && candidate.name.trim()
            ? candidate.name.trim()
            : folderName(path),
        pinned: candidate.pinned === true,
        lastOpenedAt: timestamp,
      };

      if (!existing || entry.lastOpenedAt > existing.lastOpenedAt) {
        unique.set(key, {
          ...entry,
          pinned: entry.pinned || existing?.pinned === true,
        });
      } else if (entry.pinned && !existing.pinned) {
        unique.set(key, { ...existing, pinned: true });
      }
    }

    return sortHistory([...unique.values()]).slice(0, MAX_FOLDER_HISTORY);
  } catch {
    return [];
  }
}

export function readFolderHistory(): FolderHistoryEntry[] {
  try {
    return parseFolderHistory(localStorage.getItem(FOLDER_HISTORY_KEY));
  } catch {
    return [];
  }
}

export function writeFolderHistory(entries: FolderHistoryEntry[]): void {
  try {
    localStorage.setItem(FOLDER_HISTORY_KEY, JSON.stringify(entries));
  } catch {
    /* Storage may be disabled or full; history is a convenience feature. */
  }
}

export function rememberFolder(
  entries: FolderHistoryEntry[],
  path: string,
  now = Date.now(),
): FolderHistoryEntry[] {
  const cleanPath = path.trim();
  if (!cleanPath) return entries;

  const key = folderHistoryKey(cleanPath);
  const existing = entries.find((entry) => folderHistoryKey(entry.path) === key);
  const next = entries.filter((entry) => folderHistoryKey(entry.path) !== key);

  next.push({
    path: cleanPath,
    name: existing?.name || folderName(cleanPath),
    pinned: existing?.pinned === true,
    lastOpenedAt: now,
  });

  return sortHistory(next).slice(0, MAX_FOLDER_HISTORY);
}

export function setFolderPinned(
  entries: FolderHistoryEntry[],
  path: string,
  pinned: boolean,
): FolderHistoryEntry[] {
  const key = folderHistoryKey(path);
  return sortHistory(
    entries.map((entry) =>
      folderHistoryKey(entry.path) === key ? { ...entry, pinned } : entry,
    ),
  );
}

export function removeFolder(
  entries: FolderHistoryEntry[],
  path: string,
): FolderHistoryEntry[] {
  const key = folderHistoryKey(path);
  return entries.filter((entry) => folderHistoryKey(entry.path) !== key);
}
