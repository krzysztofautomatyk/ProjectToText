//! High-quality output generation (XML is the primary recommended format for LLMs).
//!
//! Follows repomix / Anthropic best practices for XML-tagged context, including:
//! - Parallel file reading, UTF-8/UTF-16 decoding, secret redaction, AST skeletonizing,
//!   and exact BPE tokenization via `rayon`
//! - Directory-level canonical root cache so `resolve_under_canonical_root` only checks
//!   unique parent directories once
//! - Optional `<git_diff>` block and Anthropic-optimal `<task_instructions>` placement
//!   at the end of the prompt.

use std::collections::{HashMap, HashSet};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::core::preview::{is_link, open_verified_regular_file, resolve_under_canonical_root};
use crate::core::secrets::{redact_secrets_with_report, RedactionSummary};
use crate::core::skeleton::{extract_skeleton, language_for_path};
use crate::core::text::{decode_text, markdown_fence, TextError};
use crate::core::tokenizer::{count_tokens_with_model, TokenizerModel};
use crate::core::walker::{normalize_rel_path, DirEntryMeta};

/// Default per-file size limit when the caller does not specify one.
pub const DEFAULT_MAX_FILE_SIZE: u64 = 2 * 1024 * 1024; // 2 MiB

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum OutputFormat {
    #[default]
    Xml,
    Markdown,
    Json,
    Plain,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FilePackMode {
    #[default]
    Full,
    Skeleton,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileTokenStat {
    pub path: String,
    pub bytes: usize,
    pub tokens: usize,
    pub mode: FilePackMode,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackStats {
    pub files_packed: usize,
    /// Exact (or model-profiled) token count of the complete serialized output artifact,
    /// including all XML/Markdown/JSON/Plain wrappers, directory tree, paths, diff, and prompt.
    pub total_tokens: usize,
    /// Sum of tokens across prepared file contents only (excluding wrapper overhead, diff, and prompt).
    pub content_tokens: usize,
    /// Tokens attributable to formatting wrappers, directory listing, git diff, and task prompt.
    pub overhead_tokens: usize,
    /// Whether `total_tokens` comes from an exact BPE vocabulary (`o200k_base` / `cl100k_base`)
    /// rather than an approximate multiplier profile (`claude` / `gemini`) or byte heuristic.
    pub tokenizer_exact: bool,
    pub file_tokens: Vec<FileTokenStat>,
    pub redactions: RedactionSummary,
}

/// Options for packing files into LLM-ready text.
#[derive(Clone, Debug)]
pub struct WriteOptions {
    pub format: OutputFormat,
    pub include_file_summary: bool,
    pub max_file_size: u64,
    pub redact_secrets: bool,
    pub skeleton_all: bool,
    pub skeleton_files: HashSet<String>,
    pub git_diff: Option<String>,
    pub task_prompt: Option<String>,
    pub tokenizer_model: TokenizerModel,
    pub compute_bpe_tokens: bool,
    pub modified_files: HashSet<String>,
}

impl Default for WriteOptions {
    fn default() -> Self {
        Self {
            format: OutputFormat::Xml,
            include_file_summary: true,
            max_file_size: DEFAULT_MAX_FILE_SIZE,
            redact_secrets: true,
            skeleton_all: false,
            skeleton_files: HashSet::new(),
            git_diff: None,
            task_prompt: None,
            tokenizer_model: TokenizerModel::O200kBase,
            compute_bpe_tokens: false,
            modified_files: HashSet::new(),
        }
    }
}

#[derive(Clone, Debug)]
pub struct PreparedWorkspaceFile {
    pub meta: DirEntryMeta,
    pub path: String,
    pub ext: String,
    pub size: Option<u64>,
    pub full_content: String,
    pub full_tokens: usize,
    pub skeleton_content: Option<String>,
    pub skeleton_tokens: Option<usize>,
    pub redactions: RedactionSummary,
    pub is_text_ok: bool,
    pub is_modified: bool,
}

#[derive(Clone, Debug)]
struct CachedRender {
    kept_paths: Vec<PathBuf>,
    skeleton_files: HashSet<String>,
    skeleton_all: bool,
    rendered: Vec<u8>,
    stats: PackStats,
}

#[derive(Clone, Debug)]
pub struct PreparedWorkspace {
    files: Vec<PreparedWorkspaceFile>,
    files_by_path: HashMap<String, usize>,
    root: PathBuf,
    options: WriteOptions,
    last_render: Arc<Mutex<Option<CachedRender>>>,
}

impl PreparedWorkspace {
    /// Reads, decodes, and redacts each file in `entries` exactly once. Precomputes full content,
    /// tokens, and skeleton content (for supported languages).
    pub fn prepare<F>(
        entries: &[DirEntryMeta],
        root: &Path,
        options: &WriteOptions,
        cancelled: &F,
    ) -> std::io::Result<Self>
    where
        F: Fn() -> bool + Sync,
    {
        Self::prepare_with_mode(entries, root, options, cancelled, false)
    }

    /// Precomputes skeletons for all supported files, used by the token budget fitting loop.
    pub fn prepare_for_budget<F>(
        entries: &[DirEntryMeta],
        root: &Path,
        options: &WriteOptions,
        cancelled: &F,
    ) -> std::io::Result<Self>
    where
        F: Fn() -> bool + Sync,
    {
        Self::prepare_with_mode(entries, root, options, cancelled, true)
    }

    /// Reads, decodes, and redacts each file once, optionally precomputing AST skeletons for all files.
    pub fn prepare_with_mode<F>(
        entries: &[DirEntryMeta],
        root: &Path,
        options: &WriteOptions,
        cancelled: &F,
        precompute_all_skeletons: bool,
    ) -> std::io::Result<Self>
    where
        F: Fn() -> bool + Sync,
    {
        let canonical_root = std::fs::canonicalize(root)?;
        let root = canonical_root.as_path();
        let file_metas: Vec<&DirEntryMeta> = entries.iter().filter(|e| !e.is_dir).collect();
        let valid_parents = build_valid_parent_cache(root, &file_metas);

        let prepare_one = |f: &DirEntryMeta| -> PreparedWorkspaceFile {
            let path_str = display_path(&f.path);
            let ext = f
                .path
                .extension()
                .and_then(|e| e.to_str())
                .unwrap_or("")
                .to_string();
            let is_modified = options.modified_files.contains(&path_str);

            let (full_content, redactions, is_text_ok) = read_and_redact_file(
                root,
                &f.path,
                &valid_parents,
                options.max_file_size,
                options.redact_secrets,
            );

            let (skeleton_content, skeleton_tokens) = if is_text_ok {
                let should_compute = precompute_all_skeletons
                    || options.skeleton_all
                    || options.skeleton_files.contains(&path_str);
                if should_compute {
                    let lang = language_for_path(&f.path);
                    if lang != "other" {
                        let skel = extract_skeleton(&full_content, lang);
                        let tok = if options.compute_bpe_tokens {
                            count_tokens_with_model(&skel, options.tokenizer_model)
                        } else {
                            ((skel.len() as f64) / 3.8).round() as usize
                        };
                        (Some(skel), Some(tok))
                    } else {
                        (None, None)
                    }
                } else {
                    (None, None)
                }
            } else {
                (None, None)
            };

            let full_tokens = if options.compute_bpe_tokens {
                count_tokens_with_model(&full_content, options.tokenizer_model)
            } else {
                ((full_content.len() as f64) / 3.8).round() as usize
            };

            PreparedWorkspaceFile {
                meta: (*f).clone(),
                path: path_str,
                ext,
                size: f.size,
                full_content,
                full_tokens,
                skeleton_content,
                skeleton_tokens,
                redactions,
                is_text_ok,
                is_modified,
            }
        };

        let prepared_files: Vec<PreparedWorkspaceFile> = if file_metas.len() < 16 {
            let mut out = Vec::with_capacity(file_metas.len());
            for f in file_metas {
                ensure_not_cancelled(cancelled)?;
                out.push(prepare_one(f));
            }
            out
        } else {
            file_metas
                .par_iter()
                .map(|f| {
                    if cancelled() {
                        return Err(std::io::Error::new(
                            std::io::ErrorKind::Interrupted,
                            "output superseded by a newer request",
                        ));
                    }
                    Ok(prepare_one(f))
                })
                .collect::<std::io::Result<Vec<_>>>()?
        };

        let mut files_by_path = HashMap::with_capacity(prepared_files.len());
        for (i, pf) in prepared_files.iter().enumerate() {
            files_by_path.insert(pf.path.clone(), i);
        }

        Ok(Self {
            files: prepared_files,
            files_by_path,
            root: canonical_root,
            options: options.clone(),
            last_render: Arc::new(Mutex::new(None)),
        })
    }

    pub fn files(&self) -> &[PreparedWorkspaceFile] {
        &self.files
    }

    pub fn file_by_path(&self, rel_path: &str) -> Option<&PreparedWorkspaceFile> {
        let norm = normalize_rel_path(Path::new(rel_path));
        self.files_by_path
            .get(&norm)
            .or_else(|| self.files_by_path.get(rel_path))
            .and_then(|&idx| self.files.get(idx))
    }

    pub fn render_with_stats<W: Write>(
        &self,
        writer: &mut W,
        kept_entries: &[DirEntryMeta],
        skeleton_files: &HashSet<String>,
        skeleton_all: bool,
    ) -> std::io::Result<PackStats> {
        let (rendered, stats) =
            self.render_in_memory(kept_entries, skeleton_files, skeleton_all)?;
        writer.write_all(&rendered)?;
        Ok(stats)
    }

    pub fn render_stats(
        &self,
        kept_entries: &[DirEntryMeta],
        skeleton_files: &HashSet<String>,
        skeleton_all: bool,
    ) -> std::io::Result<PackStats> {
        let (_rendered, stats) =
            self.render_in_memory(kept_entries, skeleton_files, skeleton_all)?;
        Ok(stats)
    }

    pub fn render_in_memory(
        &self,
        kept_entries: &[DirEntryMeta],
        skeleton_files: &HashSet<String>,
        skeleton_all: bool,
    ) -> std::io::Result<(Vec<u8>, PackStats)> {
        let kept_paths: Vec<PathBuf> = kept_entries.iter().map(|e| e.path.clone()).collect();
        if let Ok(guard) = self.last_render.lock() {
            if let Some(ref cached) = *guard {
                if cached.skeleton_all == skeleton_all
                    && cached.skeleton_files == *skeleton_files
                    && cached.kept_paths == kept_paths
                {
                    return Ok((cached.rendered.clone(), cached.stats.clone()));
                }
            }
        }

        let kept_files: Vec<&DirEntryMeta> = kept_entries.iter().filter(|e| !e.is_dir).collect();
        let ordered = architectural_order(&kept_files, &self.options.modified_files);

        let mut prepared: Vec<PreparedFile> = Vec::with_capacity(ordered.len());
        for meta in &ordered {
            let rel = display_path(&meta.path);
            if let Some(&idx) = self.files_by_path.get(&rel) {
                let wf = &self.files[idx];
                let want_skeleton = skeleton_all || skeleton_files.contains(&wf.path);
                let (mode, content, tokens) = match (
                    want_skeleton && wf.is_text_ok,
                    &wf.skeleton_content,
                    wf.skeleton_tokens,
                ) {
                    (true, Some(skel), Some(tok)) => (FilePackMode::Skeleton, skel.clone(), tok),
                    _ => (FilePackMode::Full, wf.full_content.clone(), wf.full_tokens),
                };

                prepared.push(PreparedFile {
                    path: wf.path.clone(),
                    ext: wf.ext.clone(),
                    size: wf.size,
                    mode,
                    content,
                    tokens,
                    redactions: wf.redactions.clone(),
                    is_modified: wf.is_modified,
                });
            }
        }

        let mut rendered = Vec::new();
        let mut extra_redactions = RedactionSummary {
            redaction_enabled: self.options.redact_secrets,
            ..RedactionSummary::default()
        };
        match self.options.format {
            OutputFormat::Xml => write_xml_prepared(
                &mut rendered,
                &kept_files,
                &prepared,
                &self.root,
                &self.options,
                &mut extra_redactions,
            )?,
            OutputFormat::Markdown => write_markdown_prepared(
                &mut rendered,
                &kept_files,
                &prepared,
                &self.root,
                &self.options,
                &mut extra_redactions,
            )?,
            OutputFormat::Json => write_json_prepared(
                &mut rendered,
                &kept_files,
                &prepared,
                &self.root,
                &self.options,
                &mut extra_redactions,
            )?,
            OutputFormat::Plain => write_plain_prepared(
                &mut rendered,
                &prepared,
                &self.root,
                &self.options,
                &mut extra_redactions,
            )?,
        }

        let mut stats = PackStats {
            files_packed: prepared.len(),
            total_tokens: 0,
            content_tokens: 0,
            overhead_tokens: 0,
            tokenizer_exact: self.options.compute_bpe_tokens
                && self.options.tokenizer_model.is_exact_bpe(),
            file_tokens: Vec::with_capacity(prepared.len()),
            redactions: extra_redactions,
        };

        for pf in prepared {
            stats.content_tokens += pf.tokens;
            stats.redactions.merge(&pf.redactions);
            stats.file_tokens.push(FileTokenStat {
                path: pf.path,
                bytes: pf.content.len(),
                tokens: pf.tokens,
                mode: pf.mode,
            });
        }

        if self.options.compute_bpe_tokens {
            let rendered_str = std::str::from_utf8(&rendered)
                .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
            stats.total_tokens =
                count_tokens_with_model(rendered_str, self.options.tokenizer_model);
        } else {
            let approx_total = ((rendered.len() as f64) / 3.8).round() as usize;
            stats.total_tokens = approx_total.max(stats.content_tokens);
        }
        stats.overhead_tokens = stats.total_tokens.saturating_sub(stats.content_tokens);

        if let Ok(mut guard) = self.last_render.lock() {
            *guard = Some(CachedRender {
                kept_paths,
                skeleton_files: skeleton_files.clone(),
                skeleton_all,
                rendered: rendered.clone(),
                stats: stats.clone(),
            });
        }

        Ok((rendered, stats))
    }
}

struct PreparedFile {
    path: String,
    ext: String,
    size: Option<u64>,
    mode: FilePackMode,
    content: String,
    tokens: usize,
    redactions: RedactionSummary,
    is_modified: bool,
}

/// Main high-quality writer.
pub fn write_output<W: Write>(
    writer: &mut W,
    entries: &[DirEntryMeta],
    root: &Path,
    options: &WriteOptions,
) -> std::io::Result<()> {
    write_output_cancellable(writer, entries, root, options, &|| false)
}

/// Like `write_output`, but checks `cancelled` before reading each file and stops with
/// `ErrorKind::Interrupted` once it returns true (e.g. a newer request superseded this one).
pub fn write_output_cancellable<W: Write>(
    writer: &mut W,
    entries: &[DirEntryMeta],
    root: &Path,
    options: &WriteOptions,
    cancelled: &dyn Fn() -> bool,
) -> std::io::Result<()> {
    let canonical_root = std::fs::canonicalize(root)?;
    let root = canonical_root.as_path();
    let files: Vec<&DirEntryMeta> = entries.iter().filter(|e| !e.is_dir).collect();
    let valid_parents = build_valid_parent_cache(root, &files);
    let ordered = architectural_order(&files, &options.modified_files);

    let mut dummy_redactions = RedactionSummary::default();
    match options.format {
        OutputFormat::Xml => {
            write_xml_header(writer, &files, root, options)?;
            for f in &ordered {
                ensure_not_cancelled(cancelled)?;
                let pf = prepare_single_file(f, root, &valid_parents, options);
                write_xml_file_entry(writer, &pf)?;
            }
            write_xml_footer(writer, options, &mut dummy_redactions)
        }
        OutputFormat::Markdown => {
            write_markdown_header(writer, &files, root, options)?;
            for f in &ordered {
                ensure_not_cancelled(cancelled)?;
                let pf = prepare_single_file(f, root, &valid_parents, options);
                write_markdown_file_entry(writer, &pf)?;
            }
            write_markdown_footer(writer, options, &mut dummy_redactions)
        }
        OutputFormat::Json => {
            let mut prepared = Vec::with_capacity(files.len());
            for f in &ordered {
                ensure_not_cancelled(cancelled)?;
                prepared.push(prepare_single_file(f, root, &valid_parents, options));
            }
            write_json_prepared(
                writer,
                &files,
                &prepared,
                root,
                options,
                &mut dummy_redactions,
            )
        }
        OutputFormat::Plain => {
            write_plain_header(writer, root, options)?;
            for f in &ordered {
                ensure_not_cancelled(cancelled)?;
                let pf = prepare_single_file(f, root, &valid_parents, options);
                write_plain_file_entry(writer, &pf)?;
            }
            write_plain_footer(writer, options, &mut dummy_redactions)
        }
    }
}

/// Parallelized writer that also returns [`PackStats`] (redaction summary + per-file token stats).
pub fn write_output_with_stats<W, F>(
    writer: &mut W,
    entries: &[DirEntryMeta],
    root: &Path,
    options: &WriteOptions,
    cancelled: &F,
) -> std::io::Result<PackStats>
where
    W: Write,
    F: Fn() -> bool + Sync,
{
    let workspace = PreparedWorkspace::prepare(entries, root, options, cancelled)?;
    workspace.render_with_stats(
        writer,
        entries,
        &options.skeleton_files,
        options.skeleton_all,
    )
}

/// Architectural emission tier for `<files>` content (lower is emitted first). Truncating a pack
/// from the bottom then drops docs and CI metadata before source code. `<directory_structure>`
/// stays alphabetical and is unaffected.
///
/// 0 = source and entrypoints, 1 = manifests and build configs, 2 = tests and examples,
/// 3 = documentation, CI metadata and everything else.
pub fn architectural_tier(rel: &str) -> u8 {
    let lower = normalize_rel_path(Path::new(rel)).to_ascii_lowercase();
    let name = lower.rsplit('/').next().unwrap_or(&lower);

    const MANIFESTS: &[&str] = &[
        "cargo.toml",
        "package.json",
        "tauri.conf.json",
        "pyproject.toml",
        "go.mod",
        "makefile",
        "dockerfile",
        "build.rs",
    ];
    if MANIFESTS.contains(&name) || (name.starts_with("tsconfig") && name.ends_with(".json")) {
        return 1;
    }

    fn in_dir(lower: &str, dir: &str) -> bool {
        lower.starts_with(&format!("{dir}/")) || lower.contains(&format!("/{dir}/"))
    }
    let is_test_name = name.contains(".test.")
        || name.contains(".spec.")
        || name.contains("_test.")
        || name.starts_with("test_");
    if is_test_name
        || ["tests", "e2e", "examples", "benches", "benchmarks"]
            .iter()
            .any(|d| in_dir(&lower, d))
    {
        return 2;
    }

    const SOURCE_DIRS: &[&str] = &[
        "src", "lib", "app", "pkg", "cmd", "internal", "crates", "packages",
    ];
    const SOURCE_EXTS: &[&str] = &[
        ".rs", ".ts", ".tsx", ".js", ".jsx", ".py", ".go", ".cs", ".java", ".c", ".cpp", ".h",
        ".hpp",
    ];
    let is_source_ext = SOURCE_EXTS.iter().any(|e| lower.ends_with(e));
    if is_source_ext || SOURCE_DIRS.iter().any(|d| in_dir(&lower, d)) {
        return 0;
    }

    3
}

/// `files` ordered for content emission: unmodified files first, modified files last,
/// both sorted by [`architectural_tier`], then by path.
pub fn architectural_order<'a>(
    files: &[&'a DirEntryMeta],
    modified_files: &HashSet<String>,
) -> Vec<&'a DirEntryMeta> {
    let mut ordered: Vec<&DirEntryMeta> = files.to_vec();
    ordered.sort_by_cached_key(|f| {
        let rel = normalize_rel_path(&f.path);
        let is_mod = modified_files.contains(&rel);
        (is_mod, architectural_tier(&rel), rel)
    });
    ordered
}

fn ensure_not_cancelled(cancelled: &dyn Fn() -> bool) -> std::io::Result<()> {
    if cancelled() {
        Err(std::io::Error::new(
            std::io::ErrorKind::Interrupted,
            "output superseded by a newer request",
        ))
    } else {
        Ok(())
    }
}

/// Validates unique parent directories once against `canonical_root`, caching valid canonical
/// parent paths in a `HashMap<PathBuf, PathBuf>`.
fn build_valid_parent_cache(root: &Path, files: &[&DirEntryMeta]) -> HashMap<PathBuf, PathBuf> {
    let mut unique_parents: HashSet<PathBuf> = HashSet::new();
    for f in files {
        let parent = f.path.parent().unwrap_or(Path::new("")).to_path_buf();
        unique_parents.insert(parent);
    }

    let mut valid_parents = HashMap::with_capacity(unique_parents.len());
    for parent in unique_parents {
        if parent.as_os_str().is_empty() || parent == Path::new(".") {
            valid_parents.insert(parent, root.to_path_buf());
        } else if let Ok(canon_dir) = resolve_under_canonical_root(root, &parent.to_string_lossy())
        {
            if canon_dir.is_dir() {
                valid_parents.insert(parent, canon_dir);
            }
        }
    }
    valid_parents
}

/// Resolves a file path using the pre-validated parent directory cache, while still checking
/// the file's own `symlink_metadata` (`!is_link`) and `canonicalize().starts_with(root)`.
fn resolve_file_with_parent_cache(
    root: &Path,
    relative: &Path,
    valid_parents: &HashMap<PathBuf, PathBuf>,
) -> std::io::Result<PathBuf> {
    let rel_str = relative.to_string_lossy();
    if rel_str.is_empty() || rel_str == "." || Path::new(rel_str.as_ref()).is_absolute() {
        return resolve_under_canonical_root(root, &rel_str);
    }
    // Check that the filename itself is a single normal component
    let Some(file_name) = relative.file_name() else {
        return resolve_under_canonical_root(root, &rel_str);
    };
    let parent = relative.parent().unwrap_or(Path::new(""));
    let Some(canon_parent) = valid_parents.get(parent) else {
        // Fallback to full component-by-component check so error kind is preserved
        return resolve_under_canonical_root(root, &rel_str);
    };
    let joined = canon_parent.join(file_name);
    let metadata = std::fs::symlink_metadata(&joined)?;
    if is_link(&metadata) {
        return Err(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            "symlinks and reparse points are not allowed",
        ));
    }
    let full = std::fs::canonicalize(&joined)?;
    if !full.starts_with(root) {
        return Err(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            "path is outside the project root",
        ));
    }
    Ok(full)
}

fn prepare_single_file(
    f: &DirEntryMeta,
    root: &Path,
    valid_parents: &HashMap<PathBuf, PathBuf>,
    options: &WriteOptions,
) -> PreparedFile {
    let path_str = display_path(&f.path);
    let ext = f
        .path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_string();
    let mode = if options.skeleton_all || options.skeleton_files.contains(&path_str) {
        FilePackMode::Skeleton
    } else {
        FilePackMode::Full
    };

    let (raw_content, redactions, is_text_ok) = read_and_redact_file(
        root,
        &f.path,
        valid_parents,
        options.max_file_size,
        options.redact_secrets,
    );

    let content = if is_text_ok && mode == FilePackMode::Skeleton {
        let lang = language_for_path(&f.path);
        extract_skeleton(&raw_content, lang)
    } else {
        raw_content
    };

    let tokens = if options.compute_bpe_tokens {
        count_tokens_with_model(&content, options.tokenizer_model)
    } else {
        ((content.len() as f64) / 3.8).round() as usize
    };

    let is_modified = options.modified_files.contains(&path_str);

    PreparedFile {
        path: path_str,
        ext,
        size: f.size,
        mode,
        content,
        tokens,
        redactions,
        is_modified,
    }
}

fn display_path(path: &Path) -> String {
    normalize_rel_path(path)
}

fn escape_xml_attr(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            c if c.is_control() && c != '\t' && c != '\n' && c != '\r' => {
                // Strip illegal XML 1.0 control chars from attributes
            }
            c => out.push(c),
        }
    }
    out
}

/// Write text inside a CDATA section, safely splitting on the `]]>` terminator.
fn write_cdata<W: Write>(w: &mut W, content: &str) -> std::io::Result<()> {
    writeln!(w, "      <![CDATA[")?;
    // XML forbids `]]>` inside CDATA; split and re-open sections.
    let mut rest = content;
    while let Some(idx) = rest.find("]]>") {
        write!(w, "{}]]]]><![CDATA[>", &rest[..idx])?;
        rest = &rest[idx + 3..];
    }
    write!(w, "{rest}")?;
    writeln!(w, "\n      ]]>")?;
    Ok(())
}

/// Returns the trimmed task prompt, masked with the same rules as file contents and the Git diff
/// when redaction is on. Masked counts are merged into `extra_redactions` so the report covers them.
fn task_prompt_text(
    options: &WriteOptions,
    extra_redactions: &mut RedactionSummary,
) -> Option<String> {
    let prompt = options
        .task_prompt
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())?;
    if options.redact_secrets {
        let (redacted, summary) = redact_secrets_with_report(prompt);
        extra_redactions.merge(&summary);
        Some(redacted.into_owned())
    } else {
        Some(prompt.to_string())
    }
}

fn write_xml_header<W: Write>(
    w: &mut W,
    files: &[&DirEntryMeta],
    root: &Path,
    options: &WriteOptions,
) -> std::io::Result<()> {
    let root_disp = escape_xml_attr(&root_label(root));
    writeln!(w, "<project_context>")?;
    writeln!(
        w,
        "  <source>This file was generated by ptt (ProjectToText) from {root_disp}</source>"
    )?;
    writeln!(w, "  <instruction>Below is the complete (curated) content of the project. Use it for code analysis, refactoring, or implementation tasks.</instruction>")?;
    writeln!(
        w,
        "  <reading_info>Files were read respecting .gitignore (and .pttignore if present). Large files (&gt;{} bytes) and binaries are replaced with notes. Text files decoded as UTF-8 or BOM-declared UTF-16.</reading_info>",
        options.max_file_size
    )?;

    if options.include_file_summary {
        writeln!(w, "  <file_summary>")?;
        writeln!(w, "    Total files included: {}", files.len())?;
        // Oversized files are replaced by a note, so they are not counted as included bytes.
        if options.modified_files.is_empty() {
            let total_size: u64 = files
                .iter()
                .filter_map(|f| f.size)
                .filter(|&size| size <= options.max_file_size)
                .sum();
            writeln!(w, "    Total size: {total_size} bytes")?;
        } else {
            let base_size: u64 = files
                .iter()
                .filter(|f| {
                    !options
                        .modified_files
                        .contains(&normalize_rel_path(&f.path))
                })
                .filter_map(|f| f.size)
                .filter(|&size| size <= options.max_file_size)
                .sum();
            writeln!(w, "    Unmodified base size: {base_size} bytes")?;
        }
        writeln!(
            w,
            "    Note: File contents were read with size limits ({} bytes max), binary detection, and UTF-8 / BOM-declared UTF-16 decoding.",
            options.max_file_size
        )?;
        writeln!(w, "  </file_summary>")?;
    }

    writeln!(w, "  <directory_structure>")?;
    for f in files {
        writeln!(w, "    {}", display_path(&f.path))?;
    }
    writeln!(w, "  </directory_structure>")?;
    writeln!(w, "  <files>")?;
    Ok(())
}

fn write_xml_file_entry<W: Write>(w: &mut W, pf: &PreparedFile) -> std::io::Result<()> {
    let path_attr = escape_xml_attr(&pf.path);
    let status_attr = if pf.is_modified {
        " status=\"modified\""
    } else {
        ""
    };
    match pf.mode {
        FilePackMode::Full => writeln!(w, "    <file path=\"{path_attr}\"{status_attr}>")?,
        FilePackMode::Skeleton => writeln!(
            w,
            "    <file path=\"{path_attr}\" mode=\"skeleton\"{status_attr}>"
        )?,
    }
    write_cdata(w, &pf.content)?;
    writeln!(w, "    </file>")
}

fn write_xml_footer<W: Write>(
    w: &mut W,
    options: &WriteOptions,
    extra_redactions: &mut RedactionSummary,
) -> std::io::Result<()> {
    writeln!(w, "  </files>")?;

    if let Some(diff) = options
        .git_diff
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        let diff_text = if options.redact_secrets {
            let (redacted, summary) = redact_secrets_with_report(diff);
            extra_redactions.merge(&summary);
            redacted
        } else {
            std::borrow::Cow::Borrowed(diff)
        };
        writeln!(w, "  <git_diff>")?;
        write_cdata(w, &diff_text)?;
        writeln!(w, "  </git_diff>")?;
    }

    if let Some(prompt) = task_prompt_text(options, extra_redactions) {
        // The prompt is free text (e.g. `Vec<T>`, `a && b`), so it is wrapped in CDATA like file
        // contents. Escaping it as plain text would produce invalid XML.
        writeln!(w, "  <task_instructions>")?;
        write_cdata(w, &prompt)?;
        writeln!(w, "  </task_instructions>")?;
    }

    writeln!(w, "</project_context>")
}

fn write_xml_prepared<W: Write>(
    w: &mut W,
    files: &[&DirEntryMeta],
    prepared: &[PreparedFile],
    root: &Path,
    options: &WriteOptions,
    extra_redactions: &mut RedactionSummary,
) -> std::io::Result<()> {
    write_xml_header(w, files, root, options)?;
    for pf in prepared {
        write_xml_file_entry(w, pf)?;
    }
    write_xml_footer(w, options, extra_redactions)
}

fn write_markdown_header<W: Write>(
    w: &mut W,
    files: &[&DirEntryMeta],
    root: &Path,
    options: &WriteOptions,
) -> std::io::Result<()> {
    writeln!(w, "# Project Context")?;
    writeln!(w, "Generated from: `{}`", root_label(root))?;
    writeln!(
        w,
        "Reading info: Files processed with size/binary limits (max {} bytes) and encoding handling.\n",
        options.max_file_size
    )?;
    if options.include_file_summary {
        writeln!(w, "## Directory Structure")?;
        for file in files {
            writeln!(w, "- `{}`", display_path(&file.path))?;
        }
        writeln!(w)?;
    }
    Ok(())
}

fn write_markdown_file_entry<W: Write>(w: &mut W, pf: &PreparedFile) -> std::io::Result<()> {
    let fence = markdown_fence(&pf.content);
    let mod_suffix = if pf.is_modified { " *(modified)*" } else { "" };
    match pf.mode {
        FilePackMode::Full => writeln!(w, "## `{}`{mod_suffix}", pf.path)?,
        FilePackMode::Skeleton => writeln!(w, "## `{}` *(skeleton)*{mod_suffix}", pf.path)?,
    }
    writeln!(w, "{fence}{}", pf.ext)?;
    writeln!(w, "{}", pf.content)?;
    writeln!(w, "{fence}")?;
    writeln!(w)
}

fn write_markdown_footer<W: Write>(
    w: &mut W,
    options: &WriteOptions,
    extra_redactions: &mut RedactionSummary,
) -> std::io::Result<()> {
    if let Some(diff) = options
        .git_diff
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        let diff_text = if options.redact_secrets {
            let (redacted, summary) = redact_secrets_with_report(diff);
            extra_redactions.merge(&summary);
            redacted
        } else {
            std::borrow::Cow::Borrowed(diff)
        };
        let fence = markdown_fence(&diff_text);
        writeln!(w, "## Git Diff (`<git_diff>`)")?;
        writeln!(w, "{fence}diff")?;
        writeln!(w, "{diff_text}")?;
        writeln!(w, "{fence}\n")?;
    }

    if let Some(prompt) = task_prompt_text(options, extra_redactions) {
        writeln!(w, "<task_instructions>")?;
        writeln!(w, "{prompt}")?;
        writeln!(w, "</task_instructions>")?;
    }

    Ok(())
}

fn write_markdown_prepared<W: Write>(
    w: &mut W,
    files: &[&DirEntryMeta],
    prepared: &[PreparedFile],
    root: &Path,
    options: &WriteOptions,
    extra_redactions: &mut RedactionSummary,
) -> std::io::Result<()> {
    write_markdown_header(w, files, root, options)?;
    for pf in prepared {
        write_markdown_file_entry(w, pf)?;
    }
    write_markdown_footer(w, options, extra_redactions)
}

fn write_json_prepared<W: Write>(
    w: &mut W,
    files: &[&DirEntryMeta],
    prepared: &[PreparedFile],
    root: &Path,
    options: &WriteOptions,
    extra_redactions: &mut RedactionSummary,
) -> std::io::Result<()> {
    let mut file_objs: Vec<Value> = Vec::with_capacity(prepared.len());
    for pf in prepared {
        let mut obj = json!({
            "path": pf.path,
            "size": pf.size,
            "content": pf.content,
        });
        if pf.mode == FilePackMode::Skeleton {
            obj["mode"] = json!("skeleton");
        }
        if pf.is_modified {
            obj["status"] = json!("modified");
        }
        file_objs.push(obj);
    }

    let mut doc = json!({
        "generator": "ptt (ProjectToText)",
        "root": root_label(root),
        "reading_info": format!(
            "Files read with {} byte limit, binary detection, UTF-8 / BOM-declared UTF-16 decoding.",
            options.max_file_size
        ),
        "file_count": prepared.len(),
        "files": file_objs,
    });
    if options.include_file_summary {
        doc["directory_structure"] = json!(files
            .iter()
            .map(|file| display_path(&file.path))
            .collect::<Vec<_>>());
    }

    if let Some(diff) = options
        .git_diff
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        let diff_text = if options.redact_secrets {
            let (redacted, summary) = redact_secrets_with_report(diff);
            extra_redactions.merge(&summary);
            redacted.into_owned()
        } else {
            diff.to_string()
        };
        doc["git_diff"] = json!(diff_text);
    }

    if let Some(prompt) = task_prompt_text(options, extra_redactions) {
        doc["task_instructions"] = json!(prompt);
    }

    let pretty = serde_json::to_string_pretty(&doc)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    writeln!(w, "{pretty}")?;
    Ok(())
}

fn write_plain_header<W: Write>(
    w: &mut W,
    root: &Path,
    options: &WriteOptions,
) -> std::io::Result<()> {
    writeln!(w, "Project: {}", root_label(root))?;
    writeln!(
        w,
        "Reading info: Data read with limits ({} bytes), binary skip, UTF-8 / BOM-declared UTF-16.",
        options.max_file_size
    )?;
    writeln!(w, "================================\n")
}

fn write_plain_file_entry<W: Write>(w: &mut W, pf: &PreparedFile) -> std::io::Result<()> {
    let mod_suffix = if pf.is_modified { " [modified]" } else { "" };
    match pf.mode {
        FilePackMode::Full => writeln!(w, ">>> {}{mod_suffix}", pf.path)?,
        FilePackMode::Skeleton => writeln!(w, ">>> {} [skeleton]{mod_suffix}", pf.path)?,
    }
    writeln!(w, "{}", pf.content)?;
    writeln!(w, "--------------------------------\n")
}

fn write_plain_footer<W: Write>(
    w: &mut W,
    options: &WriteOptions,
    extra_redactions: &mut RedactionSummary,
) -> std::io::Result<()> {
    if let Some(diff) = options
        .git_diff
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        let diff_text = if options.redact_secrets {
            let (redacted, summary) = redact_secrets_with_report(diff);
            extra_redactions.merge(&summary);
            redacted
        } else {
            std::borrow::Cow::Borrowed(diff)
        };
        writeln!(w, "<git_diff>")?;
        writeln!(w, "{diff_text}")?;
        writeln!(w, "</git_diff>\n")?;
    }

    if let Some(prompt) = task_prompt_text(options, extra_redactions) {
        writeln!(w, "<task_instructions>")?;
        writeln!(w, "{prompt}")?;
        writeln!(w, "</task_instructions>")?;
    }

    Ok(())
}

fn write_plain_prepared<W: Write>(
    w: &mut W,
    prepared: &[PreparedFile],
    root: &Path,
    options: &WriteOptions,
    extra_redactions: &mut RedactionSummary,
) -> std::io::Result<()> {
    write_plain_header(w, root, options)?;
    for pf in prepared {
        write_plain_file_entry(w, pf)?;
    }
    write_plain_footer(w, options, extra_redactions)
}

/// Project folder name only, so packed output never exposes the absolute path.
fn root_label(root: &Path) -> String {
    root.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "project".to_string())
}

/// `root` must already be canonical (`write_output` canonicalizes it once).
/// Returns `(content, redaction_summary, is_decoded_text)`.
fn read_and_redact_file(
    root: &Path,
    relative: &Path,
    valid_parents: &HashMap<PathBuf, PathBuf>,
    max_file_size: u64,
    redact: bool,
) -> (String, RedactionSummary, bool) {
    let skipped_summary = || RedactionSummary {
        redaction_enabled: redact,
        files_skipped: 1,
        ..RedactionSummary::default()
    };
    let path = match resolve_file_with_parent_cache(root, relative, valid_parents) {
        Ok(path) => path,
        Err(_) => {
            return (
                "[File skipped: inaccessible or unsafe project path]".into(),
                skipped_summary(),
                false,
            )
        }
    };
    let (file, meta) = match open_verified_regular_file(&path) {
        Ok(pair) => pair,
        Err(e) if e.kind() == std::io::ErrorKind::PermissionDenied => {
            return (
                "[File skipped: not a regular file]".into(),
                skipped_summary(),
                false,
            )
        }
        Err(e) => {
            return (
                format!("[Error reading metadata: {e}]"),
                skipped_summary(),
                false,
            )
        }
    };

    let file_size = meta.len();
    if file_size > max_file_size {
        return (
            format!("[File too large: {file_size} bytes (limit {max_file_size}), skipped]"),
            skipped_summary(),
            false,
        );
    }

    // Enforce the limit while reading from the verified handle, in case a file grows after fstat.
    use std::io::Read;
    let bytes = {
        let mut bytes = Vec::with_capacity(file_size as usize);
        file.take(max_file_size.saturating_add(1))
            .read_to_end(&mut bytes)
            .map(|_| bytes)
    };
    match bytes {
        Ok(bytes) if bytes.len() as u64 > max_file_size => (
            format!("[File too large: limit {max_file_size} bytes, skipped]"),
            skipped_summary(),
            false,
        ),
        Ok(bytes) => match decode_text(&bytes, false) {
            Ok(text) => {
                if is_generated_project_context(&text) {
                    (
                        "[Generated ptt context artifact skipped to prevent recursive packing]"
                            .into(),
                        skipped_summary(),
                        false,
                    )
                } else if redact {
                    let (redacted, mut summary) = redact_secrets_with_report(&text);
                    summary.redaction_enabled = true;
                    summary.files_scanned = 1;
                    (redacted.into_owned(), summary, true)
                } else {
                    (
                        text,
                        RedactionSummary {
                            redaction_enabled: false,
                            files_scanned: 0,
                            files_skipped: 0,
                            ..RedactionSummary::default()
                        },
                        true,
                    )
                }
            }
            Err(TextError::Binary) => (
                format!("[Binary file - {file_size} bytes, content omitted for LLM safety]"),
                skipped_summary(),
                false,
            ),
            Err(TextError::Encoding) => (
                "[Invalid text encoding: use UTF-8 or UTF-16 with BOM]".into(),
                skipped_summary(),
                false,
            ),
        },
        Err(_) => (
            "[Error reading project file]".into(),
            skipped_summary(),
            false,
        ),
    }
}

/// Matches only PTT's own serialized context envelope, not arbitrary project files that mention
/// the marker elsewhere. The check runs after decoding and before redaction/skeleton extraction.
fn is_generated_project_context(text: &str) -> bool {
    let mut cut = text.len().min(512);
    while cut > 0 && !text.is_char_boundary(cut) {
        cut -= 1;
    }
    let head = &text[..cut];
    let trimmed = head.trim_start();
    (trimmed.starts_with("<project_context>")
        && head.contains("This file was generated by ptt (ProjectToText)"))
        || (trimmed.starts_with('{') && head.contains("\"generator\": \"ptt (ProjectToText)\""))
        || (trimmed.starts_with("# Project Context\nGenerated from: `")
            && head.contains("Reading info: Files processed with size/binary limits (max "))
        || (trimmed.starts_with("Project: ")
            && head.contains("\nReading info: Data read with limits (")
            && head.contains("================================\n"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    fn tmp_project() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path().to_path_buf();
        fs::write(root.join("hello.rs"), "fn main() {}\n").unwrap();
        fs::write(root.join("notes.md"), "hello ]]> world\n").unwrap();
        (dir, root)
    }

    fn entries_for(root: &Path) -> Vec<DirEntryMeta> {
        vec![
            DirEntryMeta {
                path: PathBuf::from("hello.rs"),
                is_dir: false,
                size: Some(12),
            },
            DirEntryMeta {
                path: PathBuf::from("notes.md"),
                is_dir: false,
                size: Some(14),
            },
        ]
        .into_iter()
        .map(|mut e| {
            if let Ok(m) = fs::metadata(root.join(&e.path)) {
                e.size = Some(m.len());
            }
            e
        })
        .collect()
    }

    #[test]
    fn json_is_valid_and_roundtrips() {
        let (_dir, root) = tmp_project();
        let mut entries = entries_for(&root);
        entries.reverse();
        let mut buf = Vec::new();
        let opts = WriteOptions {
            format: OutputFormat::Json,
            include_file_summary: true,
            max_file_size: DEFAULT_MAX_FILE_SIZE,
            ..Default::default()
        };
        write_output(&mut buf, &entries, &root, &opts).unwrap();
        let v: Value = serde_json::from_slice(&buf).expect("valid JSON");
        assert_eq!(v["file_count"], 2);
        assert!(v["files"].as_array().unwrap().len() == 2);
        assert_eq!(v["directory_structure"], json!(["notes.md", "hello.rs"]));
        let content = v["files"][0]["content"].as_str().unwrap();
        assert!(content.contains("fn main") || content.contains("hello"));
    }

    #[test]
    fn task_prompt_secrets_are_masked_in_every_format_and_counted() {
        let (_dir, root) = tmp_project();
        let entries = entries_for(&root);
        let token = concat!("sk-", "abcdefghijklmnopqrstuvwx");
        let prompt = format!("Why does this key fail: {token} ?");
        for format in [
            OutputFormat::Xml,
            OutputFormat::Markdown,
            OutputFormat::Json,
            OutputFormat::Plain,
        ] {
            let opts = WriteOptions {
                format,
                task_prompt: Some(prompt.clone()),
                redact_secrets: true,
                ..Default::default()
            };
            let mut buf = Vec::new();
            let stats =
                write_output_with_stats(&mut buf, &entries, &root, &opts, &|| false).unwrap();
            let text = String::from_utf8(buf).unwrap();
            assert!(!text.contains(token), "{format:?} leaked the prompt secret");
            assert!(
                text.contains("[REDACTED"),
                "{format:?} did not mask the prompt"
            );
            assert!(
                stats.redactions.total_redactions >= 1,
                "{format:?} masked prompt not counted in the report"
            );
        }

        let opts = WriteOptions {
            format: OutputFormat::Plain,
            task_prompt: Some(prompt.clone()),
            redact_secrets: false,
            ..Default::default()
        };
        let mut buf = Vec::new();
        let stats = write_output_with_stats(&mut buf, &entries, &root, &opts, &|| false).unwrap();
        let text = String::from_utf8(buf).unwrap();
        assert!(
            text.contains(token),
            "redaction off must keep the prompt verbatim"
        );
        assert!(!stats.redactions.redaction_enabled);
    }

    #[test]
    fn xml_escapes_cdata_terminator() {
        let (_dir, root) = tmp_project();
        let entries = entries_for(&root);
        let mut buf = Vec::new();
        let opts = WriteOptions {
            format: OutputFormat::Xml,
            include_file_summary: true,
            max_file_size: DEFAULT_MAX_FILE_SIZE,
            ..Default::default()
        };
        write_output(&mut buf, &entries, &root, &opts).unwrap();
        let s = String::from_utf8(buf).unwrap();
        // Raw `]]>` must not appear unescaped inside a single CDATA block
        assert!(s.contains("]]]]><![CDATA[>"));
        assert!(s.contains("<project_context>"));
        assert!(s.contains("path=\"notes.md\""));
    }

    #[test]
    fn xml_escapes_attribute_special_chars() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let entries = vec![DirEntryMeta {
            path: PathBuf::from("a&b<c>.rs"),
            is_dir: false,
            size: Some(1),
        }];
        let mut buf = Vec::new();
        let opts = WriteOptions {
            format: OutputFormat::Xml,
            ..Default::default()
        };
        write_output(&mut buf, &entries, root, &opts).unwrap();
        let s = String::from_utf8(buf).unwrap();
        assert!(
            s.contains("path=\"a&amp;b&lt;c&gt;.rs\""),
            "expected escaped path attr, got:\n{s}"
        );
        assert_eq!(escape_xml_attr(r#"x"y'z"#), "x&quot;y&apos;z");
    }

    #[test]
    fn respects_max_file_size() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::write(root.join("big.txt"), "abcdefghij").unwrap(); // 10 bytes
        let entries = vec![DirEntryMeta {
            path: PathBuf::from("big.txt"),
            is_dir: false,
            size: Some(10),
        }];
        let mut buf = Vec::new();
        let opts = WriteOptions {
            format: OutputFormat::Plain,
            include_file_summary: false,
            max_file_size: 5,
            ..Default::default()
        };
        write_output(&mut buf, &entries, root, &opts).unwrap();
        let s = String::from_utf8(buf).unwrap();
        assert!(s.contains("File too large"));
        assert!(!s.contains("abcdefghij"));
    }

    #[test]
    fn markdown_handles_nested_fences() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::write(root.join("doc.md"), "```\ncode\n```\n").unwrap();
        fs::write(root.join("alpha.md"), "alpha\n").unwrap();
        let entries = vec![
            DirEntryMeta {
                path: PathBuf::from("doc.md"),
                is_dir: false,
                size: Some(12),
            },
            DirEntryMeta {
                path: PathBuf::from("alpha.md"),
                is_dir: false,
                size: Some(6),
            },
        ];
        let mut buf = Vec::new();
        let opts = WriteOptions {
            format: OutputFormat::Markdown,
            ..Default::default()
        };
        write_output(&mut buf, &entries, root, &opts).unwrap();
        let s = String::from_utf8(buf).unwrap();
        assert!(s.contains("## Directory Structure\n- `doc.md`\n- `alpha.md`"));
        assert!(s.find("## Directory Structure").unwrap() < s.find("## `alpha.md`").unwrap());
        assert!(s.contains("````md"));
    }

    #[test]
    fn markdown_and_json_omit_directory_structure_when_summary_is_disabled() {
        let (_dir, root) = tmp_project();
        let entries = entries_for(&root);
        for format in [OutputFormat::Markdown, OutputFormat::Json] {
            let mut buf = Vec::new();
            let options = WriteOptions {
                format,
                include_file_summary: false,
                ..Default::default()
            };
            write_output(&mut buf, &entries, &root, &options).unwrap();
            let text = String::from_utf8(buf).unwrap();
            match format {
                OutputFormat::Markdown => assert!(!text.contains("## Directory Structure")),
                OutputFormat::Json => {
                    let value: Value = serde_json::from_str(&text).unwrap();
                    assert!(value.get("directory_structure").is_none());
                }
                _ => unreachable!(),
            }
        }
    }

    #[cfg(unix)]
    #[test]
    fn packed_output_skips_symlinks_and_hides_absolute_root() {
        let outside = tempfile::tempdir().unwrap();
        let secret = outside.path().join("secret.env");
        fs::write(&secret, "TOP-SECRET-TOKEN").unwrap();

        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::write(root.join("readme.md"), "hello\n").unwrap();
        std::os::unix::fs::symlink(&secret, root.join("link.env")).unwrap();
        let entries = vec![
            DirEntryMeta {
                path: PathBuf::from("readme.md"),
                is_dir: false,
                size: Some(6),
            },
            DirEntryMeta {
                path: PathBuf::from("link.env"),
                is_dir: false,
                size: Some(16),
            },
        ];

        for format in [
            OutputFormat::Xml,
            OutputFormat::Markdown,
            OutputFormat::Json,
            OutputFormat::Plain,
        ] {
            let mut buf = Vec::new();
            let opts = WriteOptions {
                format,
                ..Default::default()
            };
            write_output(&mut buf, &entries, root, &opts).unwrap();
            let s = String::from_utf8(buf).unwrap();
            assert!(
                !s.contains("TOP-SECRET-TOKEN"),
                "symlink target leaked: {format:?}"
            );
            assert!(
                !s.contains(&root.display().to_string()),
                "absolute root leaked: {format:?}"
            );
        }
    }

    #[test]
    fn escape_xml_attr_basics() {
        assert_eq!(escape_xml_attr(r#"a&b"c"#), "a&amp;b&quot;c");
    }

    #[test]
    fn modified_files_emitted_last_for_kv_cache_stability() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::write(root.join("src/a.rs"), "fn a() {}").unwrap();
        std::fs::write(root.join("src/b.rs"), "fn b() {}").unwrap();
        std::fs::write(root.join("src/c.rs"), "fn c() {}").unwrap();

        let entries = crate::core::walker::walk(&root).unwrap();
        let mut modified = std::collections::HashSet::new();
        modified.insert("src/a.rs".to_string());

        let opts = WriteOptions {
            format: OutputFormat::Xml,
            modified_files: modified,
            ..Default::default()
        };

        let mut buf = Vec::new();
        write_output(&mut buf, &entries, &root, &opts).unwrap();
        let out = String::from_utf8(buf).unwrap();

        let pos_a = out
            .find(r#"<file path="src/a.rs" status="modified">"#)
            .unwrap();
        let pos_b = out.find(r#"<file path="src/b.rs">"#).unwrap();
        let pos_c = out.find(r#"<file path="src/c.rs">"#).unwrap();

        assert!(pos_b < pos_c, "unmodified files keep alphabetical order");
        assert!(pos_c < pos_a, "modified file src/a.rs must be emitted last");
    }

    #[test]
    fn kv_cache_prefix_stays_byte_identical_when_modified_file_grows() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::write(
            root.join("src/lib.rs"),
            "pub fn stable_logic() -> &'static str { \"stable\" }\n",
        )
        .unwrap();
        std::fs::write(root.join("src/active.rs"), "fn tiny() {}\n").unwrap();

        let mut modified = std::collections::HashSet::new();
        modified.insert("src/active.rs".to_string());

        let opts = WriteOptions {
            format: OutputFormat::Xml,
            include_file_summary: true,
            modified_files: modified.clone(),
            ..Default::default()
        };

        // Render 1: active.rs is 13 bytes
        let entries1 = crate::core::walker::walk(&root).unwrap();
        let mut buf1 = Vec::new();
        write_output(&mut buf1, &entries1, &root, &opts).unwrap();
        let out1 = String::from_utf8(buf1).unwrap();

        // Now modify active.rs so it grows to ~500 bytes
        let large_content = (0..30)
            .map(|i| format!("pub fn dynamic_{i}() -> usize {{ {i} }}\n"))
            .collect::<String>();
        std::fs::write(root.join("src/active.rs"), &large_content).unwrap();

        // Render 2: active.rs is ~500 bytes
        let entries2 = crate::core::walker::walk(&root).unwrap();
        let mut buf2 = Vec::new();
        write_output(&mut buf2, &entries2, &root, &opts).unwrap();
        let out2 = String::from_utf8(buf2).unwrap();

        let marker = r#"<file path="src/active.rs" status="modified">"#;
        let pos1 = out1.find(marker).expect("marker must exist in out1");
        let pos2 = out2.find(marker).expect("marker must exist in out2");

        assert_eq!(pos1, pos2, "prefix split point must match");
        assert_eq!(
            &out1[..pos1],
            &out2[..pos2],
            "entire XML prefix before modified file must be 100% byte-for-byte identical"
        );
        assert!(out1[..pos1].contains("<file_summary>"));
        assert!(out1[..pos1].contains("Unmodified base size:"));
        assert!(out1[..pos1].contains(r#"<file path="src/lib.rs">"#));
    }

    #[test]
    fn generated_project_context_is_always_skipped_even_when_in_skeleton_files() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        let generated = "<project_context>\n  <source> This file was generated by ptt (ProjectToText) from earlier</source>\n  <files>old context</files>\n</project_context>\n";
        fs::write(root.join("previous.xml"), generated).unwrap();
        fs::write(
            root.join("ordinary.xml"),
            "<other>mention <project_context> in prose</other>",
        )
        .unwrap();
        let entries = vec!["previous.xml", "ordinary.xml"]
            .into_iter()
            .map(|path| DirEntryMeta {
                path: PathBuf::from(path),
                is_dir: false,
                size: fs::metadata(root.join(path)).unwrap().len().into(),
            })
            .collect::<Vec<_>>();

        for format in [
            OutputFormat::Xml,
            OutputFormat::Markdown,
            OutputFormat::Json,
            OutputFormat::Plain,
        ] {
            let mut skipped = Vec::new();
            write_output(
                &mut skipped,
                &entries,
                &root,
                &WriteOptions {
                    format,
                    redact_secrets: false,
                    ..Default::default()
                },
            )
            .unwrap();
            let skipped = String::from_utf8(skipped).unwrap();
            assert!(!skipped.contains("old context"), "{format:?}: {skipped}");
            assert!(
                skipped.contains("Generated ptt context artifact skipped"),
                "{format:?}: {skipped}"
            );
        }

        let mut ordinary = Vec::new();
        write_output(
            &mut ordinary,
            &entries[1..],
            &root,
            &WriteOptions {
                redact_secrets: false,
                ..Default::default()
            },
        )
        .unwrap();
        let ordinary = String::from_utf8(ordinary).unwrap();
        assert!(
            ordinary.contains("mention <project_context> in prose"),
            "{ordinary}"
        );
        assert!(!is_generated_project_context(
            "<project_context> mention in prose without generator marker</project_context>"
        ));
        assert!(is_generated_project_context(
            "\n<project_context> This file was generated by ptt (ProjectToText)"
        ));
        assert!(is_generated_project_context(
            "<project_context>\n  <source> This file was generated by ptt (ProjectToText)</source>"
        ));
        assert!(is_generated_project_context(
            "   {\n  \"generator\": \"ptt (ProjectToText)\"\n}"
        ));
        assert!(is_generated_project_context(
            "# Project Context\nGenerated from: `my_project`\nReading info: Files processed with size/binary limits (max 2097152 bytes) and encoding handling.\n\n## Directory Structure\n"
        ));
        assert!(is_generated_project_context(
            "Project: my_project\nReading info: Data read with limits (2097152 bytes), binary skip, UTF-8 / BOM-declared UTF-16.\n================================\n\n>>> src/lib.rs\n"
        ));

        let mut explicitly_selected = std::collections::HashSet::new();
        explicitly_selected.insert("previous.xml".to_string());
        let mut skipped_even_in_skeleton = Vec::new();
        write_output_with_stats(
            &mut skipped_even_in_skeleton,
            &entries,
            &root,
            &WriteOptions {
                redact_secrets: false,
                skeleton_files: explicitly_selected,
                ..Default::default()
            },
            &|| false,
        )
        .unwrap();
        let skipped_even_in_skeleton = String::from_utf8(skipped_even_in_skeleton).unwrap();
        assert!(
            !skipped_even_in_skeleton.contains("old context"),
            "{skipped_even_in_skeleton}"
        );
        assert!(
            skipped_even_in_skeleton.contains("Generated ptt context artifact skipped"),
            "{skipped_even_in_skeleton}"
        );
    }

    #[test]
    fn benchmark_artifacts_are_architectural_tier_two() {
        assert_eq!(architectural_tier("benchmarks/context-v1/prior.xml"), 2);
    }

    #[test]
    fn prepared_workspace_reuses_cached_render_buffer() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::write(root.join("src/lib.rs"), "pub fn cached() -> u32 { 1 }\n").unwrap();

        let entries = crate::core::walker::walk(&root).unwrap();
        let opts = WriteOptions {
            format: OutputFormat::Xml,
            compute_bpe_tokens: true,
            ..Default::default()
        };

        let ws = PreparedWorkspace::prepare_for_budget(&entries, &root, &opts, &|| false).unwrap();
        let skeleton_files = HashSet::new();

        // Call render_stats first (e.g. inside budget loop)
        let stats1 = ws.render_stats(&entries, &skeleton_files, false).unwrap();

        // Now render_with_stats directly afterwards
        let mut buf = Vec::new();
        let stats2 = ws
            .render_with_stats(&mut buf, &entries, &skeleton_files, false)
            .unwrap();

        assert_eq!(stats1.total_tokens, stats2.total_tokens);
        assert!(!buf.is_empty());
        let s = String::from_utf8(buf).unwrap();
        assert!(s.contains("pub fn cached"));
    }
}
