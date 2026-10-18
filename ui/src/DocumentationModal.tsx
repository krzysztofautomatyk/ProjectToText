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
import { createTranslator, useI18n, type TranslateFn } from './i18n';

export type DocsTab = 'howto' | 'examples' | 'context' | 'shortcuts';

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

const HOWTO_STEP_NUMBERS = [1, 2, 3, 4, 5, 6] as const;

type PlaybookShort =
  | 'architecture'
  | 'bugfix'
  | 'appsec'
  | 'prepr'
  | 'feature'
  | 'tests'
  | 'onboarding';

interface PlaybookDef {
  short: PlaybookShort;
  promptId: string;
  category: string;
  difficulty: DocsPlaybookExample['difficulty'];
  config: PromptPresetConfig;
}

const PLAYBOOK_DEFS: PlaybookDef[] = [
  {
    short: 'architecture',
    promptId: 'playbook-architecture',
    category: 'architecture',
    difficulty: 'Expert',
    config: { recommendedBudget: 64000, recommendedFormat: 'xml', enableSkeleton: true },
  },
  {
    short: 'bugfix',
    promptId: 'playbook-bugfix',
    category: 'bugfix',
    difficulty: 'Advanced',
    config: {
      recommendedBudget: 32000,
      recommendedFormat: 'xml',
      enableSkeleton: false,
      includeDeps: true,
    },
  },
  {
    short: 'appsec',
    promptId: 'playbook-appsec',
    category: 'security',
    difficulty: 'Expert',
    config: { recommendedBudget: 64000, recommendedFormat: 'xml' },
  },
  {
    short: 'prepr',
    promptId: 'playbook-prepr',
    category: 'review',
    difficulty: 'Intermediate',
    config: { recommendedBudget: 32000, recommendedFormat: 'xml', includeGitDiff: true },
  },
  {
    short: 'feature',
    promptId: 'playbook-feature',
    category: 'docs',
    difficulty: 'Advanced',
    config: { recommendedBudget: 64000, recommendedFormat: 'xml' },
  },
  {
    short: 'tests',
    promptId: 'playbook-tests',
    category: 'testing',
    difficulty: 'Intermediate',
    config: { recommendedBudget: 32000, recommendedFormat: 'xml' },
  },
  {
    short: 'onboarding',
    promptId: 'playbook-onboarding',
    category: 'docs',
    difficulty: 'Intermediate',
    config: { recommendedBudget: 32000, recommendedFormat: 'xml', enableSkeleton: true },
  },
];

function buildPlaybooks(t: TranslateFn): DocsPlaybookExample[] {
  return PLAYBOOK_DEFS.map((def) => {
    const tpl = findPromptById(def.promptId) ?? BUILT_IN_PROMPTS.find((p) => p.id === def.promptId)!;
    return {
      id: `ex-${def.promptId}`,
      promptId: def.promptId,
      promptPreview: tpl.content,
      title: t(`docs.playbook.${def.short}.title`),
      category: def.category,
      difficulty: def.difficulty,
      whenToUse: t(`docs.playbook.${def.short}.whenToUse`),
      config: { ...def.config, label: t(`docs.playbook.${def.short}.config`) },
    };
  });
}

/** Default (English) playbook list for consumers/tests. */
export const DOCS_PLAYBOOK_EXAMPLES: DocsPlaybookExample[] = buildPlaybooks(createTranslator('en'));

const BUDGET_ROWS = [
  ['8k–16k', 'docs.budgetRow1.task'],
  ['32k', 'docs.budgetRow2.task'],
  ['64k–128k', 'docs.budgetRow3.task'],
  ['200k+', 'docs.budgetRow4.task'],
] as const;

const DOC_VARIABLES = [
  'PROJECT_NAME',
  'GIT_BRANCH',
  'SELECTED_FILES_COUNT',
  'TOKEN_BUDGET',
  'SKELETON_MODE',
  'DATE_ISO',
] as const;

const DOCS_TABS: DocsTab[] = ['howto', 'examples', 'context', 'shortcuts'];

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
  const { t, tRich, locale, setLocale } = useI18n();
  const searchRef = useRef<HTMLInputElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const timer = window.setTimeout(() => searchRef.current?.focus(), 50);
    return () => window.clearTimeout(timer);
  }, [open]);

  const examples = useMemo(() => buildPlaybooks(t), [t]);
  const howtoSteps = useMemo(
    () =>
      HOWTO_STEP_NUMBERS.map((n) => ({
        title: t(`docs.howto.step${n}.title`),
        body: t(`docs.howto.step${n}.body`),
      })),
    [t],
  );

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
            <h2 id="docs-howto-title">{t('docs.title')}</h2>
            <span className="docs-howto-badge" aria-hidden>
              {t('docs.badge')}
            </span>
          </div>
          <div className="docs-locale-toggle" role="group" aria-label={t('docs.langLabel')}>
            <button
              type="button"
              className={`docs-locale-btn${locale === 'en' ? ' is-active' : ''}`}
              data-testid="docs-locale-en"
              aria-pressed={locale === 'en'}
              onClick={() => setLocale('en')}
            >
              EN
            </button>
            <button
              type="button"
              className={`docs-locale-btn${locale === 'pl' ? ' is-active' : ''}`}
              data-testid="docs-locale-pl"
              aria-pressed={locale === 'pl'}
              onClick={() => setLocale('pl')}
            >
              PL
            </button>
          </div>
          <button
            type="button"
            className="btn btn-ghost btn-icon"
            onClick={onClose}
            aria-label={t('docs.closeAria')}
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
            placeholder={t('docs.searchPlaceholder')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label={t('docs.searchAria')}
            data-testid="docs-search-input"
          />
        </div>

        <div className="docs-tabs sticky-tabs" role="tablist" aria-label={t('docs.tabsAria')}>
          {DOCS_TABS.map((id) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={tab === id}
              className={`docs-tab${tab === id ? ' is-active' : ''}`}
              data-testid={`docs-tab-${id}`}
              onClick={() => setTab(id)}
            >
              {t(`docs.tab.${id}`)}
            </button>
          ))}
        </div>

        <div className="docs-howto-body" role="tabpanel">
          {tab === 'howto' && (
            <div className="docs-howto-steps" data-testid="docs-howto-section">
              <h3>{t('docs.howtoHeading')}</h3>
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
              <h3>{t('docs.examplesHeading')}</h3>
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
                        <strong>{t('docs.whenToUse')}</strong> {ex.whenToUse}
                      </p>
                      <p className="docs-example-config">
                        <strong>{t('docs.configuration')}</strong> {ex.config.label}
                      </p>
                      <pre className="docs-example-prompt">
                        {preview.slice(0, 600)}
                        {preview.length > 600 ? '…' : ''}
                      </pre>
                      <p className="docs-example-tokens meta-inline">
                        {t('docs.promptTokens', { tokens: formatTokens(estimateTokens(preview)) })}
                      </p>
                      <button
                        type="button"
                        className="btn btn-primary docs-apply-btn"
                        data-testid="apply-example-playbook-btn"
                        onClick={() => applyExample(ex)}
                      >
                        <Sparkles size={14} aria-hidden /> {t('docs.applyPlaybook')}
                      </button>
                    </article>
                  );
                })}
              </div>
            </div>
          )}

          {tab === 'context' && (
            <div className="docs-context" data-testid="docs-context-section">
              <h3>{t('docs.contextHeading')}</h3>
              <p>{t('docs.contextBody')}</p>
              <table className="docs-table">
                <thead>
                  <tr>
                    <th>{t('docs.budgetCol')}</th>
                    <th>{t('docs.taskCol')}</th>
                  </tr>
                </thead>
                <tbody>
                  {BUDGET_ROWS.map(([budget, taskKey]) => (
                    <tr key={budget}>
                      <td>{budget}</td>
                      <td>{t(taskKey)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <h4>{t('docs.varsHeading')}</h4>
              <ul className="docs-var-list">
                {DOC_VARIABLES.map((key) => (
                  <li key={key}>
                    <code>{`{{${key}}}`}</code> — {t(`docs.var.${key}`)}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {tab === 'shortcuts' && (
            <div className="docs-shortcuts" data-testid="docs-shortcuts-section">
              <h3>{t('docs.shortcutsHeading')}</h3>
              <table className="docs-table">
                <thead>
                  <tr>
                    <th>{t('docs.shortcutCol')}</th>
                    <th>{t('docs.actionCol')}</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>
                      <span className="kbd">F1</span> /{' '}
                      <span className="kbd">{formatShortcut('/')}</span>
                    </td>
                    <td>{t('docs.shortcutDocs')}</td>
                  </tr>
                  <tr>
                    <td>
                      <span className="kbd">?</span>
                    </td>
                    <td>{t('docs.shortcutHelp')}</td>
                  </tr>
                  <tr>
                    <td>
                      <span className="kbd">{formatShortcut('O')}</span>
                    </td>
                    <td>{t('docs.shortcutOpen')}</td>
                  </tr>
                  <tr>
                    <td>
                      <span className="kbd">{formatShortcut('C')}</span>
                    </td>
                    <td>{t('docs.shortcutCopy')}</td>
                  </tr>
                  <tr>
                    <td>
                      <span className="kbd">Esc</span>
                    </td>
                    <td>{t('docs.shortcutEsc')}</td>
                  </tr>
                </tbody>
              </table>
              <h4>{t('docs.cliHeading')}</h4>
              <pre className="docs-example-prompt">{`# Pack selected paths for a PR context
ptt pack --format xml --budget 32000 --skeleton ./src

# Emit JSON for downstream agents
ptt pack --format json --include-git-diff | jq .files`}</pre>
              <h4>{tRich('docs.mcpCursorHeading')}</h4>
              <pre className="docs-example-prompt">{`{
  "mcpServers": {
    "projecttotext": {
      "command": "ptt",
      "args": ["mcp"]
    }
  }
}`}</pre>
              <h4>{t('docs.mcpClaudeHeading')}</h4>
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
