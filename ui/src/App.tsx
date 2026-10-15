import { formatTokens } from './treeModel';
import { ToastViewport } from './Panels';
import './index.css';
import { useWorkspace } from './useWorkspace';
import { AppHeader, AppStatusBar, AppToolbar } from './AppChrome';
import { BudgetAndPromptBar } from './BudgetAndPromptBar';
import { MainPanel } from './MainPanel';

function App() {
  const ws = useWorkspace();
  const { dismissToast, dragOver, generating, output, stats, toasts, treeWidth } = ws;
  return (
    <div
      className={`app-container${dragOver ? ' drag-over' : ''}`}
      style={{ ['--tree-width' as string]: `${treeWidth}px` }}
      data-testid="app-root"
    >
      <AppHeader ws={ws} />
      <AppToolbar ws={ws} />
      <BudgetAndPromptBar ws={ws} />
      <MainPanel ws={ws} />
      <AppStatusBar ws={ws} />
      <ToastViewport toasts={toasts} onDismiss={dismissToast} />

      <div className="sr-only" aria-live="polite" aria-atomic="true">
        {generating
          ? 'Updating packed output'
          : output
            ? `Ready. ${stats.files} files, about ${formatTokens(stats.tokens)} tokens.`
            : ''}
      </div>
    </div>
  );
}

export default App;
