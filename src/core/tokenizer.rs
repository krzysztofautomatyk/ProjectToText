//! Exact BPE tokenization and context budget calculations.
//!
//! Uses `tiktoken-rs` (`o200k_base` for modern OpenAI GPT-4o / o3 / GPT-5 models
//! and `cl100k_base` as the classic code baseline), plus calibrated multipliers
//! for Claude and Gemini profiles.

use serde::{Deserialize, Serialize};
use std::sync::OnceLock;
use tiktoken_rs::CoreBPE;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TokenizerModel {
    #[default]
    O200kBase,
    Cl100kBase,
    Claude,
    Gemini,
}

impl TokenizerModel {
    pub fn parse(s: &str) -> Self {
        match s.trim().to_ascii_lowercase().as_str() {
            "cl100k" | "cl100k_base" | "gpt-4" => Self::Cl100kBase,
            "claude" | "anthropic" | "sonnet" | "opus" => Self::Claude,
            "gemini" | "google" => Self::Gemini,
            _ => Self::O200kBase,
        }
    }

    pub fn try_parse(s: &str) -> Result<Self, String> {
        match s.trim().to_ascii_lowercase().as_str() {
            "o200k" | "o200k_base" | "gpt-4o" | "gpt-5" | "o3" => Ok(Self::O200kBase),
            "cl100k" | "cl100k_base" | "gpt-4" => Ok(Self::Cl100kBase),
            "claude" | "anthropic" | "sonnet" | "opus" => Ok(Self::Claude),
            "gemini" | "google" => Ok(Self::Gemini),
            other => Err(format!(
                "unknown tokenizer '{other}' (use o200k_base|cl100k_base|claude|gemini)"
            )),
        }
    }

    /// True only when this profile uses an exact BPE vocabulary (`o200k_base` or `cl100k_base`).
    /// `Claude` and `Gemini` are scaled approximations of `o200k_base`.
    pub fn is_exact_bpe(self) -> bool {
        matches!(self, Self::O200kBase | Self::Cl100kBase)
    }

    pub fn label(self) -> &'static str {
        match self {
            Self::O200kBase => "o200k_base",
            Self::Cl100kBase => "cl100k_base",
            Self::Claude => "claude (~approx 1.04x o200k_base)",
            Self::Gemini => "gemini (~approx 0.96x o200k_base)",
        }
    }
}

fn o200k() -> &'static CoreBPE {
    static BPE: OnceLock<CoreBPE> = OnceLock::new();
    BPE.get_or_init(|| tiktoken_rs::o200k_base().expect("o200k_base BPE must initialize"))
}

fn cl100k() -> &'static CoreBPE {
    static BPE: OnceLock<CoreBPE> = OnceLock::new();
    BPE.get_or_init(|| tiktoken_rs::cl100k_base().expect("cl100k_base BPE must initialize"))
}

/// Counts tokens for `text` using the default `o200k_base` BPE tokenizer.
pub fn count_tokens(text: &str) -> usize {
    count_tokens_with_model(text, TokenizerModel::O200kBase)
}

/// Counts tokens for `text` using the specified [`TokenizerModel`].
pub fn count_tokens_with_model(text: &str, model: TokenizerModel) -> usize {
    if text.is_empty() {
        return 0;
    }
    match model {
        TokenizerModel::O200kBase => o200k().encode_ordinary(text).len(),
        TokenizerModel::Cl100kBase => cl100k().encode_ordinary(text).len(),
        TokenizerModel::Claude => {
            // Claude 3.5/3.7/4 tokenizer is slightly denser on punctuation/identifiers than cl100k (~1.04x o200k)
            let base = o200k().encode_ordinary(text).len();
            ((base as f64) * 1.04).round() as usize
        }
        TokenizerModel::Gemini => {
            // Gemini SentencePiece tokenizer averages ~0.96x o200k on source code
            let base = o200k().encode_ordinary(text).len();
            ((base as f64) * 0.96).round() as usize
        }
    }
}

/// Fast byte-size fallback estimate when file content hasn't been read yet.
pub fn estimate_tokens_from_bytes(bytes: u64) -> usize {
    ((bytes as f64) / 3.8).round() as usize
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bpe_counts_non_empty_code_accurately() {
        let code = "pub fn add(a: i32, b: i32) -> i32 {\n    a + b\n}\n";
        let o200k_count = count_tokens_with_model(code, TokenizerModel::O200kBase);
        let cl100k_count = count_tokens_with_model(code, TokenizerModel::Cl100kBase);
        let claude_count = count_tokens_with_model(code, TokenizerModel::Claude);
        let gemini_count = count_tokens_with_model(code, TokenizerModel::Gemini);

        assert!(o200k_count > 10 && o200k_count < 30, "o200k={o200k_count}");
        assert!(
            cl100k_count > 10 && cl100k_count < 30,
            "cl100k={cl100k_count}"
        );
        assert!(claude_count >= o200k_count);
        assert!(gemini_count <= o200k_count);
        assert_eq!(count_tokens(""), 0);
    }
}
