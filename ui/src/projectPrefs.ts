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

/* ─── Prompt Studio (schema v2) ───────────────────────── */

export type PromptCategory =
  | 'architecture'
  | 'bugfix'
  | 'review'
  | 'refactoring'
  | 'security'
  | 'testing'
  | 'docs'
  | 'custom';

export type PromptPlacement = 'prefix' | 'suffix' | 'wrap';

export interface PromptPresetConfig {
  recommendedBudget?: number;
  recommendedFormat?: 'xml' | 'markdown' | 'plain';
  enableSkeleton?: boolean;
  includeGitDiff?: boolean;
  includeDeps?: boolean;
}

export interface CustomPromptTemplate {
  id: string;
  name: string;
  category: PromptCategory;
  description: string;
  content: string;
  placement: PromptPlacement;
  isBuiltIn: boolean;
  isFavorite?: boolean;
  createdAt: string;
  updatedAt: string;
  contentHash: string;
  presetConfig?: PromptPresetConfig;
}

export interface PromptStudioStore {
  schemaVersion: 2;
  customPrompts: CustomPromptTemplate[];
  globalDefaultPromptId: string | null;
  workspaceDefaultPromptMap: Record<string, string>;
  autoApplyDefaultOnOpen: boolean;
  activePromptId: string | null;
  draftCustomText: string;
}

export const PROMPT_STUDIO_KEY = 'ptt.promptStudio.v2';
export const PROMPT_STUDIO_LEGACY_KEYS = ['ptt.promptStudio.v1', 'ptt.customPrompts'] as const;
export const MAX_PROMPT_NAME_LEN = 120;
export const MAX_PROMPT_CONTENT_LEN = 100_000;

const BUILTIN_TS = '2024-01-01T00:00:00.000Z';

/** FNV-1a 32-bit → 8-char hex. Deterministic for import dedup. */
export function computePromptHash(
  name: string,
  content: string,
  placement: PromptPlacement,
): string {
  const input = `${name}\0${content}\0${placement}`;
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function builtin(
  id: string,
  name: string,
  category: PromptCategory,
  description: string,
  content: string,
  placement: PromptPlacement = 'suffix',
  presetConfig?: PromptPresetConfig,
): CustomPromptTemplate {
  return {
    id,
    name,
    category,
    description,
    content,
    placement,
    isBuiltIn: true,
    createdAt: BUILTIN_TS,
    updatedAt: BUILTIN_TS,
    contentHash: computePromptHash(name, content, placement),
    presetConfig,
  };
}

export const BUILT_IN_PROMPTS: CustomPromptTemplate[] = [
  builtin(
    'review',
    'Architecture & Code Review',
    'review',
    'Architectural soundness, correctness, and maintainability review.',
    'Review the attached project context for architectural soundness, correctness, edge cases, and maintainability. Cite exact file paths and line numbers for every finding and propose concrete, minimal fixes.\n\nProject: {{PROJECT_NAME}} · Branch: {{GIT_BRANCH}} · Budget: {{TOKEN_BUDGET}}',
    'suffix',
    { recommendedBudget: 64000, recommendedFormat: 'xml', enableSkeleton: true },
  ),
  builtin(
    'bug',
    'Bug Investigation & Root Cause',
    'bugfix',
    'Trace defects to root cause with a regression-tested fix.',
    'Investigate the defect described below using the provided project context. Trace the data and control flow, identify the exact root cause, and provide a regression-tested fix.\n\nSelected files: {{SELECTED_FILES_COUNT}} · Skeleton: {{SKELETON_MODE}}',
    'suffix',
    { recommendedBudget: 32000, recommendedFormat: 'xml', enableSkeleton: false, includeDeps: true },
  ),
  builtin(
    'security',
    'Security & Vulnerability Audit',
    'security',
    'OWASP-oriented audit of auth, IPC, parsers, and config.',
    'Perform a thorough security audit of the attached codebase. Check for path traversal, injection, authentication/authorization flaws, unsafe deserialization, and secret exposure. Rate severity and provide remediation diffs.\n\nProject: {{PROJECT_NAME}} · Date: {{DATE_ISO}}',
    'suffix',
    { recommendedBudget: 64000, recommendedFormat: 'xml' },
  ),
  builtin(
    'tests',
    'Write Unit / Integration Tests',
    'testing',
    'Generate tests matching project assertion style and helpers.',
    'Write comprehensive unit and integration tests for the selected modules, covering happy paths, boundary conditions, error handling, and security invariants. Mirror existing test helpers and assertion libraries in {{PROJECT_NAME}}.',
    'suffix',
    { recommendedBudget: 32000, recommendedFormat: 'xml' },
  ),
  builtin(
    'playbook-architecture',
    'Principal Architecture Review',
    'architecture',
    'Deep audit of architecture, cycles, and bottlenecks across the repo.',
    `You are a Principal Systems Architect reviewing {{PROJECT_NAME}} (branch {{GIT_BRANCH}}).

## Mission
Detect cyclic dependencies, Clean Architecture boundary violations, scalability risks, and technical debt. Budget: {{TOKEN_BUDGET}}. Mode: {{SKELETON_MODE}}.

## Deliverables
1. Layer map and dependency graph notes (call out cycles).
2. Prioritized findings with file paths and severity.
3. Concrete remediation plan (minimal diffs preferred).
4. Scalability / bottleneck analysis for hot paths.

Cite exact paths. Prefer actionable fixes over generic advice.`,
    'wrap',
    { recommendedBudget: 64000, recommendedFormat: 'xml', enableSkeleton: true },
  ),
  builtin(
    'playbook-bugfix',
    'Root-Cause Bug Hunt + Deps',
    'bugfix',
    'Surgical diagnosis with dependency context and regression test.',
    `Surgical bug hunt on {{PROJECT_NAME}} ({{GIT_BRANCH}}). Files in scope: {{SELECTED_FILES_COUNT}}. Mode: {{SKELETON_MODE}}.

1. Reproduce hypothetically from the attached sources and imports.
2. Identify root cause (race, edge case, incorrect invariant).
3. Propose a minimal patch plus a regression test.
4. List related modules that must stay consistent.

Do not invent APIs that are not in the pack.`,
    'suffix',
    { recommendedBudget: 32000, recommendedFormat: 'xml', enableSkeleton: false, includeDeps: true },
  ),
  builtin(
    'playbook-appsec',
    'AppSec & OWASP Audit',
    'security',
    'Attack-surface review for auth, IPC, parsers, and Tauri/API config.',
    `AppSec audit for {{PROJECT_NAME}} ({{DATE_ISO}}). Focus on Path Traversal, Injection, XSS, Deserialization, and IPC privilege escalation.

For each finding: severity, exploit sketch, affected path, and a remediation patch. Respect the project security contract. Budget {{TOKEN_BUDGET}}.`,
    'suffix',
    { recommendedBudget: 64000, recommendedFormat: 'xml' },
  ),
  builtin(
    'playbook-prepr',
    'Pre-PR Impact Analysis',
    'review',
    'Strict pre-merge review using Git Diff on the current branch.',
    `Pre-PR review for {{PROJECT_NAME}} on branch {{GIT_BRANCH}}.

Check for breaking changes, performance regressions, missing error handling, and test gaps. Use the included git diff and selected files. Produce a merge-ready checklist and required follow-ups.`,
    'suffix',
    { recommendedBudget: 32000, recommendedFormat: 'xml', includeGitDiff: true },
  ),
  builtin(
    'playbook-feature',
    'Feature Blueprint (Cursor / Claude)',
    'docs',
    'End-to-end feature plan aligned with existing patterns.',
    `Design and plan a new feature for {{PROJECT_NAME}} that matches existing domain models, UI state patterns, naming, and architecture.

Deliver: goals, file-level implementation plan, API/state changes, tests, and risks. Budget {{TOKEN_BUDGET}}. Selected files: {{SELECTED_FILES_COUNT}}.`,
    'prefix',
    { recommendedBudget: 64000, recommendedFormat: 'xml' },
  ),
  builtin(
    'playbook-tests',
    'Zero-Hallucination Test Suite',
    'testing',
    'Unit/E2E tests mirroring project helpers and assertion style.',
    `Generate a zero-hallucination test suite for the selected module in {{PROJECT_NAME}}.

Mirror assertion libraries and helpers already present (e.g. smoke.spec.ts / phase1_regressions.rs). Cover happy paths and edge cases. Do not invent APIs. Budget {{TOKEN_BUDGET}}.`,
    'suffix',
    { recommendedBudget: 32000, recommendedFormat: 'xml' },
  ),
  builtin(
    'playbook-onboarding',
    '5-Minute Codebase Onboarding',
    'docs',
    'Fast domain map, Mermaid flow, and run/debug instructions.',
    `Onboard a new engineer to {{PROJECT_NAME}} (branch {{GIT_BRANCH}}, mode {{SKELETON_MODE}}).

Produce:
1. Mermaid data-flow diagram.
2. Key modules and responsibilities.
3. State architecture overview.
4. Run / debug / test instructions.

Keep it accurate to the attached tree and configs.`,
    'prefix',
    { recommendedBudget: 32000, recommendedFormat: 'xml', enableSkeleton: true },
  ),
];

const PROMPT_CATEGORIES: readonly PromptCategory[] = [
  'architecture',
  'bugfix',
  'review',
  'refactoring',
  'security',
  'testing',
  'docs',
  'custom',
];

const PROMPT_PLACEMENTS: readonly PromptPlacement[] = ['prefix', 'suffix', 'wrap'];

function emptyPromptStudioStore(): PromptStudioStore {
  return {
    schemaVersion: 2,
    customPrompts: [],
    globalDefaultPromptId: null,
    workspaceDefaultPromptMap: {},
    autoApplyDefaultOnOpen: true,
    activePromptId: null,
    draftCustomText: '',
  };
}

function stripControlChars(s: string): string {
  return s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
}

function isPromptCategory(v: unknown): v is PromptCategory {
  return typeof v === 'string' && (PROMPT_CATEGORIES as readonly string[]).includes(v);
}

function isPromptPlacement(v: unknown): v is PromptPlacement {
  return typeof v === 'string' && (PROMPT_PLACEMENTS as readonly string[]).includes(v);
}

function parsePresetConfig(raw: unknown): PromptPresetConfig | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const o = raw as Record<string, unknown>;
  const cfg: PromptPresetConfig = {};
  if (typeof o.recommendedBudget === 'number' && Number.isFinite(o.recommendedBudget)) {
    cfg.recommendedBudget = Math.max(1000, Math.min(2_000_000, Math.round(o.recommendedBudget)));
  }
  if (o.recommendedFormat === 'xml' || o.recommendedFormat === 'markdown' || o.recommendedFormat === 'plain') {
    cfg.recommendedFormat = o.recommendedFormat;
  }
  if (typeof o.enableSkeleton === 'boolean') cfg.enableSkeleton = o.enableSkeleton;
  if (typeof o.includeGitDiff === 'boolean') cfg.includeGitDiff = o.includeGitDiff;
  if (typeof o.includeDeps === 'boolean') cfg.includeDeps = o.includeDeps;
  return Object.keys(cfg).length > 0 ? cfg : undefined;
}

/** Validate and sanitize a prompt template from untrusted JSON. */
export function parseCustomPromptTemplate(
  raw: unknown,
  opts: { forceBuiltIn?: boolean } = {},
): CustomPromptTemplate | null {
  if (!raw || typeof raw !== 'object') return null;
  const item = raw as Record<string, unknown>;
  const id = typeof item.id === 'string' ? item.id.trim().slice(0, 80) : '';
  let name = typeof item.name === 'string' ? stripControlChars(item.name).trim() : '';
  let content = typeof item.content === 'string' ? stripControlChars(item.content) : '';
  if (!id || !name || !content) return null;
  if (name.length > MAX_PROMPT_NAME_LEN) name = name.slice(0, MAX_PROMPT_NAME_LEN);
  if (content.length > MAX_PROMPT_CONTENT_LEN) content = content.slice(0, MAX_PROMPT_CONTENT_LEN);
  const category: PromptCategory = isPromptCategory(item.category) ? item.category : 'custom';
  const placement: PromptPlacement = isPromptPlacement(item.placement) ? item.placement : 'suffix';
  const description =
    typeof item.description === 'string'
      ? stripControlChars(item.description).slice(0, 500)
      : '';
  const createdAt =
    typeof item.createdAt === 'string' && item.createdAt.trim()
      ? item.createdAt
      : new Date().toISOString();
  const updatedAt =
    typeof item.updatedAt === 'string' && item.updatedAt.trim()
      ? item.updatedAt
      : createdAt;
  const contentHash =
    typeof item.contentHash === 'string' && /^[0-9a-f]{8}$/i.test(item.contentHash)
      ? item.contentHash.toLowerCase()
      : computePromptHash(name, content, placement);
  return {
    id,
    name,
    category,
    description,
    content,
    placement,
    isBuiltIn: opts.forceBuiltIn === true ? true : false,
    isFavorite: item.isFavorite === true,
    createdAt,
    updatedAt,
    contentHash,
    presetConfig: parsePresetConfig(item.presetConfig),
  };
}

function parsePromptStudioStore(raw: unknown): PromptStudioStore | null {
  if (!raw || typeof raw !== 'object') return null;
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
    activePromptId: typeof obj.activePromptId === 'string' ? obj.activePromptId : null,
    draftCustomText: typeof obj.draftCustomText === 'string' ? obj.draftCustomText : '',
  };
}

function migrateLegacyPromptStudio(): PromptStudioStore | null {
  for (const key of PROMPT_STUDIO_LEGACY_KEYS) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) continue;
      const value: unknown = JSON.parse(raw);
      if (Array.isArray(value)) {
        const customPrompts = value
          .map((p) => parseCustomPromptTemplate(p))
          .filter((p): p is CustomPromptTemplate => p !== null);
        if (customPrompts.length === 0) continue;
        return { ...emptyPromptStudioStore(), customPrompts };
      }
      const parsed = parsePromptStudioStore(value);
      if (parsed) return parsed;
    } catch {
      /* ignore corrupt legacy */
    }
  }
  return null;
}

export function loadPromptStudioStore(): PromptStudioStore {
  try {
    const raw = localStorage.getItem(PROMPT_STUDIO_KEY);
    if (raw) {
      const parsed = parsePromptStudioStore(JSON.parse(raw));
      if (parsed) return parsed;
    }
    const migrated = migrateLegacyPromptStudio();
    if (migrated) {
      savePromptStudioStore(migrated);
      return migrated;
    }
  } catch {
    /* corrupt JSON */
  }
  return emptyPromptStudioStore();
}

export const PROMPT_STUDIO_UPDATED_EVENT = 'ptt:prompt-studio-updated';

export type PromptStudioUpdateDetail = {
  reason?: 'save' | 'import' | 'delete' | 'default' | 'active';
  deletedId?: string | null;
};

/** Broadcast so every UI surface refreshes without a full page reload. */
export function notifyPromptStudioUpdated(detail: PromptStudioUpdateDetail = {}): void {
  try {
    window.dispatchEvent(
      new CustomEvent<PromptStudioUpdateDetail>(PROMPT_STUDIO_UPDATED_EVENT, { detail }),
    );
  } catch {
    /* non-DOM environments (unit tests) */
  }
}

export function savePromptStudioStore(
  store: PromptStudioStore,
  detail: PromptStudioUpdateDetail = { reason: 'save' },
): boolean {
  try {
    const payload: PromptStudioStore = {
      schemaVersion: 2,
      customPrompts: store.customPrompts.filter((p) => !p.isBuiltIn),
      globalDefaultPromptId: store.globalDefaultPromptId,
      workspaceDefaultPromptMap: store.workspaceDefaultPromptMap,
      autoApplyDefaultOnOpen: store.autoApplyDefaultOnOpen,
      activePromptId: store.activePromptId,
      draftCustomText: store.draftCustomText,
    };
    localStorage.setItem(PROMPT_STUDIO_KEY, JSON.stringify(payload));
    notifyPromptStudioUpdated(detail);
    return true;
  } catch (e) {
    if (e instanceof DOMException && e.name === 'QuotaExceededError') return false;
    return false;
  }
}

function newPromptId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `custom-${crypto.randomUUID()}`;
  }
  return `custom-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function findPromptById(id: string | null | undefined): CustomPromptTemplate | null {
  if (!id) return null;
  const builtIn = BUILT_IN_PROMPTS.find((p) => p.id === id);
  if (builtIn) return builtIn;
  const store = loadPromptStudioStore();
  return store.customPrompts.find((p) => p.id === id) ?? null;
}

export function listAllPrompts(store?: PromptStudioStore): CustomPromptTemplate[] {
  const s = store ?? loadPromptStudioStore();
  return [...BUILT_IN_PROMPTS, ...s.customPrompts];
}

export function upsertCustomPrompt(
  input: Omit<CustomPromptTemplate, 'id' | 'createdAt' | 'updatedAt' | 'contentHash' | 'isBuiltIn'> & {
    id?: string;
  },
): CustomPromptTemplate {
  const name = stripControlChars(input.name ?? '').trim();
  const content = stripControlChars(input.content ?? '');
  if (!name) throw new Error('Prompt name is required');
  if (name.length > MAX_PROMPT_NAME_LEN) throw new Error(`Prompt name max ${MAX_PROMPT_NAME_LEN} characters`);
  if (!content.trim()) throw new Error('Prompt content is required');
  if (content.length > MAX_PROMPT_CONTENT_LEN) {
    throw new Error(`Prompt content max ${MAX_PROMPT_CONTENT_LEN} characters`);
  }
  const placement: PromptPlacement = isPromptPlacement(input.placement) ? input.placement : 'suffix';
  const category: PromptCategory = isPromptCategory(input.category) ? input.category : 'custom';
  const now = new Date().toISOString();
  const store = loadPromptStudioStore();
  const existingIdx = input.id ? store.customPrompts.findIndex((p) => p.id === input.id) : -1;
  const id = existingIdx >= 0 ? store.customPrompts[existingIdx].id : input.id || newPromptId();
  if (BUILT_IN_PROMPTS.some((p) => p.id === id)) {
    throw new Error('Cannot overwrite a built-in prompt id; duplicate it instead');
  }
  const template: CustomPromptTemplate = {
    id,
    name,
    category,
    description: stripControlChars(input.description ?? '').slice(0, 500),
    content,
    placement,
    isBuiltIn: false,
    isFavorite: input.isFavorite === true,
    createdAt: existingIdx >= 0 ? store.customPrompts[existingIdx].createdAt : now,
    updatedAt: now,
    contentHash: computePromptHash(name, content, placement),
    presetConfig: input.presetConfig,
  };
  if (existingIdx >= 0) {
    store.customPrompts[existingIdx] = template;
  } else {
    store.customPrompts.push(template);
  }
  savePromptStudioStore(store);
  return template;
}

export function duplicatePromptTemplate(sourceId: string): CustomPromptTemplate {
  const source = findPromptById(sourceId);
  if (!source) throw new Error('Prompt not found');
  const baseName = source.name.replace(/\s*\(Kopia(?:\s+\d+)?\)\s*$/i, '').trim();
  let name = `${baseName} (Kopia)`;
  const store = loadPromptStudioStore();
  const names = new Set(store.customPrompts.map((p) => p.name.trim().toLowerCase()));
  let n = 2;
  while (names.has(name.toLowerCase())) {
    name = `${baseName} (Kopia ${n})`;
    n += 1;
  }
  return upsertCustomPrompt({
    name,
    category: source.category,
    description: source.description,
    content: source.content,
    placement: source.placement,
    isFavorite: false,
    presetConfig: source.presetConfig,
  });
}

function clearPromptRefs(store: PromptStudioStore, id: string): void {
  if (store.globalDefaultPromptId === id) store.globalDefaultPromptId = null;
  if (store.activePromptId === id) store.activePromptId = null;
  for (const [ws, pid] of Object.entries(store.workspaceDefaultPromptMap)) {
    if (pid === id) delete store.workspaceDefaultPromptMap[ws];
  }
}

export function deleteCustomPrompt(id: string): void {
  const store = loadPromptStudioStore();
  const next = store.customPrompts.filter((p) => p.id !== id);
  if (next.length === store.customPrompts.length) return;
  store.customPrompts = next;
  clearPromptRefs(store, id);
  savePromptStudioStore(store, { reason: 'delete', deletedId: id });
}

export function setGlobalDefaultPrompt(id: string | null): void {
  const store = loadPromptStudioStore();
  if (id !== null && !findPromptById(id)) {
    throw new Error('Prompt not found');
  }
  store.globalDefaultPromptId = id;
  savePromptStudioStore(store);
}

export function setWorkspaceDefaultPrompt(workspacePath: string, id: string | null): void {
  const key = projectPrefKey(workspacePath);
  if (!key) return;
  const store = loadPromptStudioStore();
  if (id === null) {
    delete store.workspaceDefaultPromptMap[key];
  } else {
    if (!findPromptById(id)) throw new Error('Prompt not found');
    store.workspaceDefaultPromptMap[key] = id;
  }
  savePromptStudioStore(store);
}

export function resolveDefaultPromptForWorkspace(
  workspacePath?: string | null,
): CustomPromptTemplate | null {
  const store = loadPromptStudioStore();
  if (workspacePath) {
    const wsId = store.workspaceDefaultPromptMap[projectPrefKey(workspacePath)];
    if (wsId) {
      const found = findPromptById(wsId);
      if (found) return found;
    }
  }
  if (store.globalDefaultPromptId) {
    return findPromptById(store.globalDefaultPromptId);
  }
  return null;
}

export function setActivePromptId(id: string | null): void {
  const store = loadPromptStudioStore();
  store.activePromptId = id;
  savePromptStudioStore(store);
}

export function setDraftCustomText(text: string): void {
  const store = loadPromptStudioStore();
  store.draftCustomText = text;
  savePromptStudioStore(store);
}

export function setAutoApplyDefaultOnOpen(value: boolean): void {
  const store = loadPromptStudioStore();
  store.autoApplyDefaultOnOpen = value;
  savePromptStudioStore(store);
}

export function interpolatePromptVariables(
  templateContent: string,
  ctx: {
    projectName?: string;
    gitBranch?: string;
    selectedFilesCount?: number;
    tokenBudget?: number;
    skeletonEnabled?: boolean;
  },
): string {
  const dateIso = new Date().toISOString().slice(0, 10);
  const budget =
    typeof ctx.tokenBudget === 'number' && Number.isFinite(ctx.tokenBudget)
      ? Math.round(ctx.tokenBudget).toLocaleString('en-US')
      : '—';
  const replacements: Record<string, string> = {
    PROJECT_NAME: ctx.projectName?.trim() || 'Workspace',
    GIT_BRANCH: ctx.gitBranch?.trim() || 'main/head',
    SELECTED_FILES_COUNT: String(
      typeof ctx.selectedFilesCount === 'number' ? ctx.selectedFilesCount : 0,
    ),
    TOKEN_BUDGET: budget,
    SKELETON_MODE: ctx.skeletonEnabled ? 'Enabled (AST Signatures)' : 'Full Source',
    DATE_ISO: dateIso,
  };
  return templateContent.replace(/\{\{\s*([A-Z0-9_]+)\s*\}\}/g, (full, key: string) => {
    return Object.prototype.hasOwnProperty.call(replacements, key) ? replacements[key] : full;
  });
}

/** Apply placement around packed body (wrap = instruction + reminder). */
export function applyPromptPlacement(
  content: string,
  placement: PromptPlacement,
): { prefix: string; suffix: string } {
  const trimmed = content.trim();
  if (!trimmed) return { prefix: '', suffix: '' };
  if (placement === 'prefix') return { prefix: trimmed, suffix: '' };
  if (placement === 'wrap') {
    return {
      prefix: trimmed,
      suffix: `Reminder: follow the instructions above for {{PROJECT_NAME}}.`.replace(
        '{{PROJECT_NAME}}',
        'this workspace',
      ),
    };
  }
  return { prefix: '', suffix: trimmed };
}
