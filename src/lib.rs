//! # ptt — ProjectToText core
//!
//! Pure, UI-independent engine used by the Tauri desktop app:
//! - [`core::walker`] — git-aware project scanning (`.gitignore` + `.pttignore`)
//! - [`core::output`] — LLM-ready packing (XML / Markdown / JSON / plain)
//! - [`core::preview`] — safe in-app file preview (path sandbox + language guess)
//!
//! The binary (`src/main.rs`) wires these modules into Tauri commands and the UI.

#![forbid(unsafe_code)]

pub mod core;

pub use core::output::{write_output, OutputFormat, WriteOptions, DEFAULT_MAX_FILE_SIZE};
pub use core::preview::{
    guess_language, load_preview, resolve_under_root, FilePreview, DEFAULT_PREVIEW_MAX,
};
pub use core::walker::{normalize_rel_path, path_is_selected, walk, DirEntryMeta};
