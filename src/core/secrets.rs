//! Masks common credentials before file content is packed for an LLM.
//!
//! Patterns are deliberately specific (provider token prefixes, PEM armor and
//! .NET-style `Password=` pairs) so ordinary code is left untouched. This is a
//! best-effort safety net, not a guarantee: it cannot find secrets that have no
//! recognizable shape.

use regex::{Captures, Regex};
use serde::{Deserialize, Serialize};
use std::borrow::Cow;
use std::collections::BTreeMap;
use std::sync::OnceLock;

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RedactionSummary {
    pub total_redactions: usize,
    pub kinds: Vec<(String, usize)>,
}

impl RedactionSummary {
    pub fn merge(&mut self, other: &RedactionSummary) {
        if other.total_redactions == 0 {
            return;
        }
        self.total_redactions += other.total_redactions;
        let mut map: BTreeMap<String, usize> = self.kinds.drain(..).collect();
        for (k, v) in &other.kinds {
            *map.entry(k.clone()).or_insert(0) += *v;
        }
        self.kinds = map.into_iter().collect();
    }

    fn record(&mut self, kind: &str, count: usize) {
        if count == 0 {
            return;
        }
        self.total_redactions += count;
        if let Some(entry) = self.kinds.iter_mut().find(|(k, _)| k == kind) {
            entry.1 += count;
        } else {
            self.kinds.push((kind.to_string(), count));
        }
    }
}

struct Rule {
    kind: &'static str,
    pattern: Regex,
    replacement: &'static str,
    /// When true, the captured value (group 2) is skipped if it is a documented placeholder.
    placeholder_aware: bool,
}

fn rules() -> &'static [Rule] {
    static RULES: OnceLock<Vec<Rule>> = OnceLock::new();
    RULES.get_or_init(|| {
        let raw: [(&str, &str, &str, bool); 13] = [
            (
                "PRIVATE_KEY",
                r"-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\r\n]+[A-Za-z0-9+/=:, \t\r\n-]+?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|\z)",
                "[REDACTED: PRIVATE_KEY]",
                false,
            ),
            (
                "AWS_ACCESS_KEY",
                r"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b",
                "[REDACTED: AWS_ACCESS_KEY]",
                false,
            ),
            // Anthropic must run before generic sk- OpenAI rule
            (
                "ANTHROPIC_API_KEY",
                r"\bsk-ant-[A-Za-z0-9_-]{20,}\b",
                "[REDACTED: ANTHROPIC_API_KEY]",
                false,
            ),
            (
                "OPENAI_API_KEY",
                r"\bsk-[A-Za-z0-9_-]{20,}",
                "[REDACTED: OPENAI_API_KEY]",
                false,
            ),
            (
                "GOOGLE_API_KEY",
                r"\bAIza[0-9A-Za-z_-]{35}\b",
                "[REDACTED: GOOGLE_API_KEY]",
                false,
            ),
            (
                "STRIPE_KEY",
                r"\b(?:sk|rk)_(?:live|test)_[0-9A-Za-z]{20,}\b",
                "[REDACTED: STRIPE_KEY]",
                false,
            ),
            (
                "GITHUB_TOKEN",
                r"\bgh[pousr]_[A-Za-z0-9]{36,}\b",
                "[REDACTED: GITHUB_TOKEN]",
                false,
            ),
            (
                "GITHUB_TOKEN",
                r"\bgithub_pat_[A-Za-z0-9_]{22,}\b",
                "[REDACTED: GITHUB_TOKEN]",
                false,
            ),
            (
                "SLACK_TOKEN",
                r"\bxox[abposr]-[A-Za-z0-9-]{10,}",
                "[REDACTED: SLACK_TOKEN]",
                false,
            ),
            // URL basic-auth credentials: scheme `://` user `:` password `@` host
            (
                "URL_PASSWORD",
                r"([a-zA-Z][a-zA-Z0-9+.-]*://[^/\s:@]+:)[^@\s\x22'`\[][^@\s\x22'`]*(@)",
                "${1}[REDACTED: URL_PASSWORD]${2}",
                false,
            ),
            // Connection strings: `Password=x` as a `;`, brace, comma or whitespace delimited pair.
            // Requires `=` directly after the key, so `password = hash(raw)` in code is left alone.
            // The first value char cannot be `=` (protects `password==expected`), and the value
            // also ends at backtick, `)`, `&` or `}` so Markdown and call syntax survive.
            // `[` is excluded from the first char so `[REDACTED: ...]` stays idempotent.
            (
                "PASSWORD",
                r"(?i)((?:^|[\s;{,])(?:password|pwd)=)([^=;\s\x22'<>`)&}\[][^;\s\x22'<>`)&}]*)",
                "${1}[REDACTED: PASSWORD]",
                true,
            ),
            // .env / shell style: an UPPER_CASE `*_PASSWORD=` or `*_PWD=` assignment at line start.
            (
                "PASSWORD",
                r"(?m)^((?:export[ \t]+)?[A-Z][A-Z0-9_]*(?:PASSWORD|PWD)=)([^=;\s\x22'<>`)&}\[][^;\s\x22'<>`)&}]*)",
                "${1}[REDACTED: PASSWORD]",
                true,
            ),
            // Generic .env assignments for *_SECRET, *_TOKEN, *_API_KEY, *_PRIVATE_KEY at line start.
            (
                "ENV_SECRET",
                r"(?m)^((?:export[ \t]+)?[A-Z][A-Z0-9_]*_(?:SECRET|TOKEN|API_KEY|PRIVATE_KEY)=)([^\r\n#;]+)",
                "${1}[REDACTED: ENV_SECRET]",
                true,
            ),
        ];
        raw.iter()
            .map(|(kind, pattern, replacement, placeholder_aware)| Rule {
                kind,
                pattern: Regex::new(pattern).expect("secret pattern must be valid"),
                replacement,
                placeholder_aware: *placeholder_aware,
            })
            .collect()
    })
}

fn is_env_placeholder(raw_val: &str) -> bool {
    let trimmed = raw_val.trim();
    if trimmed.is_empty() {
        return true;
    }
    // Strip matching surrounding quotes
    let unquoted = if (trimmed.starts_with('"') && trimmed.ends_with('"') && trimmed.len() >= 2)
        || (trimmed.starts_with('\'') && trimmed.ends_with('\'') && trimmed.len() >= 2)
    {
        trimmed[1..trimmed.len() - 1].trim()
    } else {
        trimmed
    };
    // Documentation placeholders such as `...`, `***` or `---` are never real credentials.
    if unquoted.is_empty() || unquoted.chars().all(|c| matches!(c, '.' | '*' | '-' | '_')) {
        return true;
    }
    if unquoted.starts_with("[REDACTED:")
        || unquoted.starts_with('$')
        || (unquoted.starts_with('<') && unquoted.ends_with('>'))
    {
        return true;
    }
    let lower = unquoted.to_ascii_lowercase();
    matches!(
        lower.as_str(),
        "null" | "none" | "false" | "true" | "todo" | "changeme" | "xxx" | "example"
    ) || lower.starts_with("your_")
        || lower.starts_with("your-")
        || lower.starts_with("replace_")
}

/// Returns `text` with every recognized credential replaced by `[REDACTED: <KIND>]`,
/// along with a [`RedactionSummary`] detailing how many secrets were masked per kind.
pub fn redact_secrets_with_report(text: &str) -> (Cow<'_, str>, RedactionSummary) {
    let mut out = Cow::Borrowed(text);
    let mut summary = RedactionSummary::default();

    for rule in rules() {
        if !rule.pattern.is_match(&out) {
            continue;
        }
        if rule.placeholder_aware {
            let mut count = 0usize;
            let replaced = rule
                .pattern
                .replace_all(&out, |caps: &Captures<'_>| {
                    let prefix = &caps[1];
                    let val = &caps[2];
                    if is_env_placeholder(val) {
                        caps[0].to_string()
                    } else {
                        count += 1;
                        format!("{prefix}[REDACTED: {}]", rule.kind)
                    }
                })
                .into_owned();
            if count > 0 {
                out = Cow::Owned(replaced);
                summary.record(rule.kind, count);
            }
        } else {
            let count = rule.pattern.find_iter(&out).count();
            if count > 0 {
                let replaced = rule
                    .pattern
                    .replace_all(&out, rule.replacement)
                    .into_owned();
                out = Cow::Owned(replaced);
                summary.record(rule.kind, count);
            }
        }
    }

    (out, summary)
}

/// Returns `text` with every recognized credential replaced by `[REDACTED: <KIND>]`.
/// Borrows the input when nothing matches.
pub fn redact_secrets(text: &str) -> Cow<'_, str> {
    redact_secrets_with_report(text).0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn masks_provider_tokens() {
        // Split literals so packing this repo with ptt keeps its own tests readable.
        let aws = concat!("AK", "IAIOSFODNN7EXAMPLE");
        let anthropic = concat!("sk-ant-", "api03-abcdefghijklmnopqrstuvwx");
        let openai = concat!("sk-", "abcdefghijklmnopqrstuvwx");
        let google = concat!("AIza", "SyDaGmWKa4JsXZ-HjGw7x*********12345").replace('*', "A");
        let stripe = concat!("sk_live_", "51Habcdefghijklmnopqrstuvwx");
        let github = concat!("ghp_", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
        let slack = concat!("xoxb-", "1234567890-abcdefghij");
        let text = format!(
            "aws = {aws}\nanthropic = {anthropic}\nopenai = {openai}\ngoogle = {google}\nstripe = {stripe}\ngithub = {github}\nslack = {slack}\n"
        );
        let (redacted, report) = redact_secrets_with_report(&text);
        for kind in [
            "AWS_ACCESS_KEY",
            "ANTHROPIC_API_KEY",
            "OPENAI_API_KEY",
            "GOOGLE_API_KEY",
            "STRIPE_KEY",
            "GITHUB_TOKEN",
            "SLACK_TOKEN",
        ] {
            assert!(
                redacted.contains(&format!("[REDACTED: {kind}]")),
                "missing {kind} in {redacted}"
            );
        }
        assert_eq!(report.total_redactions, 7);
        assert!(!redacted.contains(concat!("AK", "IAIOSFODNN7EXAMPLE")));
        assert!(!redacted.contains(concat!("ghp_", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")));
    }

    #[test]
    fn masks_url_basic_auth_and_generic_env_secrets() {
        let url = concat!("postgres://admin:", "s3cr3tPass", "@db.internal:5432/app");
        let env_secret = concat!("JWT_SECRET=", "super-secret-jwt-signing-key-999");
        let env_token = concat!("API_TOKEN=", "\"my_real_token_value\"");
        let placeholder1 = concat!("EMPTY_SECRET=", "\"\"");
        let placeholder2 = concat!("EXAMPLE_API_KEY=", "your_api_key_here");
        let placeholder3 = concat!("NULL_TOKEN=", "null");
        let text = format!(
            "DATABASE_URL={url}\n{env_secret}\n{env_token}\n{placeholder1}\n{placeholder2}\n{placeholder3}\n"
        );
        let (redacted, report) = redact_secrets_with_report(&text);
        assert!(
            redacted.contains("postgres://admin:[REDACTED: URL_PASSWORD]@db.internal:5432/app"),
            "{redacted}"
        );
        assert!(
            redacted.contains("JWT_SECRET=[REDACTED: ENV_SECRET]"),
            "{redacted}"
        );
        assert!(
            redacted.contains("API_TOKEN=[REDACTED: ENV_SECRET]"),
            "{redacted}"
        );
        // Placeholders remain untouched
        assert!(redacted.contains(placeholder1), "{redacted}");
        assert!(redacted.contains(placeholder2), "{redacted}");
        assert!(redacted.contains(placeholder3), "{redacted}");
        assert_eq!(report.total_redactions, 3);
    }

    #[test]
    fn redaction_is_idempotent() {
        let pwd = concat!("Password=", "Sup3r");
        let url = concat!("https://user:", "pass123", "@example.com");
        let env_sec = concat!("APP_SECRET=", "topsecretvalue");
        let input = format!("Server=db;{pwd};\n{url}\n{env_sec}\n");
        let (once, report1) = redact_secrets_with_report(&input);
        let (twice, report2) = redact_secrets_with_report(&once);
        assert_eq!(once, twice);
        assert_eq!(report1.total_redactions, 3);
        assert_eq!(report2.total_redactions, 0);
    }

    #[test]
    fn masks_private_key_block_even_when_truncated() {
        // Split BEGIN/END markers so ptt packing this file does not redact its own tests.
        let begin_rsa = concat!("-----BEGIN RSA ", "PRIVATE KEY-----");
        let end_rsa = concat!("-----END RSA ", "PRIVATE KEY-----");
        let begin_plain = concat!("-----BEGIN ", "PRIVATE KEY-----");
        let text = format!("{begin_rsa}\nMIIEpAIBAAKCAQEA\n{end_rsa}\nafter\n");
        let redacted = redact_secrets(&text);
        assert_eq!(redacted, "[REDACTED: PRIVATE_KEY]\nafter\n");

        // With no END marker, key material up to end-of-file is still masked (fail closed),
        // but a `"` (e.g. a Rust string terminator) ends the block so source literals survive packing.
        let truncated = format!("{begin_plain}\nMIIEvQIBADANBg\n");
        assert_eq!(redact_secrets(&truncated), "[REDACTED: PRIVATE_KEY]");

        let quoted = format!("let k = \"{begin_plain}\\nMIIEvQIBADANBg\\n\";\nlet after = 1;\n");
        let redacted_quoted = redact_secrets(&quoted);
        assert!(
            redacted_quoted.contains("let after = 1;"),
            "quoted PEM literal must not eat the rest of the file: {redacted_quoted}"
        );
    }

    #[test]
    fn keeps_connection_string_structure() {
        let pwd = concat!("Password=", "Sup3r");
        let text = format!("Server=db;Database=app;User Id=sa;{pwd};Encrypt=True");
        assert_eq!(
            redact_secrets(&text),
            "Server=db;Database=app;User Id=sa;Password=[REDACTED: PASSWORD];Encrypt=True"
        );
    }

    #[test]
    fn masks_env_style_password_assignments() {
        let db = concat!("DB_PASSWORD=", "Sup3r");
        let api = concat!("API_PWD=", "hunter2");
        let text = format!("{db}\nexport {api}\nLOG_LEVEL=debug\n");
        assert_eq!(
            redact_secrets(&text),
            "DB_PASSWORD=[REDACTED: PASSWORD]\nexport API_PWD=[REDACTED: PASSWORD]\nLOG_LEVEL=debug\n"
        );
    }

    #[test]
    fn leaves_double_equals_comparison_unchanged() {
        for text in [
            "password==expected",
            " password==expected",
            "if (x; password==expected)",
            " pwd==hash",
            "DB_PASSWORD==debug",
        ] {
            let redacted = redact_secrets(text);
            assert!(matches!(redacted, Cow::Borrowed(_)), "{redacted}");
            assert_eq!(redacted, text);
        }
    }

    #[test]
    fn keeps_markdown_and_call_delimiters() {
        // Closing backtick, `)`, `&` and `}` end the value instead of being eaten.
        // Prefixes use `;`/space/`{` so the connection-string rule applies.
        let pwd = concat!("Password=", "secret");
        let pwd2 = concat!("pwd=", "hunter2");
        let cases = [
            (
                format!("`Server=db;{pwd}`"),
                "`Server=db;Password=[REDACTED: PASSWORD]`",
            ),
            (format!("x;{pwd2})"), "x;pwd=[REDACTED: PASSWORD])"),
            (
                format!("Server=db;{pwd}&Encrypt=True"),
                "Server=db;Password=[REDACTED: PASSWORD]&Encrypt=True",
            ),
            (format!("{{ {pwd}}}"), "{ Password=[REDACTED: PASSWORD]}"),
        ];
        for (input, expected) in cases {
            assert_eq!(redact_secrets(&input), expected, "{input}");
        }
    }

    #[test]
    fn leaves_ordinary_password_code_unchanged() {
        let text = "let password = hash_password(raw);\nuser.password = new_password;\nlet pwd = env::var(\"PWD\")?;\nconst DB_PASSWORD = getPw();\n";
        let redacted = redact_secrets(text);
        assert!(matches!(redacted, Cow::Borrowed(_)), "{redacted}");
    }

    #[test]
    fn keeps_documented_password_placeholders() {
        // Docs show these shapes without a real value; they must survive packing untouched.
        for text in [
            "`Password=...`",
            "`*_PASSWORD=...`",
            "DB_PASSWORD=...",
            "Server=db;Password=***;Encrypt=True",
            "Server=db;Password=<secret>;",
        ] {
            assert_eq!(redact_secrets(text), text, "{text}");
        }
        // A real value next to a placeholder is still masked.
        let real = concat!("DB_PASSWORD=", "Sup3r");
        assert_eq!(redact_secrets(real), "DB_PASSWORD=[REDACTED: PASSWORD]");
    }

    #[test]
    fn leaves_ordinary_code_borrowed_and_unchanged() {
        let text = "let task = skip_list;\npassword_hint = \"use a manager\";\nlet key = sk;\n";
        let redacted = redact_secrets(text);
        assert!(matches!(redacted, Cow::Borrowed(_)));
        assert_eq!(redacted, text);
    }
}
