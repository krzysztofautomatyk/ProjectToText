//! Masks common credentials before file content is packed for an LLM.
//!
//! Patterns are deliberately specific (provider token prefixes, PEM armor and
//! .NET-style `Password=` pairs) so ordinary code is left untouched. This is a
//! best-effort safety net, not a guarantee: it cannot find secrets that have no
//! recognizable shape.

use regex::Regex;
use std::borrow::Cow;
use std::sync::OnceLock;

struct Rule {
    pattern: Regex,
    replacement: &'static str,
}

fn rules() -> &'static [Rule] {
    static RULES: OnceLock<Vec<Rule>> = OnceLock::new();
    RULES.get_or_init(|| {
        let raw: [(&str, &str); 7] = [
            (
                r"(?s)-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----.*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|\z)",
                "[REDACTED: PRIVATE_KEY]",
            ),
            (r"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b", "[REDACTED: AWS_ACCESS_KEY]"),
            (r"\bsk-[A-Za-z0-9_-]{20,}", "[REDACTED: OPENAI_API_KEY]"),
            (r"\bgh[pousr]_[A-Za-z0-9]{36,}\b", "[REDACTED: GITHUB_TOKEN]"),
            (r"\bgithub_pat_[A-Za-z0-9_]{22,}\b", "[REDACTED: GITHUB_TOKEN]"),
            (r"\bxox[abposr]-[A-Za-z0-9-]{10,}", "[REDACTED: SLACK_TOKEN]"),
            // Keeps the `Password=` key and the following `;` so connection strings stay readable.
            (
                r"(?i)((?:password|pwd)\s*=\s*)[^;\s\x22'<>]+",
                "${1}[REDACTED: PASSWORD]",
            ),
        ];
        raw.iter()
            .map(|(pattern, replacement)| Rule {
                pattern: Regex::new(pattern).expect("secret pattern must be valid"),
                replacement,
            })
            .collect()
    })
}

/// Returns `text` with every recognized credential replaced by `[REDACTED: <KIND>]`.
/// Borrows the input when nothing matches.
pub fn redact_secrets(text: &str) -> Cow<'_, str> {
    let mut out = Cow::Borrowed(text);
    for rule in rules() {
        if rule.pattern.is_match(&out) {
            let replaced = rule
                .pattern
                .replace_all(&out, rule.replacement)
                .into_owned();
            out = Cow::Owned(replaced);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn masks_provider_tokens() {
        let text = "aws = AKIAIOSFODNN7EXAMPLE\n\
                    openai = sk-abcdefghijklmnopqrstuvwx\n\
                    github = ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n\
                    slack = xoxb-1234567890-abcdefghij\n";
        let redacted = redact_secrets(text);
        for kind in [
            "AWS_ACCESS_KEY",
            "OPENAI_API_KEY",
            "GITHUB_TOKEN",
            "SLACK_TOKEN",
        ] {
            assert!(
                redacted.contains(&format!("[REDACTED: {kind}]")),
                "{redacted}"
            );
        }
        assert!(!redacted.contains("AKIAIOSFODNN7EXAMPLE"));
        assert!(!redacted.contains("ghp_aaaa"));
    }

    #[test]
    fn masks_private_key_block_even_when_truncated() {
        let text = "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA\n-----END RSA PRIVATE KEY-----\nafter\n";
        let redacted = redact_secrets(text);
        assert_eq!(redacted, "[REDACTED: PRIVATE_KEY]\nafter\n");

        // With no END marker, everything after BEGIN is treated as key material (fail closed).
        let truncated = "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBg\n";
        assert_eq!(redact_secrets(truncated), "[REDACTED: PRIVATE_KEY]");
    }

    #[test]
    fn keeps_connection_string_structure() {
        let text = "Server=db;Database=app;User Id=sa;Password=Sup3r;Encrypt=True";
        assert_eq!(
            redact_secrets(text),
            "Server=db;Database=app;User Id=sa;Password=[REDACTED: PASSWORD];Encrypt=True"
        );
    }

    #[test]
    fn leaves_ordinary_code_borrowed_and_unchanged() {
        let text = "let task = skip_list;\npassword_hint = \"use a manager\";\nlet key = sk;\n";
        let redacted = redact_secrets(text);
        assert!(matches!(redacted, Cow::Borrowed(_)));
        assert_eq!(redacted, text);
    }
}
