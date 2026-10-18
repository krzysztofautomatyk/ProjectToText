import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { BookOpen, Search, Sparkles, X } from 'lucide-react';
import {
  BUILT_IN_PROMPTS,
  findPromptById,
  interpolatePromptVariables,
  setActivePromptId,
  type CustomPromptTemplate,
  type PromptPresetConfig,
} from './projectPrefs';
import { formatShortcut } from './platform';
import { estimateTokens, formatTokens } from './treeModel';

export type DocsTab = 'howto' | 'examples' | 'context' | 'shortcuts';
export type DocsLocale = 'en' | 'pl';

const DOCS_LOCALE_KEY = 'ptt.docsLocale';

export function readDocsLocale(): DocsLocale {
  try {
    const v = localStorage.getItem(DOCS_LOCALE_KEY);
    if (v === 'pl' || v === 'en') return v;
  } catch {
    /* ignore */
  }
  return 'en';
}

export function writeDocsLocale(locale: DocsLocale): void {
  try {
    localStorage.setItem(DOCS_LOCALE_KEY, locale);
  } catch {
    /* ignore */
  }
}

export interface DocsPlaybookExample {
  id: string;
  promptId: string;
  title: string;
  category: string;
  difficulty: 'Intermediate' | 'Advanced' | 'Expert';
  whenToUse: string;
  config: PromptPresetConfig & { label: string };
  promptPreview: string;
}

type LocalizedStep = { title: string; body: string };

const HOWTO_STEPS: Record<DocsLocale, LocalizedStep[]> = {
  en: [
    {
      title: 'Open a Project & Path Hygiene',
      body:
        'Open a repository natively (Tauri) or in the browser (File System Access API). Recent Folders speeds up returning to past workspaces. `.gitignore` and `.pttignore` automatically drop `node_modules`, `target`, and binary artifacts.',
    },
    {
      title: 'Precise Selection, Filters & Dependency Graph',
      body:
        'Select files and directories in the tree, use the file filter, and preview code in FileViewer. Include Dependencies pulls related modules (1–2 import hops) without hunting the tree by hand.',
    },
    {
      title: 'Token Budget & AST Skeletonization',
      body:
        'Set a hard limit (8k / 32k / 128k / 200k) that matches your model’s context window. Skeleton Mode keeps full implementations for critical files and compresses the rest to function/type/interface signatures — less Lost-in-the-Middle.',
    },
    {
      title: 'Prompt Studio & Default Template',
      body:
        'Create custom templates, insert variables like {{PROJECT_NAME}}, {{GIT_BRANCH}}, {{TOKEN_BUDGET}}, and mark a favorite with ★ Default — globally or per project. On workspace open, the default template can apply automatically.',
    },
    {
      title: 'Secret Protection (Zero-Leak Security)',
      body:
        'The built-in scanner detects API keys, JWT tokens, and credentials in code and in prompt text before copy-to-clipboard. Redaction is on by default; you can turn it off deliberately.',
    },
    {
      title: 'Export/Import Settings & CLI / MCP',
      body:
        'Export projects and custom prompts to JSON, merge them on another machine (Merge keeps local entries; Replace overwrites Prompt Studio). Attach ProjectToText as an MCP server in Cursor AI / Claude Desktop, or use the CLI in CI/CD.',
    },
  ],
  pl: [
    {
      title: 'Wczytanie Projektu i Higiena Ścieżek',
      body:
        'Otwórz repozytorium natywnie (Tauri) lub w przeglądarce (File System Access API). Historia projektów (Recent Folders) przyspiesza powrót. Pliki .gitignore i .pttignore automatycznie odrzucają node_modules, target i artefakty binarne.',
    },
    {
      title: 'Precyzyjna Selekcja, Filtry i Graf Zależności (Deps)',
      body:
        'Zaznaczaj pliki i katalogi w drzewie, korzystaj z wyszukiwarki oraz podglądu kodu (FileViewer). Opcja Include Dependencies dołącza powiązane moduły (1–2 poziomy importów) bez ręcznego polowania po drzewie.',
    },
    {
      title: 'Budżet Tokenów i Kompresja AST (Skeletonization)',
      body:
        'Ustaw twardy limit (8k / 32k / 128k / 200k) dopasowany do okna modelu. Skeleton Mode zachowuje pełną implementację kluczowych plików, a pozostałe kompresuje do sygnatur funkcji, typów i interfejsów — mniej Lost-in-the-Middle.',
    },
    {
      title: 'Prompt Studio i Domyślny Szablon (Default Prompt)',
      body:
        'Twórz własne szablony, wstawiaj zmienne {{PROJECT_NAME}}, {{GIT_BRANCH}}, {{TOKEN_BUDGET}} i oznaczaj ulubiony prompt gwiazdką ★ Domyślny — globalnie lub per projekt. Po otwarciu workspace domyślny szablon może się zastosować automatycznie.',
    },
    {
      title: 'Ochrona Sekretów (Zero-Leak Security)',
      body:
        'Wbudowany skaner wykrywa klucze API, tokeny JWT i dane uwierzytelniające w kodzie oraz w treściach promptów przed skopiowaniem do schowka. Redakcja jest domyślnie włączona; możesz ją wyłączyć świadomie.',
    },
    {
      title: 'Eksport/Import Ustawień oraz Integracja CLI / MCP',
      body:
        'Eksportuj projekty i własne prompty do JSON, scalaj je na innym komputerze w trybie Merge (bez utraty lokalnych wpisów) lub Replace. Podłącz ProjectToText jako serwer MCP do Cursor AI / Claude Desktop, albo użyj CLI w CI/CD.',
    },
  ],
};

type PlaybookMeta = Omit<DocsPlaybookExample, 'id' | 'promptId' | 'promptPreview' | 'config'> & {
  config: PromptPresetConfig & { label: string };
};

const PLAYBOOK_META: Record<DocsLocale, Record<string, PlaybookMeta>> = {
  en: {
    'playbook-architecture': {
      title: 'Deep Architecture & Bottleneck Audit',
      category: 'architecture',
      difficulty: 'Expert',
      whenToUse:
        'When you need a Principal Architecture Review of {{PROJECT_NAME}}: dependency cycles, layer boundary violations, scalability risks, and technical debt.',
      config: {
        label: '64k · XML · Skeleton ON · full Cargo.toml / package.json',
        recommendedBudget: 64000,
        recommendedFormat: 'xml',
        enableSkeleton: true,
      },
    },
    'playbook-bugfix': {
      title: 'Surgical Bug Diagnosis & Fix',
      category: 'bugfix',
      difficulty: 'Advanced',
      whenToUse:
        'Root-Cause Bug Hunt: select the failing file + Include Dependencies (1–2 hops), full source (Skeleton OFF).',
      config: {
        label: '32k · XML · Deps ON · Skeleton OFF',
        recommendedBudget: 32000,
        recommendedFormat: 'xml',
        enableSkeleton: false,
        includeDeps: true,
      },
    },
    'playbook-appsec': {
      title: 'Security Audit & Vulnerability Review',
      category: 'security',
      difficulty: 'Expert',
      whenToUse:
        'AppSec & OWASP: auth, IPC, input parsers, Tauri/API config, and permission rules.',
      config: {
        label: '64k · XML · auth / IPC / parser modules',
        recommendedBudget: 64000,
        recommendedFormat: 'xml',
      },
    },
    'playbook-prepr': {
      title: 'Pre-Merge Code Review with Git Diff',
      category: 'review',
      difficulty: 'Intermediate',
      whenToUse:
        'Pre-PR Impact Analysis on branch {{GIT_BRANCH}}: breaking changes, performance regressions, missing tests.',
      config: {
        label: '32k · Git Diff ON · modified files',
        recommendedBudget: 32000,
        recommendedFormat: 'xml',
        includeGitDiff: true,
      },
    },
    'playbook-feature': {
      title: 'End-to-End Feature Spec & Implementation Plan',
      category: 'docs',
      difficulty: 'Advanced',
      whenToUse:
        'Cursor / Claude Feature Blueprint aligned with domain models, UI state, and naming in {{PROJECT_NAME}}.',
      config: {
        label: '64k · domain models + reference components',
        recommendedBudget: 64000,
        recommendedFormat: 'xml',
      },
    },
    'playbook-tests': {
      title: 'Automated Unit & E2E Test Generation',
      category: 'testing',
      difficulty: 'Intermediate',
      whenToUse:
        'Zero-Hallucination Test Suite: target module + an existing test file as style reference (smoke.spec.ts / phase1_regressions.rs).',
      config: {
        label: '32k · module + existing test file',
        recommendedBudget: 32000,
        recommendedFormat: 'xml',
      },
    },
    'playbook-onboarding': {
      title: '5-Minute Codebase Onboarding & Domain Map',
      category: 'docs',
      difficulty: 'Intermediate',
      whenToUse:
        'Fast onboarding: Mermaid data-flow, key modules, state architecture, run/debug instructions.',
      config: {
        label: '32k · Skeleton ON · full tree + config',
        recommendedBudget: 32000,
        recommendedFormat: 'xml',
        enableSkeleton: true,
      },
    },
  },
  pl: {
    'playbook-architecture': {
      title: 'Głęboki Audyt Architektury i Wąskich Gardeł',
      category: 'architecture',
      difficulty: 'Expert',
      whenToUse:
        'Gdy potrzebujesz Principal Architecture Review całego {{PROJECT_NAME}}: cykle zależności, naruszenia warstw, skalowalność i dług techniczny.',
      config: {
        label: '64k · XML · Skeleton ON · pełne Cargo.toml / package.json',
        recommendedBudget: 64000,
        recommendedFormat: 'xml',
        enableSkeleton: true,
      },
    },
    'playbook-bugfix': {
      title: 'Chirurgiczna Diagnoza i Naprawa Buga',
      category: 'bugfix',
      difficulty: 'Advanced',
      whenToUse:
        'Root-Cause Bug Hunt: zaznaczony plik z błędem + Include Dependencies (1–2 poziomy), pełny kod (Skeleton OFF).',
      config: {
        label: '32k · XML · Deps ON · Skeleton OFF',
        recommendedBudget: 32000,
        recommendedFormat: 'xml',
        enableSkeleton: false,
        includeDeps: true,
      },
    },
    'playbook-appsec': {
      title: 'Audyt Bezpieczeństwa i Weryfikacja Podatności',
      category: 'security',
      difficulty: 'Expert',
      whenToUse:
        'AppSec & OWASP: auth, IPC, parsery wejścia, konfiguracja Tauri/API i reguły uprawnień.',
      config: {
        label: '64k · XML · moduły auth/IPC/parsers',
        recommendedBudget: 64000,
        recommendedFormat: 'xml',
      },
    },
    'playbook-prepr': {
      title: 'Code Review przed Merge’em z Analizą Git Diff',
      category: 'review',
      difficulty: 'Intermediate',
      whenToUse:
        'Pre-PR Impact Analysis na gałęzi {{GIT_BRANCH}}: breaking changes, regresje wydajności, luki w testach.',
      config: {
        label: '32k · Git Diff ON · zmodyfikowane pliki',
        recommendedBudget: 32000,
        recommendedFormat: 'xml',
        includeGitDiff: true,
      },
    },
    'playbook-feature': {
      title: 'Specyfikacja i Implementacja Nowego Ficzera E2E',
      category: 'docs',
      difficulty: 'Advanced',
      whenToUse:
        'Cursor / Claude Feature Blueprint dopasowany do wzorców stanu i nazewnictwa w {{PROJECT_NAME}}.',
      config: {
        label: '64k · modele domenowe + wzorcowe komponenty',
        recommendedBudget: 64000,
        recommendedFormat: 'xml',
      },
    },
    'playbook-tests': {
      title: 'Automatyczne Generowanie Testów Jednostkowych i E2E',
      category: 'testing',
      difficulty: 'Intermediate',
      whenToUse:
        'Zero-Hallucination Test Suite: moduł docelowy + wzorzec stylu (smoke.spec.ts / phase1_regressions.rs).',
      config: {
        label: '32k · moduł + istniejący plik testowy',
        recommendedBudget: 32000,
        recommendedFormat: 'xml',
      },
    },
    'playbook-onboarding': {
      title: 'Błyskawiczny Onboarding i Mapa Domenowa Projektu',
      category: 'docs',
      difficulty: 'Intermediate',
      whenToUse:
        '5-Minute Codebase Onboarding: Mermaid, kluczowe moduły, architektura stanu, run/debug.',
      config: {
        label: '32k · Skeleton ON · całe drzewo + config',
        recommendedBudget: 32000,
        recommendedFormat: 'xml',
        enableSkeleton: true,
      },
    },
  },
};

const PLAYBOOK_IDS = [
  'playbook-architecture',
  'playbook-bugfix',
  'playbook-appsec',
  'playbook-prepr',
  'playbook-feature',
  'playbook-tests',
  'playbook-onboarding',
] as const;

function buildPlaybooks(locale: DocsLocale): DocsPlaybookExample[] {
  return PLAYBOOK_IDS.map((promptId) => {
    const tpl = findPromptById(promptId) ?? BUILT_IN_PROMPTS.find((p) => p.id === promptId)!;
    const meta = PLAYBOOK_META[locale][promptId];
    return {
      id: `ex-${promptId}`,
      promptId,
      promptPreview: tpl.content,
      ...meta,
    };
  });
}

/** Default (English) playbook list for consumers/tests. */
export const DOCS_PLAYBOOK_EXAMPLES: DocsPlaybookExample[] = buildPlaybooks('en');

const UI = {
  en: {
    title: 'Documentation & How-To',
    badge: '7 Examples · F1',
    searchPlaceholder: 'Search documentation…',
    tabs: {
      howto: '🚀 How to use',
      examples: '⚡ 7 Examples',
      context: '🧠 Context Engineering',
      shortcuts: '⌨️ Shortcuts & MCP',
    } as Record<DocsTab, string>,
    howtoHeading: 'How to use the app — step by step',
    examplesHeading: '7 Usage Examples — World-Class Playbooks',
    whenToUse: 'When to use:',
    configuration: 'Configuration:',
    applyPlaybook: 'Load this scenario into Prompt Studio',
    contextHeading: 'Context Engineering Patterns & Architecture',
    contextBody:
      'XML packing (<file path="…">) and Skeletonization sharply reduce Lost-in-the-Middle in Claude, GPT/Codex, and Gemini: the model sees clear file boundaries, while lower-priority areas keep signatures without full function bodies.',
    budgetCol: 'Budget',
    taskCol: 'Task type',
    budgetRows: [
      ['8k–16k', 'Single file / quick fix'],
      ['32k', 'Bug hunt + deps, pre-PR, module tests'],
      ['64k–128k', 'Architecture / AppSec audit of a subsystem'],
      ['200k+', 'Monorepo overview with Skeleton Mode'],
    ] as [string, string][],
    varsHeading: 'Prompt Studio dynamic variables',
    varHints: {
      PROJECT_NAME: 'workspace name',
      GIT_BRANCH: 'current branch',
      SELECTED_FILES_COUNT: 'selected file count',
      TOKEN_BUDGET: 'token limit',
      SKELETON_MODE: 'Enabled / Full Source',
      DATE_ISO: 'date YYYY-MM-DD',
    } as Record<string, string>,
    shortcutsHeading: 'Keyboard shortcuts, CLI & MCP server',
    shortcutCol: 'Shortcut',
    actionCol: 'Action',
    shortcutDocs: 'Documentation & How-To',
    shortcutHelp: 'Keyboard shortcuts',
    shortcutEsc: 'Close dialog / clear filter',
    langLabel: 'Language',
  },
  pl: {
    title: 'Dokumentacja & How-To',
    badge: '7 Przykładów · F1',
    searchPlaceholder: 'Szukaj w dokumentacji…',
    tabs: {
      howto: '🚀 Jak używać',
      examples: '⚡ 7 Przykładów',
      context: '🧠 Context Engineering',
      shortcuts: '⌨️ Skróty & MCP',
    } as Record<DocsTab, string>,
    howtoHeading: 'Jak używać aplikacji — krok po kroku',
    examplesHeading: '7 Przykładów Użycia — World-Class Playbooks',
    whenToUse: 'Kiedy używać:',
    configuration: 'Konfiguracja:',
    applyPlaybook: 'Załaduj ten scenariusz do Prompt Studio',
    contextHeading: 'Wzorce Context Engineeringu & Architektura',
    contextBody:
      'Format XML (<file path="…">) i Skeletonization drastycznie zmniejszają zjawisko Lost-in-the-Middle w modelach Claude, GPT/Codex i Gemini: model widzi jasne granice plików, a mniej istotne obszary zachowują sygnatury bez pełnych ciał funkcji.',
    budgetCol: 'Budżet',
    taskCol: 'Typ zadania',
    budgetRows: [
      ['8k–16k', 'Pojedynczy plik / szybka poprawka'],
      ['32k', 'Bug hunt + deps, pre-PR, testy modułu'],
      ['64k–128k', 'Audyt architektury / AppSec całego podsystemu'],
      ['200k+', 'Monorepo overview ze Skeleton Mode'],
    ] as [string, string][],
    varsHeading: 'Zmienne dynamiczne Prompt Studio',
    varHints: {
      PROJECT_NAME: 'nazwa workspace',
      GIT_BRANCH: 'bieżąca gałąź',
      SELECTED_FILES_COUNT: 'liczba zaznaczonych plików',
      TOKEN_BUDGET: 'limit tokenów',
      SKELETON_MODE: 'Enabled / Full Source',
      DATE_ISO: 'data YYYY-MM-DD',
    } as Record<string, string>,
    shortcutsHeading: 'Skróty klawiszowe, CLI & Serwer MCP',
    shortcutCol: 'Skrót',
    actionCol: 'Akcja',
    shortcutDocs: 'Dokumentacja & How-To',
    shortcutHelp: 'Skróty klawiszowe',
    shortcutEsc: 'Zamknij dialog / wyczyść filtr',
    langLabel: 'Język',
  },
} as const;

export interface DocumentationAndHowToModalProps {
  open: boolean;
  onClose: () => void;
  onApplyPlaybook: (prompt: CustomPromptTemplate, config?: PromptPresetConfig) => void;
  projectName?: string;
  gitBranch?: string;
  selectedFilesCount?: number;
  tokenBudget?: number;
  skeletonEnabled?: boolean;
}

export function DocumentationAndHowToModal({
  open,
  onClose,
  onApplyPlaybook,
  projectName,
  gitBranch,
  selectedFilesCount,
  tokenBudget,
  skeletonEnabled,
}: DocumentationAndHowToModalProps) {
  const [tab, setTab] = useState<DocsTab>('howto');
  const [query, setQuery] = useState('');
  const [locale, setLocale] = useState<DocsLocale>(() => readDocsLocale());
  const searchRef = useRef<HTMLInputElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const t = window.setTimeout(() => searchRef.current?.focus(), 50);
    return () => window.clearTimeout(t);
  }, [open]);

  const t = UI[locale];
  const examples = useMemo(() => buildPlaybooks(locale), [locale]);
  const howtoSteps = HOWTO_STEPS[locale];

  const q = query.trim().toLowerCase();
  const filteredExamples = useMemo(() => {
    if (!q) return examples;
    return examples.filter((ex) =>
      [ex.title, ex.category, ex.whenToUse, ex.promptPreview, ex.config.label]
        .join(' ')
        .toLowerCase()
        .includes(q),
    );
  }, [q, examples]);

  const howtoVisible = useMemo(() => {
    if (!q) return howtoSteps;
    return howtoSteps.filter((s) => `${s.title} ${s.body}`.toLowerCase().includes(q));
  }, [q, howtoSteps]);

  if (!open) return null;

  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      onClose();
    }
  };

  const applyExample = (ex: DocsPlaybookExample) => {
    const prompt = findPromptById(ex.promptId);
    if (!prompt) return;
    setActivePromptId(prompt.id);
    onApplyPlaybook(prompt, ex.config);
    onClose();
  };

  const setLocaleAndPersist = (next: DocsLocale) => {
    setLocale(next);
    writeDocsLocale(next);
  };

  const tabs: DocsTab[] = ['howto', 'examples', 'context', 'shortcuts'];

  return (
    <div
      className="help-overlay docs-overlay"
      role="presentation"
      onClick={onClose}
      onKeyDown={onKeyDown}
    >
      <div
        ref={cardRef}
        className="docs-howto-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="docs-howto-title"
        data-testid="docs-howto-modal"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="docs-howto-header">
          <div className="docs-howto-title-row">
            <BookOpen size={18} aria-hidden />
            <h2 id="docs-howto-title">{t.title}</h2>
            <span className="docs-howto-badge" aria-hidden>
              {t.badge}
            </span>
          </div>
          <div className="docs-locale-toggle" role="group" aria-label={t.langLabel}>
            <button
              type="button"
              className={`docs-locale-btn${locale === 'en' ? ' is-active' : ''}`}
              data-testid="docs-locale-en"
              aria-pressed={locale === 'en'}
              onClick={() => setLocaleAndPersist('en')}
            >
              EN
            </button>
            <button
              type="button"
              className={`docs-locale-btn${locale === 'pl' ? ' is-active' : ''}`}
              data-testid="docs-locale-pl"
              aria-pressed={locale === 'pl'}
              onClick={() => setLocaleAndPersist('pl')}
            >
              PL
            </button>
          </div>
          <button
            type="button"
            className="btn btn-ghost btn-icon"
            onClick={onClose}
            aria-label="Close documentation"
            data-testid="docs-howto-close-btn"
          >
            <X size={14} />
          </button>
        </div>

        <div className="docs-search-row">
          <Search size={13} className="docs-search-icon" aria-hidden />
          <input
            ref={searchRef}
            type="search"
            className="docs-search-input"
            placeholder={t.searchPlaceholder}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search documentation"
            data-testid="docs-search-input"
          />
        </div>

        <div className="docs-tabs sticky-tabs" role="tablist" aria-label="Documentation sections">
          {tabs.map((id) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={tab === id}
              className={`docs-tab${tab === id ? ' is-active' : ''}`}
              data-testid={`docs-tab-${id}`}
              onClick={() => setTab(id)}
            >
              {t.tabs[id]}
            </button>
          ))}
        </div>

        <div className="docs-howto-body" role="tabpanel">
          {tab === 'howto' && (
            <div className="docs-howto-steps" data-testid="docs-howto-section">
              <h3>{t.howtoHeading}</h3>
              <ol className="docs-step-list">
                {howtoVisible.map((step, i) => (
                  <li key={step.title} className="docs-step-card">
                    <span className="docs-step-num" aria-hidden>
                      {i + 1}
                    </span>
                    <div>
                      <strong>{step.title}</strong>
                      <p>{step.body}</p>
                    </div>
                  </li>
                ))}
              </ol>
            </div>
          )}

          {tab === 'examples' && (
            <div className="docs-examples" data-testid="docs-examples-section">
              <h3>{t.examplesHeading}</h3>
              <div className="docs-example-grid">
                {filteredExamples.map((ex) => {
                  const preview = interpolatePromptVariables(ex.promptPreview, {
                    projectName,
                    gitBranch,
                    selectedFilesCount,
                    tokenBudget: ex.config.recommendedBudget ?? tokenBudget,
                    skeletonEnabled: ex.config.enableSkeleton ?? skeletonEnabled,
                  });
                  return (
                    <article
                      key={ex.id}
                      className="docs-example-card"
                      data-testid="docs-example-card"
                    >
                      <header className="docs-example-header">
                        <h4>{ex.title}</h4>
                        <div className="docs-example-tags">
                          <span className="docs-tag">{ex.category}</span>
                          <span className="docs-tag docs-tag-diff">{ex.difficulty}</span>
                        </div>
                      </header>
                      <p className="docs-example-when">
                        <strong>{t.whenToUse}</strong> {ex.whenToUse}
                      </p>
                      <p className="docs-example-config">
                        <strong>{t.configuration}</strong> {ex.config.label}
                      </p>
                      <pre className="docs-example-prompt">
                        {preview.slice(0, 600)}
                        {preview.length > 600 ? '…' : ''}
                      </pre>
                      <p className="docs-example-tokens meta-inline">
                        ~{formatTokens(estimateTokens(preview))} tokens prompt
                      </p>
                      <button
                        type="button"
                        className="btn btn-primary docs-apply-btn"
                        data-testid="apply-example-playbook-btn"
                        onClick={() => applyExample(ex)}
                      >
                        <Sparkles size={14} aria-hidden /> {t.applyPlaybook}
                      </button>
                    </article>
                  );
                })}
              </div>
            </div>
          )}

          {tab === 'context' && (
            <div className="docs-context" data-testid="docs-context-section">
              <h3>{t.contextHeading}</h3>
              <p>{t.contextBody}</p>
              <table className="docs-table">
                <thead>
                  <tr>
                    <th>{t.budgetCol}</th>
                    <th>{t.taskCol}</th>
                  </tr>
                </thead>
                <tbody>
                  {t.budgetRows.map(([budget, task]) => (
                    <tr key={budget}>
                      <td>{budget}</td>
                      <td>{task}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <h4>{t.varsHeading}</h4>
              <ul className="docs-var-list">
                {Object.entries(t.varHints).map(([key, hint]) => (
                  <li key={key}>
                    <code>{`{{${key}}}`}</code> — {hint}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {tab === 'shortcuts' && (
            <div className="docs-shortcuts" data-testid="docs-shortcuts-section">
              <h3>{t.shortcutsHeading}</h3>
              <table className="docs-table">
                <thead>
                  <tr>
                    <th>{t.shortcutCol}</th>
                    <th>{t.actionCol}</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>
                      <span className="kbd">F1</span> /{' '}
                      <span className="kbd">{formatShortcut('/')}</span>
                    </td>
                    <td>{t.shortcutDocs}</td>
                  </tr>
                  <tr>
                    <td>
                      <span className="kbd">?</span>
                    </td>
                    <td>{t.shortcutHelp}</td>
                  </tr>
                  <tr>
                    <td>
                      <span className="kbd">{formatShortcut('O')}</span>
                    </td>
                    <td>Open folder</td>
                  </tr>
                  <tr>
                    <td>
                      <span className="kbd">{formatShortcut('C')}</span>
                    </td>
                    <td>Copy packed output</td>
                  </tr>
                  <tr>
                    <td>
                      <span className="kbd">Esc</span>
                    </td>
                    <td>{t.shortcutEsc}</td>
                  </tr>
                </tbody>
              </table>
              <h4>CLI (CI/CD)</h4>
              <pre className="docs-example-prompt">{`# Pack selected paths for a PR context
ptt pack --format xml --budget 32000 --skeleton ./src

# Emit JSON for downstream agents
ptt pack --format json --include-git-diff | jq .files`}</pre>
              <h4>MCP — Cursor (<code>.cursor/mcp.json</code>)</h4>
              <pre className="docs-example-prompt">{`{
  "mcpServers": {
    "projecttotext": {
      "command": "ptt",
      "args": ["mcp"]
    }
  }
}`}</pre>
              <h4>MCP — Claude Desktop</h4>
              <pre className="docs-example-prompt">{`{
  "mcpServers": {
    "projecttotext": {
      "command": "ptt",
      "args": ["mcp"]
    }
  }
}`}</pre>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
