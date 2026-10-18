/**
 * Export / import of all persistent ptt preferences (custom projects
 * `ptt.projectPrefs` + folder history `ptt.folderHistory` + Prompt Studio
 * `ptt.promptStudio.v2`) as a single JSON snapshot file. Import merges
 * defensively: unknown fields are dropped and entries are keyed by stable
 * path keys (Windows/Unix path separator aware). The optional `i18n` block
 * carries the active UI language and custom language packs (`ptt.i18n.v1`).
 */

import {
  computePromptHash,
  loadPromptStudioStore,
  parseCustomPromptTemplate,
  savePromptStudioStore,
  type CustomPromptTemplate,
  type PromptStudioStore,
  type ProjectPref,
  projectPrefKey,
} from './projectPrefs';
import { folderHistoryKey, type FolderHistoryEntry } from './folderHistory';
import { redactSecretsWithReport } from './secrets';
import {
  isLocaleAvailable,
  loadI18nState,
  mergeLanguagePacks,
  sanitizeI18nState,
  saveI18nState,
  validateAndSanitizeLanguagePack,
  type I18nState,
  type LanguagePack,
} from './i18n';

export const PREF_SNAPSHOT_VERSION = 2;

export interface PromptStudioExport {
  schemaVersion: 2;
  customPrompts: CustomPromptTemplate[];
  globalDefaultPromptId: string | null;
  workspaceDefaultPromptMap: Record<string, string>;
  autoApplyDefaultOnOpen: boolean;
}

export interface I18nExport {
  activeLocale: string;
  customPacks: LanguagePack[];
}

export interface PrefSnapshot {
  app: 'ptt';
  version: number;
  exportedAt: string;
  projects: unknown[];
  history: unknown[];
  promptStudio?: PromptStudioExport;
  i18n?: I18nExport;
}

export interface PromptSecretWarning {
  promptName: string;
  findingsCount: number;
}

export interface PromptStudioMergeStats {
  addedCount: number;
  updatedCount: number;
  skippedDuplicates: number;
  backedUpCount: number;
}

export interface PrefMergeResult {
  projects: ProjectPref[];
  history: FolderHistoryEntry[];
  projectsImported: number;
  historyImported: number;
  skipped: number;
  promptStudio?: PromptStudioStore;
  promptStats?: PromptStudioMergeStats;
  /** Resulting i18n state to persist (only when the snapshot carried an `i18n` block). */
  i18n?: I18nState;
  secretWarnings: PromptSecretWarning[];
  importedDefaultPromptId: string | null;
  importedDefaultPromptName: string | null;
}

export type PrefImportMode = 'merge' | 'replace';

export interface PrefImportOptions {
  mode?: PrefImportMode;
  /** When true, apply imported globalDefaultPromptId if it resolves. */
  applyImportedDefault?: boolean;
  /** Local i18n state to merge into (defaults to the persisted one). */
  currentI18n?: I18nState;
}

export interface PrefImportPreview {
  projectsCount: number;
  historyCount: number;
  promptsNew: number;
  promptsUpdated: number;
  promptsDuplicates: number;
  defaultPromptName: string | null;
  defaultPromptId: string | null;
  secretWarnings: PromptSecretWarning[];
  hasPromptStudio: boolean;
  hasI18n: boolean;
  i18nPacksCount: number;
  i18nActiveLocale: string | null;
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

function parsePromptStudioExport(raw: unknown): PromptStudioExport | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const obj = raw as Record<string, unknown>;
  const customPrompts = Array.isArray(obj.customPrompts)
    ? obj.customPrompts
        .map((p) => parseCustomPromptTemplate(p))
        .filter((p): p is CustomPromptTemplate => p !== null && !p.isBuiltIn)
    : [];
  const map: Record<string, string> = {};
  if (obj.workspaceDefaultPromptMap && typeof obj.workspaceDefaultPromptMap === 'object') {
    for (const [k, v] of Object.entries(obj.workspaceDefaultPromptMap as Record<string, unknown>)) {
      if (typeof k === 'string' && typeof v === 'string' && k.trim() && v.trim()) {
        map[k] = v;
      }
    }
  }
  return {
    schemaVersion: 2,
    customPrompts,
    globalDefaultPromptId:
      typeof obj.globalDefaultPromptId === 'string' ? obj.globalDefaultPromptId : null,
    workspaceDefaultPromptMap: map,
    autoApplyDefaultOnOpen: obj.autoApplyDefaultOnOpen !== false,
  };
}

function parseI18nExport(raw: unknown): I18nExport | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const obj = raw as Record<string, unknown>;
  if (!Array.isArray(obj.customPacks) && typeof obj.activeLocale !== 'string') return undefined;
  const customPacks: LanguagePack[] = [];
  if (Array.isArray(obj.customPacks)) {
    for (const candidate of obj.customPacks) {
      const result = validateAndSanitizeLanguagePack(candidate);
      if (result.ok && result.pack) customPacks.push(result.pack);
    }
  }
  const requested =
    typeof obj.activeLocale === 'string' ? obj.activeLocale.trim().toLowerCase() : 'en';
  return { activeLocale: requested, customPacks };
}

function scanPromptSecrets(prompts: CustomPromptTemplate[]): PromptSecretWarning[] {
  const warnings: PromptSecretWarning[] = [];
  for (const p of prompts) {
    const { summary } = redactSecretsWithReport(p.content);
    if (summary.totalRedactions > 0) {
      warnings.push({ promptName: p.name, findingsCount: summary.totalRedactions });
    }
  }
  return warnings;
}

function uniqueBackupName(base: string, existing: Set<string>, suffix: string): string {
  const cleaned = base.replace(/\s*\((Lokalna kopia|Import|Kopia)(?:\s+\d+)?\)\s*$/i, '').trim();
  let name = `${cleaned} (${suffix})`;
  let n = 2;
  while (existing.has(name.trim().toLowerCase())) {
    name = `${cleaned} (${suffix} ${n})`;
    n += 1;
  }
  return name;
}

function newImportId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `custom-${crypto.randomUUID()}`;
  }
  return `custom-imp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Merge imported custom prompts into local list without data loss.
 * Identical contentHash → skip; same id/name with different hash → keep both
 * (newer wins as primary, older kept as backup copy).
 */
export function mergeCustomPrompts(
  local: CustomPromptTemplate[],
  imported: CustomPromptTemplate[],
): { prompts: CustomPromptTemplate[]; stats: PromptStudioMergeStats } {
  const prompts = local.map((p) => ({ ...p }));
  const stats: PromptStudioMergeStats = {
    addedCount: 0,
    updatedCount: 0,
    skippedDuplicates: 0,
    backedUpCount: 0,
  };
  const byHash = new Map(prompts.map((p) => [p.contentHash, p]));
  const byId = new Map(prompts.map((p) => [p.id, p]));
  const byName = new Map(prompts.map((p) => [p.name.trim().toLowerCase(), p]));
  const nameSet = new Set(prompts.map((p) => p.name.trim().toLowerCase()));

  for (const incoming of imported) {
    if (byHash.has(incoming.contentHash)) {
      stats.skippedDuplicates += 1;
      continue;
    }
    const sameId = byId.get(incoming.id);
    const sameName = byName.get(incoming.name.trim().toLowerCase());
    const conflict = sameId ?? sameName;
    if (conflict && conflict.contentHash !== incoming.contentHash) {
      const incomingNewer =
        Date.parse(incoming.updatedAt) >= Date.parse(conflict.updatedAt);
      if (incomingNewer) {
        const backupName = uniqueBackupName(conflict.name, nameSet, 'Lokalna kopia');
        const backup: CustomPromptTemplate = {
          ...conflict,
          id: newImportId(),
          name: backupName,
          contentHash: computePromptHash(backupName, conflict.content, conflict.placement),
          updatedAt: new Date().toISOString(),
          isBuiltIn: false,
        };
        prompts.push(backup);
        byHash.set(backup.contentHash, backup);
        byId.set(backup.id, backup);
        nameSet.add(backup.name.trim().toLowerCase());
        stats.backedUpCount += 1;

        const updated: CustomPromptTemplate = {
          ...incoming,
          id: conflict.id,
          isBuiltIn: false,
          createdAt: conflict.createdAt,
        };
        const idx = prompts.findIndex((p) => p.id === conflict.id);
        if (idx >= 0) prompts[idx] = updated;
        byHash.set(updated.contentHash, updated);
        byId.set(updated.id, updated);
        byName.set(updated.name.trim().toLowerCase(), updated);
        nameSet.add(updated.name.trim().toLowerCase());
        stats.updatedCount += 1;
      } else {
        const importName = uniqueBackupName(incoming.name, nameSet, 'Import');
        const copy: CustomPromptTemplate = {
          ...incoming,
          id: newImportId(),
          name: importName,
          contentHash: computePromptHash(importName, incoming.content, incoming.placement),
          isBuiltIn: false,
        };
        prompts.push(copy);
        byHash.set(copy.contentHash, copy);
        byId.set(copy.id, copy);
        byName.set(copy.name.trim().toLowerCase(), copy);
        nameSet.add(copy.name.trim().toLowerCase());
        stats.addedCount += 1;
      }
      continue;
    }

    const toAdd: CustomPromptTemplate = {
      ...incoming,
      id: byId.has(incoming.id) ? newImportId() : incoming.id,
      isBuiltIn: false,
    };
    prompts.push(toAdd);
    byHash.set(toAdd.contentHash, toAdd);
    byId.set(toAdd.id, toAdd);
    byName.set(toAdd.name.trim().toLowerCase(), toAdd);
    nameSet.add(toAdd.name.trim().toLowerCase());
    stats.addedCount += 1;
  }

  return { prompts, stats };
}

function resolveImportedDefaultName(
  exportBlock: PromptStudioExport | undefined,
): { id: string | null; name: string | null } {
  if (!exportBlock?.globalDefaultPromptId) return { id: null, name: null };
  const id = exportBlock.globalDefaultPromptId;
  const fromCustom = exportBlock.customPrompts.find((p) => p.id === id);
  if (fromCustom) return { id, name: fromCustom.name };
  return { id, name: id };
}

/* ─── export ─────────────────────────────────────────── */

export function buildPromptStudioExport(
  store: PromptStudioStore = loadPromptStudioStore(),
): PromptStudioExport {
  return {
    schemaVersion: 2,
    customPrompts: store.customPrompts.filter((p) => !p.isBuiltIn),
    globalDefaultPromptId: store.globalDefaultPromptId,
    workspaceDefaultPromptMap: { ...store.workspaceDefaultPromptMap },
    autoApplyDefaultOnOpen: store.autoApplyDefaultOnOpen,
  };
}

export function buildI18nExport(state: I18nState = loadI18nState()): I18nExport {
  return {
    activeLocale: state.activeLocale,
    customPacks: state.customPacks.map((p) => ({ ...p, translations: { ...p.translations } })),
  };
}

export function buildPrefSnapshot(
  projects: ProjectPref[],
  history: FolderHistoryEntry[],
  promptStudio?: PromptStudioStore,
  i18n?: I18nState,
): PrefSnapshot {
  const studio = promptStudio ?? loadPromptStudioStore();
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
    promptStudio: buildPromptStudioExport(studio),
    i18n: buildI18nExport(i18n ?? loadI18nState()),
  };
}

/** Export only Prompt Studio pack (shareable prompts JSON). */
export function exportPromptStudioOnly(
  store: PromptStudioStore = loadPromptStudioStore(),
): string {
  return JSON.stringify(
    {
      app: 'ptt',
      version: PREF_SNAPSHOT_VERSION,
      exportedAt: new Date().toISOString(),
      kind: 'promptStudio',
      promptStudio: buildPromptStudioExport(store),
      projects: [],
      history: [],
    },
    null,
    2,
  );
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
  const isPromptOnly =
    obj.kind === 'promptStudio' ||
    (obj.app === 'ptt' && obj.promptStudio && !Array.isArray(obj.projects));
  if (obj.app !== 'ptt') {
    throw new Error('File is not a ptt preferences snapshot');
  }
  if (!isPromptOnly && !Array.isArray(obj.projects)) {
    throw new Error('File is not a ptt preferences snapshot');
  }
  return {
    app: 'ptt',
    version: typeof obj.version === 'number' ? obj.version : 1,
    exportedAt: typeof obj.exportedAt === 'string' ? obj.exportedAt : '',
    projects: Array.isArray(obj.projects) ? obj.projects : [],
    history: Array.isArray(obj.history) ? obj.history : [],
    promptStudio: parsePromptStudioExport(obj.promptStudio),
    i18n: parseI18nExport(obj.i18n),
  };
}

/** Preview import impact without writing. */
export function previewPrefImport(
  snapshot: PrefSnapshot,
  currentProjects: ProjectPref[],
  currentHistory: FolderHistoryEntry[],
  currentStudio: PromptStudioStore = loadPromptStudioStore(),
): PrefImportPreview {
  const dry = mergePrefSnapshot(snapshot, currentProjects, currentHistory, currentStudio, {
    mode: 'merge',
    applyImportedDefault: false,
  });
  const def = resolveImportedDefaultName(snapshot.promptStudio);
  return {
    projectsCount: snapshot.projects.length,
    historyCount: snapshot.history.length,
    promptsNew: dry.promptStats?.addedCount ?? 0,
    promptsUpdated: dry.promptStats?.updatedCount ?? 0,
    promptsDuplicates: dry.promptStats?.skippedDuplicates ?? 0,
    defaultPromptName: def.name,
    defaultPromptId: def.id,
    secretWarnings: dry.secretWarnings,
    hasPromptStudio: Boolean(snapshot.promptStudio),
    hasI18n: Boolean(snapshot.i18n),
    i18nPacksCount: snapshot.i18n?.customPacks.length ?? 0,
    i18nActiveLocale: snapshot.i18n?.activeLocale ?? null,
  };
}

/* ─── merge ──────────────────────────────────────────── */

/**
 * Merge snapshot entries into the current state.
 * Import never deletes existing local entries when mode=merge; for the same
 * project key the fresher timestamps win, and boolean flags are OR-ed.
 * Older snapshots without promptStudio leave local prompts untouched.
 */
export function mergePrefSnapshot(
  snapshot: PrefSnapshot,
  currentProjects: ProjectPref[],
  currentHistory: FolderHistoryEntry[],
  currentStudio: PromptStudioStore = loadPromptStudioStore(),
  options: PrefImportOptions = {},
): PrefMergeResult {
  const mode: PrefImportMode = options.mode ?? 'merge';
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

  const secretWarnings = snapshot.promptStudio
    ? scanPromptSecrets(snapshot.promptStudio.customPrompts)
    : [];
  const defMeta = resolveImportedDefaultName(snapshot.promptStudio);

  let promptStudio: PromptStudioStore | undefined;
  let promptStats: PromptStudioMergeStats | undefined;

  if (snapshot.promptStudio) {
    if (mode === 'replace') {
      promptStudio = {
        schemaVersion: 2,
        customPrompts: snapshot.promptStudio.customPrompts.map((p) => ({
          ...p,
          isBuiltIn: false,
        })),
        globalDefaultPromptId: snapshot.promptStudio.globalDefaultPromptId,
        workspaceDefaultPromptMap: {
          ...snapshot.promptStudio.workspaceDefaultPromptMap,
        },
        autoApplyDefaultOnOpen: snapshot.promptStudio.autoApplyDefaultOnOpen,
        activePromptId: currentStudio.activePromptId,
        draftCustomText: currentStudio.draftCustomText,
      };
      promptStats = {
        addedCount: promptStudio.customPrompts.length,
        updatedCount: 0,
        skippedDuplicates: 0,
        backedUpCount: 0,
      };
    } else {
      const merged = mergeCustomPrompts(
        currentStudio.customPrompts,
        snapshot.promptStudio.customPrompts,
      );
      promptStats = merged.stats;
      const nextMap = {
        ...currentStudio.workspaceDefaultPromptMap,
        ...snapshot.promptStudio.workspaceDefaultPromptMap,
      };
      let globalDefault = currentStudio.globalDefaultPromptId;
      if (options.applyImportedDefault && snapshot.promptStudio.globalDefaultPromptId) {
        globalDefault = snapshot.promptStudio.globalDefaultPromptId;
      } else if (
        globalDefault == null &&
        snapshot.promptStudio.globalDefaultPromptId
      ) {
        globalDefault = snapshot.promptStudio.globalDefaultPromptId;
      }
      promptStudio = {
        ...currentStudio,
        schemaVersion: 2,
        customPrompts: merged.prompts,
        globalDefaultPromptId: globalDefault,
        workspaceDefaultPromptMap: nextMap,
        autoApplyDefaultOnOpen:
          currentStudio.autoApplyDefaultOnOpen ||
          snapshot.promptStudio.autoApplyDefaultOnOpen,
      };
    }
  }

  let i18n: I18nState | undefined;
  if (snapshot.i18n) {
    const currentI18n = options.currentI18n ?? loadI18nState();
    if (mode === 'replace') {
      i18n = sanitizeI18nState({
        activeLocale: snapshot.i18n.activeLocale,
        customPacks: snapshot.i18n.customPacks,
      });
    } else {
      const customPacks = mergeLanguagePacks(currentI18n.customPacks, snapshot.i18n.customPacks);
      i18n = {
        activeLocale: isLocaleAvailable(currentI18n.activeLocale, customPacks)
          ? currentI18n.activeLocale
          : 'en',
        customPacks,
      };
    }
  }

  return {
    projects: [...projects.values()],
    history: [...history.values()],
    projectsImported,
    historyImported,
    skipped,
    promptStudio,
    promptStats,
    i18n,
    secretWarnings,
    importedDefaultPromptId: defMeta.id,
    importedDefaultPromptName: defMeta.name,
  };
}

/** Persist a merge/replace result's i18n section (the I18nProvider picks it up via the update event). */
export function applyI18nImport(state: I18nState): boolean {
  return saveI18nState(state);
}

/** Persist a merge/replace result's prompt studio section. */
export function applyPromptStudioImport(store: PromptStudioStore): boolean {
  return savePromptStudioStore(store, { reason: 'import' });
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

export function promptStudioFileName(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `ptt-prompts-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}.json`;
}
