/**
 * Browser-mode port of `src/core/secrets.rs`. Keep the rule list in sync with the Rust file:
 * both implementations are checked against the same fixtures in `ui/e2e/secrets.spec.ts`
 * and `tests/phase1_regressions.rs`.
 *
 * Best-effort safety net: it masks recognizable credential shapes only.
 */

export interface RedactionSummary {
  totalRedactions: number;
  kinds: [string, number][];
  redactionEnabled?: boolean;
  filesScanned?: number;
  filesSkipped?: number;
}

interface SecretRule {
  kind: string;
  pattern: RegExp;
  replacement: string;
  /** When true, the captured value (group 2) is skipped if it is a documented placeholder. */
  placeholderAware?: boolean;
  /** When true, the captured value (group 2) must be >= 32 chars and have Shannon entropy > 4.5 bits/char. */
  highEntropy?: boolean;
}

export function shannonEntropy(s: string): number {
  if (!s) return 0;
  const bytes = new TextEncoder().encode(s);
  if (bytes.length === 0) return 0;
  const freq = new Uint32Array(256);
  for (let i = 0; i < bytes.length; i++) {
    freq[bytes[i]] += 1;
  }
  const len = bytes.length;
  let h = 0;
  for (let i = 0; i < 256; i++) {
    const count = freq[i];
    if (count > 0) {
      const p = count / len;
      h -= p * Math.log2(p);
    }
  }
  return h;
}

// Global flag so `String.prototype.replace` replaces every occurrence.
const SECRET_RULES: readonly SecretRule[] = [
  {
    kind: 'PRIVATE_KEY',
    pattern:
      /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\r\n]+[A-Za-z0-9+/=:, \t\r\n-]+?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g,
    replacement: '[REDACTED: PRIVATE_KEY]',
  },
  {
    kind: 'AWS_ACCESS_KEY',
    pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
    replacement: '[REDACTED: AWS_ACCESS_KEY]',
  },
  {
    kind: 'ANTHROPIC_API_KEY',
    pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g,
    replacement: '[REDACTED: ANTHROPIC_API_KEY]',
  },
  {
    kind: 'OPENAI_API_KEY',
    pattern: /\bsk-[A-Za-z0-9_-]{20,}/g,
    replacement: '[REDACTED: OPENAI_API_KEY]',
  },
  {
    kind: 'GOOGLE_API_KEY',
    pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g,
    replacement: '[REDACTED: GOOGLE_API_KEY]',
  },
  {
    kind: 'STRIPE_KEY',
    pattern: /\b(?:sk|rk)_(?:live|test)_[0-9A-Za-z]{20,}\b/g,
    replacement: '[REDACTED: STRIPE_KEY]',
  },
  {
    kind: 'GITHUB_TOKEN',
    pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g,
    replacement: '[REDACTED: GITHUB_TOKEN]',
  },
  {
    kind: 'GITHUB_TOKEN',
    pattern: /\bgithub_pat_[A-Za-z0-9_]{22,}\b/g,
    replacement: '[REDACTED: GITHUB_TOKEN]',
  },
  {
    kind: 'SLACK_TOKEN',
    pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g,
    replacement: '[REDACTED: SLACK_TOKEN]',
  },
  {
    kind: 'GITLAB_TOKEN',
    pattern: /\bglpat-[0-9A-Za-z_-]{20,}\b/g,
    replacement: '[REDACTED: GITLAB_TOKEN]',
  },
  {
    kind: 'HUGGINGFACE_TOKEN',
    pattern: /\bhf_[A-Za-z0-9]{34,}\b/g,
    replacement: '[REDACTED: HUGGINGFACE_TOKEN]',
  },
  {
    kind: 'NPM_TOKEN',
    pattern: /\bnpm_[A-Za-z0-9]{36}\b/g,
    replacement: '[REDACTED: NPM_TOKEN]',
  },
  {
    // Three base64url segments, the first two starting with `eyJ` (JSON `{"`).
    kind: 'JWT_TOKEN',
    pattern: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
    replacement: '[REDACTED: JWT_TOKEN]',
  },
  {
    kind: 'URL_PASSWORD',
    pattern: /([a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/\s:@]+:)[^@\s"'`[][^@\s"'`]*(@)/g,
    replacement: '$1[REDACTED: URL_PASSWORD]$2',
  },
  {
    kind: 'PASSWORD',
    pattern: /((?:^|[\s;{,])(?:password|pwd)=)([^=;\s"'<>`)&}[][^;\s"'<>`)&}]*)/gi,
    replacement: '$1[REDACTED: PASSWORD]',
    placeholderAware: true,
  },
  {
    kind: 'PASSWORD',
    pattern: /^((?:export[ \t]+)?[A-Z][A-Z0-9_]*(?:PASSWORD|PWD)=)([^=;\s"'<>`)&}[][^\s"'<>`)&};]*)/gm,
    replacement: '$1[REDACTED: PASSWORD]',
    placeholderAware: true,
  },
  {
    kind: 'ENV_SECRET',
    pattern: /^((?:export[ \t]+)?[A-Z][A-Z0-9_]*_(?:SECRET|TOKEN|API_KEY|PRIVATE_KEY)=)([^\r\n#;]+)/gm,
    replacement: '$1[REDACTED: ENV_SECRET]',
    placeholderAware: true,
  },
  {
    kind: 'AZURE_KEY',
    pattern: /(AccountKey=)[A-Za-z0-9+/=]{40,}/gi,
    replacement: '$1[REDACTED: AZURE_KEY]',
  },
  {
    kind: 'SENDGRID_KEY',
    pattern: /\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}\b/g,
    replacement: '[REDACTED: SENDGRID_KEY]',
  },
  {
    kind: 'DISCORD_TOKEN',
    pattern: /\b[MN][A-Za-z0-9]{23,25}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,38}\b/g,
    replacement: '[REDACTED: DISCORD_TOKEN]',
  },
  {
    kind: 'HIGH_ENTROPY_SECRET',
    pattern:
      /((?:^|[\s,;{(])(?:[a-zA-Z0-9_'"-]*?(?:key|auth|cred|bearer|cert)[a-zA-Z0-9_'"-]*)\s*[:=]\s*["']?)([^"'\s;,\r\n]{32,})(["']?)/gi,
    replacement: '[REDACTED: HIGH_ENTROPY_SECRET]',
    highEntropy: true,
  },
];

function isEnvPlaceholder(rawVal: string): boolean {
  const trimmed = rawVal.trim();
  if (!trimmed) return true;
  let unquoted = trimmed;
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2)
  ) {
    unquoted = trimmed.slice(1, -1).trim();
  }
  // Documentation placeholders such as `...`, `***` or `---` are never real credentials.
  if (!unquoted || /^[.*_-]+$/.test(unquoted)) return true;
  if (
    unquoted.startsWith('[REDACTED:') ||
    unquoted.startsWith('$') ||
    (unquoted.startsWith('<') && unquoted.endsWith('>'))
  ) {
    return true;
  }
  const lower = unquoted.toLowerCase();
  if (
    lower === 'null' ||
    lower === 'none' ||
    lower === 'false' ||
    lower === 'true' ||
    lower === 'todo' ||
    lower === 'changeme' ||
    lower === 'xxx' ||
    lower === 'example'
  ) {
    return true;
  }
  return (
    lower.startsWith('your_') ||
    lower.startsWith('your-') ||
    lower.startsWith('replace_')
  );
}

export function redactSecretsWithReport(text: string): {
  text: string;
  summary: RedactionSummary;
} {
  let out = text;
  let totalRedactions = 0;
  const kindCounts = new Map<string, number>();

  const record = (kind: string, count: number) => {
    if (count <= 0) return;
    totalRedactions += count;
    kindCounts.set(kind, (kindCounts.get(kind) ?? 0) + count);
  };

  for (const rule of SECRET_RULES) {
    if (rule.placeholderAware) {
      let count = 0;
      out = out.replace(rule.pattern, (full, prefix: string, val: string) => {
        if (isEnvPlaceholder(val)) return full;
        count += 1;
        return `${prefix}[REDACTED: ${rule.kind}]`;
      });
      record(rule.kind, count);
    } else if (rule.highEntropy) {
      let count = 0;
      out = out.replace(
        rule.pattern,
        (full, prefix: string, val: string, suffix?: string) => {
          if (isEnvPlaceholder(val) || val.length < 32 || shannonEntropy(val) <= 4.5) {
            return full;
          }
          count += 1;
          return `${prefix}[REDACTED: ${rule.kind}]${suffix ?? ''}`;
        },
      );
      record(rule.kind, count);
    } else {
      const matches = out.match(rule.pattern);
      if (matches && matches.length > 0) {
        out = out.replace(rule.pattern, rule.replacement);
        record(rule.kind, matches.length);
      }
    }
  }

  return {
    text: out,
    summary: {
      totalRedactions,
      kinds: Array.from(kindCounts.entries()),
    },
  };
}

/** Returns `text` with every recognized credential replaced by `[REDACTED: <KIND>]`. */
export function redactSecrets(text: string): string {
  return redactSecretsWithReport(text).text;
}
