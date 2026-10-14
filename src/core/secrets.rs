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
        let raw: [(&str, &str); 8] = [
            (
                r"-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\r\n]+[A-Za-z0-9+/=:, \t\r\n-]+?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|\z)",
                "[REDACTED: PRIVATE_KEY]",
            ),
            (r"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b", "[REDACTED: AWS_ACCESS_KEY]"),
            (r"\bsk-[A-Za-z0-9_-]{20,}", "[REDACTED: OPENAI_API_KEY]"),
            (r"\bgh[pousr]_[A-Za-z0-9]{36,}\b", "[REDACTED: GITHUB_TOKEN]"),
            (r"\bgithub_pat_[A-Za-z0-9_]{22,}\b", "[REDACTED: GITHUB_TOKEN]"),
            (r"\bxox[abposr]-[A-Za-z0-9-]{10,}", "[REDACTED: SLACK_TOKEN]"),
            // Connection strings: `Password=x` as a `;`, brace, comma or whitespace delimited pair.
            // Requires `=` directly after the key, so `password = hash(raw)` in code is left alone.
            // The first value char cannot be `=` (protects `password==expected`), and the value
            // also ends at backtick, `)`, `&` or `}` so Markdown and call syntax survive.
            // `[` is excluded from the first char so `[REDACTED: ...]` stays idempotent.
            (
                r"(?i)((?:^|[\s;{,])(?:password|pwd)=)[^=;\s\x22'<>`)&}\[][^;\s\x22'<>`)&}]*",
                "${1}[REDACTED: PASSWORD]",
            ),
            // .env / shell style: an UPPER_CASE `*_PASSWORD=` or `*_PWD=` assignment at line start.
            (
                r"(?m)^((?:export[ \t]+)?[A-Z][A-Z0-9_]*(?:PASSWORD|PWD)=)[^=;\s\x22'<>`)&}\[][^;\s\x22'<>`)&}]*",
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
        // Split literals so packing this repo with ptt keeps its own tests readable.
        let aws = concat!("AK", "IAIOSFODNN7EXAMPLE");
        let openai = concat!("sk-", "abcdefghijklmnopqrstuvwx");
        let github = concat!("ghp_", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
        let slack = concat!("xoxb-", "1234567890-abcdefghij");
        let text = format!("aws = {aws}\nopenai = {openai}\ngithub = {github}\nslack = {slack}\n");
        let redacted = redact_secrets(&text);
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
        assert!(!redacted.contains(concat!("AK", "IAIOSFODNN7EXAMPLE")));
        assert!(!redacted.contains(concat!("ghp_", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")));
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
            (
                format!("x;{pwd2})"),
                "x;pwd=[REDACTED: PASSWORD])",
            ),
            (
                format!("Server=db;{pwd}&Encrypt=True"),
                "Server=db;Password=[REDACTED: PASSWORD]&Encrypt=True",
            ),
            (
                format!("{{ {pwd}}}"),
                "{ Password=[REDACTED: PASSWORD]}",
            ),
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
    fn leaves_ordinary_code_borrowed_and_unchanged() {
        let text = "let task = skip_list;\npassword_hint = \"use a manager\";\nlet key = sk;\n";
        let redacted = redact_secrets(text);
        assert!(matches!(redacted, Cow::Borrowed(_)));
        assert_eq!(redacted, text);
    }
}
