import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { I18nProvider } from './i18n'

/** Apply theme before first paint to avoid flash (GitHub-style light/dark/system). */
const THEME_KEY = 'ptt.theme'
type ThemePref = 'light' | 'dark' | 'system'

function resolveTheme(pref: ThemePref): 'light' | 'dark' {
  if (pref === 'system') {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  }
  return pref
}

function readThemePref(): ThemePref {
  try {
    const raw = localStorage.getItem(THEME_KEY)
    if (raw === 'light' || raw === 'dark' || raw === 'system') return raw
  } catch {
    /* ignore */
  }
  return 'system'
}

const pref = readThemePref()
const resolved = resolveTheme(pref)
document.documentElement.setAttribute('data-theme', resolved)
document.documentElement.setAttribute('data-theme-pref', pref)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <I18nProvider>
      <App />
    </I18nProvider>
  </StrictMode>,
)
