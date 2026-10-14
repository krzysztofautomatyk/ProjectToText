/**
 * Platform detection and shortcut formatting.
 *
 * Single source of truth for "Cmd on macOS, Ctrl elsewhere" so labels in
 * JSX/tooltips can never drift from the keydown handler. Detection prefers
 * `navigator.userAgentData.platform` (Chromium/WebView2), then `userAgent`,
 * then the deprecated `navigator.platform` as a last resort.
 */

export function isMacOS(): boolean {
  if (typeof navigator === 'undefined') return false;
  try {
    const uaData = (
      navigator as Navigator & { userAgentData?: { platform?: string } }
    ).userAgentData;
    if (uaData?.platform) {
      return uaData.platform.toLowerCase().includes('mac');
    }
  } catch {
    /* ignore and fall through */
  }
  try {
    const ua = navigator.userAgent || '';
    if (/mac|iphone|ipad|ipod/i.test(ua)) return true;
    if (/windows|linux|android|cros/i.test(ua)) return false;
  } catch {
    /* ignore and fall through */
  }
  try {
    const legacy = (navigator as Navigator & { platform?: string }).platform || '';
    if (legacy) return /mac|iphone|ipad|ipod/i.test(legacy);
  } catch {
    /* ignore */
  }
  return false;
}

export const IS_MAC = isMacOS();

/** "⌘" on macOS, "Ctrl" on Windows/Linux — for prose, prefer formatShortcut(). */
export const MOD_KEY_LABEL = IS_MAC ? '⌘' : 'Ctrl';

/** "⌘O" on macOS, "Ctrl+O" elsewhere. */
export function formatShortcut(key: string): string {
  const k = key.length === 1 ? key.toUpperCase() : key;
  return IS_MAC ? `⌘${k}` : `Ctrl+${k}`;
}

/**
 * True when the platform modifier is held. Accepts both Cmd and Ctrl on
 * either platform so shortcuts keep working even if detection is wrong
 * (e.g. exotic WebView UA) or the user remaps keys.
 */
export function isModKey(e: KeyboardEvent | { metaKey: boolean; ctrlKey: boolean }): boolean {
  return !!(e.metaKey || e.ctrlKey);
}
