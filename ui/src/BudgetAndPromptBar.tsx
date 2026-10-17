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
          {(() => {
            const fullTokens = ws.fileTokens
              .filter((f) => f.mode === 'full')
              .reduce((sum, f) => sum + f.tokens, 0);
            const skeletonTokens = ws.fileTokens
              .filter((f) => f.mode === 'skeleton')
              .reduce((sum, f) => sum + f.tokens, 0);
            const totalContentTokens = ws.stats.contentTokens ?? (fullTokens + skeletonTokens);
            const overheadTokens = ws.stats.overheadTokens ?? Math.max(0, ws.stats.tokens - totalContentTokens);

            const budgetMax = Math.max(1, targetBudgetTokens);
            const fullPct = Math.min(100, (fullTokens / budgetMax) * 100);
            const skeletonPct = Math.min(100 - fullPct, (skeletonTokens / budgetMax) * 100);
            const overheadPct = Math.min(100 - fullPct - skeletonPct, (overheadTokens / budgetMax) * 100);
            const totalPct = Math.min(100, Math.round((stats.tokens / budgetMax) * 100));

            return (
              <div className="budget-meter-wrap">
                <div
                  className="budget-track"
                  role="progressbar"
                  aria-valuenow={stats.tokens}
                  aria-valuemax={targetBudgetTokens}
                  style={{ display: 'flex', overflow: 'hidden' }}
                >
                  {fullTokens > 0 && (
                    <div
                      className="budget-segment budget-segment-full"
                      title={`Full Content: ${formatTokens(fullTokens)} tokens (${Math.round((fullTokens / Math.max(1, stats.tokens)) * 100)}%)`}
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
                      title={`AST Skeletons: ${formatTokens(skeletonTokens)} tokens (${Math.round((skeletonTokens / Math.max(1, stats.tokens)) * 100)}%)`}
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
                      title={`Wrapper/Diff/Prompt Overhead: ${formatTokens(overheadTokens)} tokens (${Math.round((overheadTokens / Math.max(1, stats.tokens)) * 100)}%)`}
                      style={{
                        width: `${overheadPct}%`,
                        height: '100%',
                        backgroundColor: 'var(--color-overhead, #94a3b8)',
                        transition: 'width 0.2s ease',
                      }}
                    />
                  )}
                  {fullTokens === 0 && skeletonTokens === 0 && stats.tokens > 0 && (
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
                      style={{ width: `${totalPct}%` }}
                    />
                  )}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
                  <span className="budget-label" data-testid="budget-progress-label">
                    {stats.tokenizerExact === false ? '~' : ''}{formatTokens(stats.tokens)} / {formatTokens(targetBudgetTokens)} tokens ({totalPct}%)
                  </span>
                  {stats.tokens > 0 && (
                    <span className="budget-breakdown-chips" data-testid="budget-breakdown-chips" style={{ fontSize: '10px', opacity: 0.75, display: 'flex', gap: '6px' }}>
                      <span data-testid="budget-chip-content" title={`Content tokens (full + skeletons)${stats.tokenizerExact === false ? ' (approximate)' : ''}`}>
                        Content: {stats.tokenizerExact === false ? '~' : ''}{formatTokens(totalContentTokens)}
                      </span>
                      {overheadTokens > 0 && (
                        <span data-testid="budget-chip-overhead" title={`Wrapper, Diff & Task Prompt overhead tokens${stats.tokenizerExact === false ? ' (approximate)' : ''}`}>
                          Overhead: {stats.tokenizerExact === false ? '~' : ''}{formatTokens(overheadTokens)}
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
