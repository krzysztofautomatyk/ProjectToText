//! # ptt — ProjectToText core
//!
//! Pure, UI-independent engine used by the Tauri desktop app:
//! - [`core::walker`] — git-aware project scanning (`.gitignore` + `.pttignore`)
//! - [`core::output`] — LLM-ready packing (XML / Markdown / JSON / plain)
//! - [`core::preview`] — safe in-app file preview (path sandbox + language guess)
//! - [`core::secrets`] — credential masking and redaction summary
//! - [`core::tokenizer`] — exact BPE token counting (`o200k_base` / `cl100k_base`)
//! - [`core::skeleton`] — Tree-sitter AST code compression ("Skeleton Mode")
//! - [`core::deps`] — intra-repo import & dependency graph resolver
//! - [`core::git`] — Git status, branch diff, and recent commit discovery
//!
//! The binary (`src/main.rs`) wires these modules into Tauri commands, CLI, and MCP.

#![forbid(unsafe_code)]

pub mod core;

pub use core::budget::{
    drop_priority_order_with_graph, fit_to_bpe_budget, fit_to_bpe_budget_with_graph,
    fit_to_bpe_budget_with_pins, fit_workspace_to_bpe_budget, prefit_by_estimate,
    prefit_by_estimate_with_graph,
};
pub use core::deps::{DependencyGraph, RelatedFiles};
pub use core::git::{compute_git_diff, inspect_git_context, GitRepoContext};
pub use core::output::{
    write_output, write_output_cancellable, write_output_with_stats, FilePackMode, FileTokenStat,
    OutputFormat, PackStats, PreparedWorkspace, PreparedWorkspaceFile, WriteOptions,
    DEFAULT_MAX_FILE_SIZE,
};
pub use core::preview::{
    guess_language, load_preview, resolve_under_root, FilePreview, DEFAULT_PREVIEW_MAX,
};
pub use core::secrets::{redact_secrets, redact_secrets_with_report, RedactionSummary};
pub use core::task_presets::{
    merge_prompt_and_preset, resolve_task_preset, task_preset_description, TASK_PRESET_IDS,
};
pub use core::skeleton::{extract_skeleton, language_for_path};
pub use core::tokenizer::{
    count_tokens, count_tokens_with_model, estimate_tokens_from_bytes, TokenizerModel,
};
pub use core::walker::{
    is_junk_dir_name, normalize_rel_path, path_is_selected, walk, DirEntryMeta, JUNK_DIRS,
};
