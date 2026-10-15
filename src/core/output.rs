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
        }
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
    let ordered = architectural_order(&files);

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
            write_markdown_header(writer, root, options)?;
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
            write_json_prepared(writer, &prepared, root, options, &mut dummy_redactions)
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
    let canonical_root = std::fs::canonicalize(root)?;
    let root = canonical_root.as_path();
    let files: Vec<&DirEntryMeta> = entries.iter().filter(|e| !e.is_dir).collect();

    let ordered = architectural_order(&files);
    let prepared = prepare_files_parallel(&ordered, root, options, cancelled)?;

    let mut rendered = Vec::new();
    let mut extra_redactions = RedactionSummary {
        redaction_enabled: options.redact_secrets,
        ..RedactionSummary::default()
    };
    match options.format {
        OutputFormat::Xml => write_xml_prepared(
            &mut rendered,
            &files,
            &prepared,
            root,
            options,
            &mut extra_redactions,
        )?,
        OutputFormat::Markdown => write_markdown_prepared(
            &mut rendered,
            &prepared,
            root,
            options,
            &mut extra_redactions,
        )?,
        OutputFormat::Json => write_json_prepared(
            &mut rendered,
            &prepared,
            root,
            options,
            &mut extra_redactions,
        )?,
        OutputFormat::Plain => write_plain_prepared(
            &mut rendered,
            &prepared,
            root,
            options,
            &mut extra_redactions,
        )?,
    }
    writer.write_all(&rendered)?;

    let mut stats = PackStats {
        files_packed: prepared.len(),
        total_tokens: 0,
        content_tokens: 0,
        overhead_tokens: 0,
        tokenizer_exact: options.compute_bpe_tokens && options.tokenizer_model.is_exact_bpe(),
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

    if options.compute_bpe_tokens {
        let rendered_str = std::str::from_utf8(&rendered)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
        stats.total_tokens = count_tokens_with_model(rendered_str, options.tokenizer_model);
    } else {
        let approx_total = ((rendered.len() as f64) / 3.8).round() as usize;
        stats.total_tokens = approx_total.max(stats.content_tokens);
    }
    stats.overhead_tokens = stats.total_tokens.saturating_sub(stats.content_tokens);

    Ok(stats)
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
        || ["tests", "e2e", "examples", "benches"]
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
    let is_root_source = !lower.contains('/') && SOURCE_EXTS.iter().any(|e| lower.ends_with(e));
    if is_root_source || SOURCE_DIRS.iter().any(|d| in_dir(&lower, d)) {
        return 0;
    }

    3
}

/// `files` ordered for content emission: by [`architectural_tier`], then by path.
fn architectural_order<'a>(files: &[&'a DirEntryMeta]) -> Vec<&'a DirEntryMeta> {
    let mut ordered: Vec<&DirEntryMeta> = files.to_vec();
    ordered.sort_by_cached_key(|f| {
        let rel = normalize_rel_path(&f.path);
        (architectural_tier(&rel), rel)
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

    PreparedFile {
        path: path_str,
        ext,
        size: f.size,
        mode,
        content,
        tokens,
        redactions,
    }
}

fn prepare_files_parallel<F>(
    files: &[&DirEntryMeta],
    root: &Path,
    options: &WriteOptions,
    cancelled: &F,
) -> std::io::Result<Vec<PreparedFile>>
where
    F: Fn() -> bool + Sync,
{
    let valid_parents = build_valid_parent_cache(root, files);

    // For small file counts, process sequentially so deterministic per-file cancellation tests
    // (like `superseded_pack_stops_before_reading_next_file`) behave identically.
    if files.len() < 16 {
        let mut out = Vec::with_capacity(files.len());
        for f in files {
            ensure_not_cancelled(cancelled)?;
            out.push(prepare_single_file(f, root, &valid_parents, options));
        }
        return Ok(out);
    }

    // One parallel pass over all files. Chunked passes would join the pool after every chunk,
    // so work-stealing could not balance uneven files. Each worker checks `cancelled` before
    // reading; `collect` stops at the first error, which keeps cancellation prompt.
    files
        .par_iter()
        .map(|f| {
            if cancelled() {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::Interrupted,
                    "output superseded by a newer request",
                ));
            }
            Ok(prepare_single_file(f, root, &valid_parents, options))
        })
        .collect()
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
        let total_size: u64 = files
            .iter()
            .filter_map(|f| f.size)
            .filter(|&size| size <= options.max_file_size)
            .sum();
        writeln!(w, "    Total size: {total_size} bytes")?;
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
    match pf.mode {
        FilePackMode::Full => writeln!(w, "    <file path=\"{path_attr}\">")?,
        FilePackMode::Skeleton => writeln!(w, "    <file path=\"{path_attr}\" mode=\"skeleton\">")?,
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
    root: &Path,
    options: &WriteOptions,
) -> std::io::Result<()> {
    writeln!(w, "# Project Context")?;
    writeln!(w, "Generated from: `{}`", root_label(root))?;
    writeln!(
        w,
        "Reading info: Files processed with size/binary limits (max {} bytes) and encoding handling.\n",
        options.max_file_size
    )
}

fn write_markdown_file_entry<W: Write>(w: &mut W, pf: &PreparedFile) -> std::io::Result<()> {
    let fence = markdown_fence(&pf.content);
    match pf.mode {
        FilePackMode::Full => writeln!(w, "## `{}`", pf.path)?,
        FilePackMode::Skeleton => writeln!(w, "## `{}` *(skeleton)*", pf.path)?,
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
    prepared: &[PreparedFile],
    root: &Path,
    options: &WriteOptions,
    extra_redactions: &mut RedactionSummary,
) -> std::io::Result<()> {
    write_markdown_header(w, root, options)?;
    for pf in prepared {
        write_markdown_file_entry(w, pf)?;
    }
    write_markdown_footer(w, options, extra_redactions)
}

fn write_json_prepared<W: Write>(
    w: &mut W,
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
    match pf.mode {
        FilePackMode::Full => writeln!(w, ">>> {}", pf.path)?,
        FilePackMode::Skeleton => writeln!(w, ">>> {} [skeleton]", pf.path)?,
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
                if redact {
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
        let entries = entries_for(&root);
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
        let entries = vec![DirEntryMeta {
            path: PathBuf::from("doc.md"),
            is_dir: false,
            size: Some(12),
        }];
        let mut buf = Vec::new();
        let opts = WriteOptions {
            format: OutputFormat::Markdown,
            ..Default::default()
        };
        write_output(&mut buf, &entries, root, &opts).unwrap();
        let s = String::from_utf8(buf).unwrap();
        assert!(s.contains("````md"));
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
}
