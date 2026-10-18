import { useMemo, useState } from 'react';
import { Sparkles, Star } from 'lucide-react';
import { type BudgetPreset, estimateTokens, formatTokens, PROMPT_TEMPLATES } from './treeModel';
import type { WorkspaceState } from './useWorkspace';
import {
  BUILT_IN_PROMPTS,
  findPromptById,
  interpolatePromptVariables,
  listAllPrompts,
  loadPromptStudioStore,
  resolveDefaultPromptForWorkspace,
  setGlobalDefaultPrompt,
  setWorkspaceDefaultPrompt,
  type CustomPromptTemplate,
} from './projectPrefs';
import { PromptStudioManager } from './PromptStudioManager';

export function BudgetAndPromptBar({ ws }: { ws: WorkspaceState }) {
  const {
    autoFitToBudget,
    budgetPreset,
    currentPath,
    customBudget,
    format,
    generate,
    gitContext,
    nodes,
    promptStudioRevision,
    promptTemplateId,
    pushToast,
    selectedCount,
    setBudgetPreset,
    setCustomBudget,
    setPromptTemplateId,
    setShowTopConsumers,
    setTaskPrompt,
    showPromptManager,
    showPromptStudio,
    showTopConsumers,
    skeletonSet,
    stats,
    targetBudgetTokens,
    taskPrompt,
    refreshPromptStudio,
    setShowPromptManager,
  } = ws;

  const [defaultScope, setDefaultScope] = useState<'global' | 'workspace'>('global');

  const store = useMemo(
    () => loadPromptStudioStore(),
    [promptStudioRevision, showPromptStudio, showPromptManager],
  );
  const allPrompts = useMemo(() => listAllPrompts(store), [store]);
  const defaultPrompt = useMemo(
    () => resolveDefaultPromptForWorkspace(currentPath || null),
    [currentPath, promptStudioRevision, store],
  );

  const folderName = currentPath
    ? currentPath.split(/[/\\]/).filter(Boolean).pop() ?? currentPath
    : 'Workspace';

  const interpolatedPrompt = useMemo(
    () =>
      interpolatePromptVariables(taskPrompt, {
        projectName: folderName,
        gitBranch: gitContext?.currentBranch ?? undefined,
        selectedFilesCount: selectedCount,
        tokenBudget: targetBudgetTokens,
        skeletonEnabled: skeletonSet.size > 0,
      }),
    [
      taskPrompt,
      folderName,
      gitContext?.currentBranch,
      selectedCount,
      targetBudgetTokens,
      skeletonSet,
    ],
  );

  const promptTokens = estimateTokens(interpolatedPrompt);
  const defaultInterpolated = defaultPrompt
    ? interpolatePromptVariables(defaultPrompt.content, {
        projectName: folderName,
        gitBranch: gitContext?.currentBranch ?? undefined,
        selectedFilesCount: selectedCount,
        tokenBudget: targetBudgetTokens,
        skeletonEnabled: skeletonSet.size > 0,
      })
    : '';
  const isCurrentDefault = Boolean(
    defaultPrompt &&
      promptTemplateId !== 'none' &&
      (defaultPrompt.id === promptTemplateId ||
        (promptTemplateId === 'custom' &&
          (taskPrompt === defaultPrompt.content || taskPrompt === defaultInterpolated))),
  );

  const applyTemplate = (id: string) => {
    setPromptTemplateId(id);
    if (id === 'none') {
      setTaskPrompt('');
      if (currentPath && nodes.length > 0) {
        generate(nodes, currentPath, format, true, { prompt: '' });
      }
      return;
    }
    if (id === 'custom') return;
    const tpl =
      findPromptById(id) ??
      PROMPT_TEMPLATES.find((t) => t.id === id);
    if (!tpl) return;
    const content = 'content' in tpl ? tpl.content : tpl.prompt;
    const text = interpolatePromptVariables(content, {
      projectName: folderName,
      gitBranch: gitContext?.currentBranch ?? undefined,
      selectedFilesCount: selectedCount,
      tokenBudget: targetBudgetTokens,
      skeletonEnabled: skeletonSet.size > 0,
    });
    setTaskPrompt(text);
    if (currentPath && nodes.length > 0) {
      generate(nodes, currentPath, format, true, { prompt: text });
    }
  };

  const toggleDefault = () => {
    const id =
      promptTemplateId === 'custom' || promptTemplateId === 'none'
        ? defaultPrompt?.id ?? null
        : promptTemplateId;
    const targetId =
      promptTemplateId !== 'none' && promptTemplateId !== 'custom'
        ? promptTemplateId
        : id;
    if (!targetId || targetId === 'none' || targetId === 'custom') {
      pushToast('info', 'Wybierz szablon promptu, aby ustawić domyślny');
      return;
    }
    try {
      if (defaultPrompt?.id === targetId) {
        if (defaultScope === 'workspace' && currentPath) {
          setWorkspaceDefaultPrompt(currentPath, null);
        } else {
          setGlobalDefaultPrompt(null);
        }
        pushToast('info', 'Usunięto domyślny prompt');
      } else if (defaultScope === 'workspace' && currentPath) {
        setWorkspaceDefaultPrompt(currentPath, targetId);
        pushToast('success', 'Ustawiono domyślny prompt dla projektu');
      } else {
        setGlobalDefaultPrompt(targetId);
        pushToast('success', 'Ustawiono domyślny prompt globalnie');
      }
      refreshPromptStudio();
    } catch (e) {
      pushToast('error', e instanceof Error ? e.message : String(e));
    }
  };

  const onSelectFromManager = (prompt: CustomPromptTemplate) => {
    setPromptTemplateId(prompt.id);
    const text = interpolatePromptVariables(prompt.content, {
      projectName: folderName,
      gitBranch: gitContext?.currentBranch ?? undefined,
      selectedFilesCount: selectedCount,
      tokenBudget: targetBudgetTokens,
      skeletonEnabled: skeletonSet.size > 0,
    });
    setTaskPrompt(text);
    setShowPromptManager(false);
    if (currentPath && nodes.length > 0) {
      generate(nodes, currentPath, format, true, { prompt: text });
    }
  };

  const customGroup = allPrompts.filter((p) => !p.isBuiltIn);
  const builtInGroup = BUILT_IN_PROMPTS;

  return (
    <>
      {/* Context Budget Bar */}
      {currentPath && (
        <div className="budget-bar-row" data-testid="context-budget-bar">
          <span className="panel-title">Context Budget</span>
          <select
            className="select"
            aria-label="Target token budget"
            data-testid="budget-select"
            value={budgetPreset}
            onChange={(e) => setBudgetPreset(e.target.value as BudgetPreset)}
          >
            <option value="32k">32k</option>
            <option value="64k">64k</option>
            <option value="128k">128k</option>
            <option value="200k">200k</option>
            <option value="1m">1M</option>
            <option value="custom">Custom</option>
          </select>
          {budgetPreset === 'custom' && (
            <input
              type="number"
              className="select"
              style={{ width: 92, paddingRight: 6 }}
              min={1000}
              step={1000}
              value={customBudget}
              onChange={(e) => setCustomBudget(Number(e.target.value) || 128_000)}
              aria-label="Custom token budget"
            />
          )}
          {(() => {
            const fullTokens = ws.fileTokens
              .filter((f) => f.mode === 'full')
              .reduce((sum, f) => sum + f.tokens, 0);
            const skeletonTokens = ws.fileTokens
              .filter((f) => f.mode === 'skeleton')
              .reduce((sum, f) => sum + f.tokens, 0);
            const totalContentTokens =
              ws.stats.contentTokens ?? fullTokens + skeletonTokens;
            const reportedOverhead =
              ws.stats.overheadTokens ??
              Math.max(0, ws.stats.tokens - totalContentTokens);
            // BUG-01: ensure live prompt tokens are visible in the budget meter
            const overheadTokens = Math.max(reportedOverhead, promptTokens);
            const displayTokens = Math.max(
              stats.tokens,
              totalContentTokens + promptTokens,
            );

            const budgetMax = Math.max(1, targetBudgetTokens);
            const fullPct = Math.min(100, (fullTokens / budgetMax) * 100);
            const skeletonPct = Math.min(
              100 - fullPct,
              (skeletonTokens / budgetMax) * 100,
            );
            const overheadPct = Math.min(
              100 - fullPct - skeletonPct,
              (overheadTokens / budgetMax) * 100,
            );
            const totalPct = Math.min(100, Math.round((displayTokens / budgetMax) * 100));

            return (
              <div className="budget-meter-wrap">
                <div
                  className="budget-track"
                  role="progressbar"
                  aria-valuenow={displayTokens}
                  aria-valuemax={targetBudgetTokens}
                  style={{ display: 'flex', overflow: 'hidden' }}
                >
                  {fullTokens > 0 && (
                    <div
                      className="budget-segment budget-segment-full"
                      title={`Full Content: ${formatTokens(fullTokens)} tokens`}
                      style={{
                        width: `${fullPct}%`,
                        height: '100%',
                        backgroundColor: 'var(--color-accent, #38bdf8)',
                        transition: 'width 0.2s ease',
                      }}
                    />
                  )}
                  {skeletonTokens > 0 && (
                    <div
                      className="budget-segment budget-segment-skeleton"
                      title={`AST Skeletons: ${formatTokens(skeletonTokens)} tokens`}
                      style={{
                        width: `${skeletonPct}%`,
                        height: '100%',
                        backgroundColor: 'var(--color-skeleton, #a78bfa)',
                        transition: 'width 0.2s ease',
                      }}
                    />
                  )}
                  {overheadTokens > 0 && (
                    <div
                      className="budget-segment budget-segment-overhead"
                      title={`Wrapper/Diff/Prompt Overhead: ${formatTokens(overheadTokens)} tokens (prompt ≈ ${formatTokens(promptTokens)})`}
                      style={{
                        width: `${overheadPct}%`,
                        height: '100%',
                        backgroundColor: 'var(--color-overhead, #94a3b8)',
                        transition: 'width 0.2s ease',
                      }}
                    />
                  )}
                  {fullTokens === 0 && skeletonTokens === 0 && displayTokens > 0 && (
                    <div
                      className={[
                        'budget-fill',
                        displayTokens > targetBudgetTokens
                          ? 'is-over'
                          : displayTokens > targetBudgetTokens * 0.85
                            ? 'is-warn'
                            : '',
                      ]
                        .filter(Boolean)
                        .join(' ')}
                      style={{ width: `${totalPct}%` }}
                    />
                  )}
                </div>
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: '8px',
                  }}
                >
                  <span className="budget-label" data-testid="budget-progress-label">
                    {stats.tokenizerExact === false ? '~' : ''}
                    {formatTokens(displayTokens)} / {formatTokens(targetBudgetTokens)} tokens (
                    {totalPct}%)
                  </span>
                  {displayTokens > 0 && (
                    <span
                      className="budget-breakdown-chips"
                      data-testid="budget-breakdown-chips"
                      style={{ fontSize: '10px', opacity: 0.75, display: 'flex', gap: '6px' }}
                    >
                      <span
                        data-testid="budget-chip-content"
                        title="Content tokens (full + skeletons)"
                      >
                        Content: {stats.tokenizerExact === false ? '~' : ''}
                        {formatTokens(totalContentTokens)}
                      </span>
                      {(overheadTokens > 0 || promptTokens > 0) && (
                        <span
                          data-testid="budget-chip-overhead"
                          title={`Wrapper, Diff & Task Prompt (~${formatTokens(promptTokens)} prompt)`}
                        >
                          Overhead: {stats.tokenizerExact === false ? '~' : ''}
                          {formatTokens(overheadTokens)}
                        </span>
                      )}
                      {promptTokens > 0 && (
                        <span data-testid="budget-chip-prompt" title="Active prompt tokens (interpolated)">
                          Prompt: ~{formatTokens(promptTokens)}
                        </span>
                      )}
                    </span>
                  )}
                </div>
              </div>
            );
          })()}

          <button
            type="button"
            className="btn btn-ghost"
            onClick={autoFitToBudget}
            disabled={selectedCount === 0}
            data-testid="btn-auto-fit-budget"
            title="Automatically skeletonize or deselect low-priority files to fit <= 90% of target budget"
          >
            Auto-Fit to Budget
          </button>

          <button
            type="button"
            className={`btn btn-ghost ${showTopConsumers ? 'is-active' : ''}`}
            onClick={() => setShowTopConsumers((v) => !v)}
            aria-expanded={showTopConsumers}
            data-testid="btn-top-consumers"
          >
            Top Token Consumers
          </button>
        </div>
      )}

      {/* Prompt Studio collapsible bar */}
      {showPromptStudio && (
        <div className="prompt-studio-bar" data-testid="prompt-studio-panel">
          <div className="prompt-studio-controls">
            <span className="panel-title">Prompt Studio</span>
            <select
              className="select"
              aria-label="Prompt template"
              data-testid="prompt-template-select"
              value={promptTemplateId}
              onChange={(e) => applyTemplate(e.target.value)}
            >
              <option value="none">No task prompt</option>
              {defaultPrompt && (
                <optgroup label="★ Domyślny (Aktywny Default)">
                  <option value={defaultPrompt.id}>
                    ★ {defaultPrompt.name}
                  </option>
                </optgroup>
              )}
              {customGroup.length > 0 && (
                <optgroup label="Moje Prompty (Custom)">
                  {customGroup.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </optgroup>
              )}
              <optgroup label="Wbudowane Playbooki (Built-in)">
                {builtInGroup.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </optgroup>
              <option value="custom">Custom Task Prompt…</option>
            </select>

            <button
              type="button"
              className={`btn btn-ghost btn-star-default${isCurrentDefault ? ' active is-default-prompt' : ''}`}
              data-testid="toggle-default-prompt-btn"
              aria-pressed={Boolean(isCurrentDefault)}
              aria-label={isCurrentDefault ? 'Default prompt' : 'Set as default prompt'}
              title={isCurrentDefault ? '★ Domyślny' : '☆ Ustaw jako domyślny'}
              onClick={toggleDefault}
            >
              {isCurrentDefault ? (
                <>
                  <Star size={13} fill="currentColor" aria-hidden /> ★ Domyślny
                </>
              ) : (
                <>
                  <Star size={13} aria-hidden /> ☆ Ustaw jako domyślny
                </>
              )}
            </button>
            {isCurrentDefault && (
              <span className="prompt-default-badge" data-testid="prompt-default-badge">
                DOMYŚLNY
              </span>
            )}

            <div className="prompt-default-scope" role="group" aria-label="Default scope">
              <label>
                <input
                  type="radio"
                  name="bar-default-scope"
                  checked={defaultScope === 'global'}
                  onChange={() => setDefaultScope('global')}
                />{' '}
                Globalnie
              </label>
              <label>
                <input
                  type="radio"
                  name="bar-default-scope"
                  checked={defaultScope === 'workspace'}
                  onChange={() => setDefaultScope('workspace')}
                  disabled={!currentPath}
                />{' '}
                Ten projekt
              </label>
            </div>

            <button
              type="button"
              className="btn btn-ghost"
              data-testid="open-prompt-studio-btn"
              aria-haspopup="dialog"
              onClick={() => setShowPromptManager(true)}
            >
              <Sparkles size={13} aria-hidden /> Zarządzaj Promptami (+ Dodaj)
            </button>

            <span className="meta-inline">
              Appended at the very end inside <code>&lt;task_instructions&gt;</code> · prompt ~{' '}
              {formatTokens(promptTokens)} tok
            </span>
          </div>
          <textarea
            className="prompt-studio-textarea"
            placeholder="Describe the engineering task, bug, or review question to append inside <task_instructions>…"
            value={taskPrompt}
            data-testid="prompt-studio-input"
            onChange={(e) => {
              const val = e.target.value;
              setTaskPrompt(val);
              setPromptTemplateId('custom');
              if (currentPath && nodes.length > 0) {
                generate(nodes, currentPath, format, false, { prompt: val });
              }
            }}
            aria-label="Task prompt content"
          />
        </div>
      )}

      <PromptStudioManager
        open={showPromptManager}
        onClose={() => setShowPromptManager(false)}
        workspacePath={currentPath || null}
        onPromptsChanged={refreshPromptStudio}
        onSelectPrompt={onSelectFromManager}
        pushToast={pushToast}
      />
    </>
  );
}
