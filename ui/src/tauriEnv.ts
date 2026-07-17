/** Detect whether we are running inside a Tauri webview (desktop app). */
export function isTauriRuntime(): boolean {
  try {
    // Tauri v2 injects this on window
    const w = window as unknown as { __TAURI_INTERNALS__?: unknown; isTauri?: boolean };
    if (w.__TAURI_INTERNALS__) return true;
    if (typeof w.isTauri === 'boolean' && w.isTauri) return true;
  } catch {
    /* ignore */
  }
  // Fallback: user agent / protocol used by some embeds
  try {
    if (navigator.userAgent.includes('Tauri')) return true;
  } catch {
    /* ignore */
  }
  return false;
}
