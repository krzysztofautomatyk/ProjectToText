/**
 * Lightweight syntax highlighting (highlight.js core + common languages).
 * Language ids match backend `guess_language` in src/core/preview.rs.
 */
import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import c from 'highlight.js/lib/languages/c';
import cpp from 'highlight.js/lib/languages/cpp';
import csharp from 'highlight.js/lib/languages/csharp';
import css from 'highlight.js/lib/languages/css';
import dockerfile from 'highlight.js/lib/languages/dockerfile';
import fsharp from 'highlight.js/lib/languages/fsharp';
import go from 'highlight.js/lib/languages/go';
import ini from 'highlight.js/lib/languages/ini';
import java from 'highlight.js/lib/languages/java';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import kotlin from 'highlight.js/lib/languages/kotlin';
import less from 'highlight.js/lib/languages/less';
import lua from 'highlight.js/lib/languages/lua';
import makefile from 'highlight.js/lib/languages/makefile';
import markdown from 'highlight.js/lib/languages/markdown';
import php from 'highlight.js/lib/languages/php';
import plaintext from 'highlight.js/lib/languages/plaintext';
import powershell from 'highlight.js/lib/languages/powershell';
import python from 'highlight.js/lib/languages/python';
import r from 'highlight.js/lib/languages/r';
import ruby from 'highlight.js/lib/languages/ruby';
import rust from 'highlight.js/lib/languages/rust';
import scss from 'highlight.js/lib/languages/scss';
import sql from 'highlight.js/lib/languages/sql';
import swift from 'highlight.js/lib/languages/swift';
import typescript from 'highlight.js/lib/languages/typescript';
import vbnet from 'highlight.js/lib/languages/vbnet';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';

let registered = false;

function ensureRegistered() {
  if (registered) return;
  const langs: Array<[string, typeof javascript]> = [
    ['bash', bash],
    ['c', c],
    ['cpp', cpp],
    ['csharp', csharp],
    ['css', css],
    ['dockerfile', dockerfile],
    ['fsharp', fsharp],
    ['go', go],
    ['ini', ini],
    ['java', java],
    ['javascript', javascript],
    ['json', json],
    ['kotlin', kotlin],
    ['less', less],
    ['lua', lua],
    ['makefile', makefile],
    ['markdown', markdown],
    ['php', php],
    ['plaintext', plaintext],
    ['powershell', powershell],
    ['python', python],
    ['r', r],
    ['ruby', ruby],
    ['rust', rust],
    ['scss', scss],
    ['sql', sql],
    ['swift', swift],
    ['typescript', typescript],
    ['vbnet', vbnet],
    ['xml', xml],
    ['yaml', yaml],
    // aliases used by backend
    ['toml', ini],
    ['gradle', java],
    ['dart', javascript],
  ];
  for (const [name, def] of langs) {
    try {
      hljs.registerLanguage(name, def);
    } catch {
      /* already registered */
    }
  }
  registered = true;
}

export function highlightCode(code: string, language: string): string {
  ensureRegistered();
  const lang = (language || 'plaintext').toLowerCase();
  try {
    if (hljs.getLanguage(lang)) {
      return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
    }
  } catch {
    /* fall through */
  }
  try {
    return hljs.highlightAuto(code).value;
  } catch {
    return escapeHtml(code);
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
