/**
 * Browser-mode port of `src/core/secrets.rs`. Keep the rule list in sync with the Rust file:
 * both implementations are checked against the same fixtures in `ui/e2e/secrets.spec.ts`
 * and `tests/phase1_regressions.rs`.
 *
 * Best-effort safety net: it masks recognizable credential shapes only.
 */

interface SecretRule {
  pattern: RegExp;
  replacement: string;
}

// Global flag so `String.prototype.replace` replaces every occurrence.
const SECRET_RULES: readonly SecretRule[] = [
  {
    pattern:
      /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\r\n]+[A-Za-z0-9+/=:, \t\r\n-]+?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g,
    replacement: '[REDACTED: PRIVATE_KEY]',
  },
  { pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, replacement: '[REDACTED: AWS_ACCESS_KEY]' },
  { pattern: /\bsk-[A-Za-z0-9_-]{20,}/g, replacement: '[REDACTED: OPENAI_API_KEY]' },
  { pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g, replacement: '[REDACTED: GITHUB_TOKEN]' },
  { pattern: /\bgithub_pat_[A-Za-z0-9_]{22,}\b/g, replacement: '[REDACTED: GITHUB_TOKEN]' },
  { pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g, replacement: '[REDACTED: SLACK_TOKEN]' },
  {
    pattern: /((?:^|[\s;{,])(?:password|pwd)=)[^=;\s"'<>`)&}[][^;\s"'<>`)&}]*/gi,
    replacement: '$1[REDACTED: PASSWORD]',
  },
  {
    pattern: /^((?:export[ \t]+)?[A-Z][A-Z0-9_]*(?:PASSWORD|PWD)=)[^=;\s"'<>`)&}[][^\s"'<>`)&};]*/gm,
    replacement: '$1[REDACTED: PASSWORD]',
  },
];

/** Returns `text` with every recognized credential replaced by `[REDACTED: <KIND>]`. */
export function redactSecrets(text: string): string {
  let out = text;
  for (const rule of SECRET_RULES) {
    out = out.replace(rule.pattern, rule.replacement);
  }
  return out;
}
