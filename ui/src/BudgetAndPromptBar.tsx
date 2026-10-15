import { type BudgetPreset, PROMPT_TEMPLATES, formatTokens } from './treeModel';
import type { WorkspaceState } from './useWorkspace';

export function BudgetAndPromptBar({ ws }: { ws: WorkspaceState }) {
  const { autoFitToBudget, budgetPreset, currentPath, customBudget, format, generate, nodes, promptTemplateId, selectedCount, setBudgetPreset, setCustomBudget, setPromptTemplateId, setShowTopConsumers, setTaskPrompt, showPromptStudio, showTopConsumers, stats, targetBudgetTokens, taskPrompt } = ws;
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
          <div className="budget-meter-wrap">
            <div className="budget-track" role="progressbar" aria-valuenow={stats.tokens} aria-valuemax={targetBudgetTokens}>
              <div
                className={[
                  'budget-fill',
                  stats.tokens > targetBudgetTokens
                    ? 'is-over'
                    : stats.tokens > targetBudgetTokens * 0.85
                      ? 'is-warn'
                      : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
                style={{
                  width: `${Math.min(100, Math.round((stats.tokens / Math.max(1, targetBudgetTokens)) * 100))}%`,
                }}
              />
            </div>
            <span className="budget-label" data-testid="budget-progress-label">
              {formatTokens(stats.tokens)} / {formatTokens(targetBudgetTokens)} tokens (
              {Math.round((stats.tokens / Math.max(1, targetBudgetTokens)) * 100)}%)
            </span>
          </div>

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
              onChange={(e) => {
                const id = e.target.value;
                setPromptTemplateId(id);
                const tpl = PROMPT_TEMPLATES.find((t) => t.id === id);
                if (tpl && id !== 'custom') {
                  setTaskPrompt(tpl.prompt);
                  if (currentPath && nodes.length > 0) {
                    generate(nodes, currentPath, format, true, { prompt: tpl.prompt });
                  }
                }
              }}
            >
              {PROMPT_TEMPLATES.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label}
                </option>
              ))}
            </select>
            <span className="meta-inline">
              Appended at the very end inside <code>&lt;task_instructions&gt;</code> for optimal long-context LLM reasoning.
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
          />
        </div>
      )}

    </>
  );
}
