//! MCP tool surface: JSON schemas, argument validation, the project-root sandbox, and tool dispatch.
//!
//! `mcp.rs` owns the JSON-RPC envelope and calls [`dispatch_tool`] for each `tools/call`.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};

use rayon::prelude::*;
use serde_json::{json, Value};

use ptt::core::budget::fit_workspace_to_bpe_budget;
use ptt::core::git::compute_git_diff;
use ptt::core::output::{
    architectural_tier, write_output_with_stats, OutputFormat, WriteOptions, DEFAULT_MAX_FILE_SIZE,
};
use ptt::core::preview::{read_verified_file_string, resolve_under_canonical_root};
use ptt::core::secrets::redact_secrets;
use ptt::core::skeleton::{extract_skeleton, find_symbols, language_for_path, SymbolMatch};
use ptt::core::tokenizer::{count_tokens, estimate_tokens_from_bytes, TokenizerModel};
use ptt::core::walker::{normalize_rel_path, SelectionMatcher};
use ptt::core::workspace::{WorkspaceIndex, WorkspaceSnapshot};

use crate::cli::{filter_entries_for_cli_with_context, parse_preset, PackArgs};

/// Files above this size are never read for skeletons or symbol search.
const MAP_SKELETON_MAX_BYTES: u64 = 128 * 1024;
const MAP_SKELETON_MAX_FILES: usize = 15;
const SYMBOL_MAX_FILE_BYTES: u64 = 512 * 1024;
const SYMBOL_MAX_RESULTS: usize = 100;

/// Process-local index, so repeated MCP calls reuse the dependency graph built by earlier calls.
fn mcp_workspace_index() -> &'static WorkspaceIndex {
    static INDEX: OnceLock<WorkspaceIndex> = OnceLock::new();
    INDEX.get_or_init(WorkspaceIndex::default)
}

/// Serializes index use: each scan bumps a shared revision, and a concurrent scan would supersede it.
fn mcp_index_lock() -> MutexGuard<'static, ()> {
    static LOCK: Mutex<()> = Mutex::new(());
    LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn get_or_scan_snapshot(root: &Path) -> Result<Arc<WorkspaceSnapshot>, String> {
    let _index_guard = mcp_index_lock();
    let index = mcp_workspace_index();
    if let Some(current) = index.current_snapshot() {
        if current.root == root && index.get(root, current.revision).is_ok() {
            return Ok(current);
        }
    }
    index.scan(root)
}

pub(super) fn tool_definitions() -> Value {
    let read_only_annotations = json!({
        "readOnlyHint": true,
        "destructiveHint": false,
        "idempotentHint": true,
        "openWorldHint": false
    });

    json!([
        {
            "name": "ptt_get_project_map",
            "description": "Returns the ignore-aware directory tree, token estimates per file, and optional AST skeletons of key modules.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "directory": {
                        "type": "string",
                        "description": "Optional project root directory (defaults to server working directory)."
                    },
                    "include_skeletons": {
                        "type": "boolean",
                        "description": "Include AST skeletons of top source modules (default: true)."
                    }
                },
                "additionalProperties": false
            },
            "annotations": read_only_annotations
        },
        {
            "name": "ptt_pack_files",
            "description": "Packs requested files (or the whole repository) into LLM-ready XML/Markdown/JSON respecting .gitignore, .pttignore, and secret redaction.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "directory": {
                        "type": "string",
                        "description": "Optional project root directory."
                    },
                    "paths": {
                        "type": "array",
                        "items": { "type": "string" },
                        "description": "Relative file or directory paths to pack. If omitted or empty, packs all clean files."
                    },
                    "pinned_paths": {
                        "type": "array",
                        "items": { "type": "string" },
                        "description": "Relative file paths that must never be dropped when fitting to max_tokens."
                    },
                    "include": {
                        "type": "array",
                        "items": { "type": "string" },
                        "description": "Include only paths matching these glob patterns."
                    },
                    "exclude": {
                        "type": "array",
                        "items": { "type": "string" },
                        "description": "Exclude paths matching these glob patterns."
                    },
                    "git_modified": {
                        "type": "boolean",
                        "description": "Keep only files modified in the working tree."
                    },
                    "git_branch": {
                        "type": "boolean",
                        "description": "Keep only files changed from the base branch."
                    },
                    "skeleton": {
                        "type": "boolean",
                        "description": "Pack files in AST Skeleton mode (signatures & types only)."
                    },
                    "format": {
                        "type": "string",
                        "enum": ["xml", "markdown", "json", "plain"],
                        "description": "Output format (default: xml)."
                    },
                    "preset": {
                        "type": "string",
                        "enum": ["source", "docs", "all"],
                        "description": "Keep only source files, source and docs, or every file (default: all)."
                    },
                    "max_tokens": {
                        "type": "integer",
                        "minimum": 1,
                        "description": "Fit the pack within this many tokens (exact BPE count). Files are skeletonized or dropped by priority."
                    },
                    "git_diff": {
                        "type": "boolean",
                        "description": "Append the unified git diff as <git_diff> (default: false)."
                    },
                    "tokenizer": {
                        "type": "string",
                        "enum": ["o200k_base", "cl100k_base", "claude", "gemini"],
                        "description": "Tokenizer model for BPE token counting (default: o200k_base)."
                    },
                    "prompt": {
                        "type": "string",
                        "description": "Optional task instructions appended inside <task_instructions> at the end of the pack."
                    }
                },
                "additionalProperties": false
            },
            "annotations": read_only_annotations
        },
        {
            "name": "ptt_get_git_context",
            "description": "Returns modified/untracked files, branch changes, recent commits, and the unified git diff.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "directory": {
                        "type": "string",
                        "description": "Optional project root directory."
                    }
                },
                "additionalProperties": false
            },
            "annotations": read_only_annotations
        },
        {
            "name": "ptt_get_related_files",
            "description": "Returns the 1-hop imports, importers, and matching tests of one file, from the project's dependency graph.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "Relative path of the file, for example src/core/git.rs."
                    },
                    "directory": {
                        "type": "string",
                        "description": "Optional project root directory inside the server's project root."
                    }
                },
                "required": ["path"],
                "additionalProperties": false
            },
            "annotations": read_only_annotations
        },
        {
            "name": "ptt_search_symbols",
            "description": "Finds functions, methods, types, classes, interfaces, or traits whose name contains the query (case-insensitive) and returns each definition's exact source with its line range.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "Substring of the symbol name, for example compute or Config."
                    },
                    "paths": {
                        "type": "array",
                        "items": { "type": "string" },
                        "description": "Optional relative files or directories to limit the search to."
                    },
                    "directory": {
                        "type": "string",
                        "description": "Optional project root directory inside the server's project root."
                    }
                },
                "required": ["query"],
                "additionalProperties": false
            },
            "annotations": read_only_annotations
        }
    ])
}

/// Validates tool arguments against the declared JSON schema before dispatching.
pub(super) fn validate_tool_arguments(tool_name: &str, args: &Value) -> Result<(), String> {
    let Some(obj) = args.as_object() else {
        return Err("arguments must be a JSON object".into());
    };
    let check_known = |allowed: &[&str]| -> Result<(), String> {
        for key in obj.keys() {
            if !allowed.contains(&key.as_str()) {
                return Err(format!("unknown argument '{key}' for tool {tool_name}"));
            }
        }
        Ok(())
    };
    let check_opt_str = |key: &str| -> Result<(), String> {
        if let Some(v) = obj.get(key) {
            if !v.is_null() && !v.is_string() {
                return Err(format!("argument '{key}' must be a string"));
            }
        }
        Ok(())
    };
    let check_opt_bool = |key: &str| -> Result<(), String> {
        if let Some(v) = obj.get(key) {
            if !v.is_null() && !v.is_boolean() {
                return Err(format!("argument '{key}' must be a boolean"));
            }
        }
        Ok(())
    };
    let check_opt_str_array = |key: &str| -> Result<(), String> {
        if let Some(v) = obj.get(key) {
            if !v.is_null() {
                let Some(arr) = v.as_array() else {
                    return Err(format!("argument '{key}' must be an array of strings"));
                };
                if !arr.iter().all(Value::is_string) {
                    return Err(format!("argument '{key}' must contain only strings"));
                }
            }
        }
        Ok(())
    };

    match tool_name {
        "ptt_get_project_map" => {
            check_known(&["directory", "include_skeletons"])?;
            check_opt_str("directory")?;
            check_opt_bool("include_skeletons")?;
        }
        "ptt_pack_files" => {
            check_known(&[
                "directory",
                "paths",
                "pinned_paths",
                "include",
                "exclude",
                "git_modified",
                "git_branch",
                "skeleton",
                "format",
                "preset",
                "max_tokens",
                "git_diff",
                "tokenizer",
                "prompt",
            ])?;
            check_opt_str("directory")?;
            check_opt_str_array("paths")?;
            check_opt_str_array("pinned_paths")?;
            check_opt_str_array("include")?;
            check_opt_str_array("exclude")?;
            check_opt_bool("git_modified")?;
            check_opt_bool("git_branch")?;
            check_opt_bool("skeleton")?;
            check_opt_str("format")?;
            check_opt_str("preset")?;
            check_opt_bool("git_diff")?;
            check_opt_str("tokenizer")?;
            check_opt_str("prompt")?;
            if let Some(v) = obj.get("max_tokens") {
                if !v.is_null() && v.as_u64().is_none_or(|n| n == 0) {
                    return Err("argument 'max_tokens' must be a positive integer".into());
                }
            }
            if let Some(v) = obj.get("tokenizer").and_then(Value::as_str) {
                TokenizerModel::try_parse(v)?;
            }
        }
        "ptt_get_git_context" => {
            check_known(&["directory"])?;
            check_opt_str("directory")?;
        }
        "ptt_get_related_files" => {
            check_known(&["path", "directory"])?;
            check_opt_str("directory")?;
            match obj.get("path").and_then(Value::as_str).map(str::trim) {
                Some(s) if !s.is_empty() => {}
                _ => return Err("required argument 'path' must be a non-empty string".into()),
            }
        }
        "ptt_search_symbols" => {
            check_known(&["query", "paths", "directory"])?;
            check_opt_str("directory")?;
            check_opt_str_array("paths")?;
            match obj.get("query").and_then(Value::as_str).map(str::trim) {
                Some(s) if !s.is_empty() => {}
                _ => return Err("required argument 'query' must be a non-empty string".into()),
            }
        }
        _ => {}
    }
    Ok(())
}

/// Resolves the project root for a tool call. The server's `default_root` is the sandbox:
/// a requested directory must stay inside it, including through symlinks.
fn resolve_root(args: &Value, default_root: &Path) -> Result<PathBuf, String> {
    let canon_default = default_root.canonicalize().map_err(|e| {
        format!(
            "cannot canonicalize project root {}: {e}",
            default_root.display()
        )
    })?;
    let requested = args
        .get("directory")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty() && *s != ".");
    let Some(requested) = requested else {
        return Ok(canon_default);
    };

    let resolved = if Path::new(requested).is_absolute() {
        Path::new(requested)
            .canonicalize()
            .map_err(|e| format!("cannot canonicalize directory {requested}: {e}"))?
    } else {
        resolve_under_canonical_root(&canon_default, requested)
            .map_err(|e| format!("directory {requested} is not accessible: {e}"))?
    };
    if !resolved.starts_with(&canon_default) {
        return Err(format!(
            "directory {requested} is outside the server's project root"
        ));
    }
    if !resolved.is_dir() {
        return Err(format!("{requested} is not a directory"));
    }
    Ok(resolved)
}

#[cfg(test)]
pub(super) fn dispatch_tool(
    name: &str,
    args: &Value,
    default_root: &Path,
) -> Result<String, String> {
    dispatch_tool_cancellable(name, args, default_root, Arc::new(AtomicBool::new(false)))
}

pub(super) fn dispatch_tool_cancellable(
    name: &str,
    args: &Value,
    default_root: &Path,
    cancelled: Arc<AtomicBool>,
) -> Result<String, String> {
    let root = resolve_root(args, default_root)?;
    match name {
        "ptt_get_project_map" => {
            let include_skeletons = args
                .get("include_skeletons")
                .and_then(Value::as_bool)
                .unwrap_or(true);
            let snapshot = get_or_scan_snapshot(&root)?;
            let files: Vec<_> = snapshot.entries.iter().filter(|e| !e.is_dir).collect();

            let mut out = String::new();
            out.push_str(&format!(
                "# Project Map ({} files)\n\n## Directory Tree & Token Estimates\n",
                files.len()
            ));
            for f in &files {
                let rel = normalize_rel_path(&f.path);
                let size = f.size.unwrap_or(0);
                let tok = estimate_tokens_from_bytes(size);
                out.push_str(&format!("- `{rel}` (~{tok} tokens, {size} bytes)\n"));
            }

            if include_skeletons {
                out.push_str("\n## Key Module AST Skeletons\n");
                out.push_str("(exact BPE tokens: full file \u{2192} skeleton)\n");
                // Size is checked from metadata before any read. Core modules come first.
                let mut candidates: Vec<_> = files
                    .iter()
                    .filter(|f| language_for_path(&f.path) != "other")
                    .filter(|f| f.size.is_some_and(|s| s <= MAP_SKELETON_MAX_BYTES))
                    .copied()
                    .collect();
                candidates.sort_by_cached_key(|f| {
                    let rel = normalize_rel_path(&f.path);
                    (architectural_tier(&rel), rel)
                });
                for f in candidates.into_iter().take(MAP_SKELETON_MAX_FILES) {
                    if cancelled.load(Ordering::Relaxed) {
                        return Err("operation cancelled".into());
                    }
                    let rel = normalize_rel_path(&f.path);
                    let lang = language_for_path(&f.path);
                    let Ok(full) = resolve_under_canonical_root(&root, &rel) else {
                        continue;
                    };
                    let Ok(content) = read_verified_file_string(&full, MAP_SKELETON_MAX_BYTES)
                    else {
                        continue;
                    };
                    let redacted = redact_secrets(&content);
                    let skel = extract_skeleton(&redacted, lang);
                    out.push_str(&format!(
                        "\n### `{rel}` ({} \u{2192} {} tokens)\n```{lang}\n{skel}\n```\n",
                        count_tokens(&redacted),
                        count_tokens(&skel)
                    ));
                }
            }
            Ok(out)
        }
        "ptt_pack_files" => {
            let snapshot = get_or_scan_snapshot(&root)?;
            let requested: Vec<String> = args
                .get("paths")
                .and_then(Value::as_array)
                .map(|arr| {
                    arr.iter()
                        .filter_map(Value::as_str)
                        .map(|s| s.to_string())
                        .collect()
                })
                .unwrap_or_default();

            let pinned_paths: Vec<String> = args
                .get("pinned_paths")
                .and_then(Value::as_array)
                .map(|arr| {
                    arr.iter()
                        .filter_map(Value::as_str)
                        .map(|s| s.to_string())
                        .collect()
                })
                .unwrap_or_default();
            let pinned_set: HashSet<String> = pinned_paths
                .iter()
                .map(|p| normalize_rel_path(Path::new(p)))
                .collect();
            let include_globs = args
                .get("include")
                .and_then(Value::as_array)
                .map(|patterns| {
                    patterns
                        .iter()
                        .filter_map(Value::as_str)
                        .map(str::to_string)
                        .collect()
                })
                .unwrap_or_default();
            let exclude_globs = args
                .get("exclude")
                .and_then(Value::as_array)
                .map(|patterns| {
                    patterns
                        .iter()
                        .filter_map(Value::as_str)
                        .map(str::to_string)
                        .collect()
                })
                .unwrap_or_default();
            let git_modified = args
                .get("git_modified")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let git_branch = args
                .get("git_branch")
                .and_then(Value::as_bool)
                .unwrap_or(false);

            let selected_entries: Vec<_> = if requested.is_empty() {
                snapshot
                    .entries
                    .iter()
                    .filter(|e| !e.is_dir)
                    .cloned()
                    .collect()
            } else {
                snapshot.selected(&requested)
            };

            let skeleton = args
                .get("skeleton")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let format = match args
                .get("format")
                .and_then(Value::as_str)
                .unwrap_or("xml")
                .to_ascii_lowercase()
                .as_str()
            {
                "xml" => OutputFormat::Xml,
                "markdown" | "md" => OutputFormat::Markdown,
                "json" => OutputFormat::Json,
                "plain" | "txt" | "text" => OutputFormat::Plain,
                other => {
                    return Err(format!(
                        "unknown format '{other}' (use xml|markdown|json|plain)"
                    ))
                }
            };

            let preset = args
                .get("preset")
                .and_then(Value::as_str)
                .map(parse_preset)
                .transpose()?;
            let max_tokens = args
                .get("max_tokens")
                .and_then(Value::as_u64)
                .map(|n| usize::try_from(n).unwrap_or(usize::MAX));
            let git_diff = args
                .get("git_diff")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let tokenizer_model = match args.get("tokenizer").and_then(Value::as_str) {
                Some(s) => TokenizerModel::try_parse(s)?,
                None => TokenizerModel::O200kBase,
            };
            let task_prompt = args
                .get("prompt")
                .and_then(Value::as_str)
                .map(str::to_string)
                .filter(|s| !s.trim().is_empty());

            // Same selection as `ptt pack`: preset and the heuristic budget pass first.
            let pack_args = PackArgs {
                dir: root.clone(),
                preset,
                skeleton,
                max_tokens,
                pinned_paths,
                include_globs,
                exclude_globs,
                git_modified,
                git_branch,
                tokenizer_model,
                task_prompt: task_prompt.clone(),
                ..Default::default()
            };
            let (selected_entries, skeleton_files) = filter_entries_for_cli_with_context(
                selected_entries,
                &root,
                &pack_args,
                Some(&snapshot.git_context),
                Some(snapshot.dependency_graph()),
            )?;

            let computed_diff = if git_diff {
                compute_git_diff(&root, 256 * 1024)
            } else {
                None
            };

            let modified_files = snapshot
                .git_context
                .modified_files
                .iter()
                .cloned()
                .collect();

            let mut opts = WriteOptions {
                format,
                include_file_summary: true,
                max_file_size: DEFAULT_MAX_FILE_SIZE,
                redact_secrets: true,
                skeleton_all: skeleton,
                skeleton_files,
                git_diff: computed_diff,
                task_prompt,
                tokenizer_model,
                compute_bpe_tokens: true,
                modified_files,
            };

            let is_cancelled = {
                let c = Arc::clone(&cancelled);
                move || c.load(Ordering::Relaxed)
            };

            let mut buf = Vec::new();
            if let Some(budget) = max_tokens {
                let (entries, skeleton_files, workspace) = fit_workspace_to_bpe_budget(
                    selected_entries,
                    &root,
                    &opts,
                    budget,
                    &pinned_set,
                    Some(snapshot.dependency_graph()),
                    &is_cancelled,
                )?;
                opts.skeleton_files = skeleton_files;
                let _ = workspace
                    .render_with_stats(&mut buf, &entries, &opts.skeleton_files, opts.skeleton_all)
                    .map_err(|e| e.to_string())?;
            } else {
                let _ = write_output_with_stats(
                    &mut buf,
                    &selected_entries,
                    &root,
                    &opts,
                    &is_cancelled,
                )
                .map_err(|e| e.to_string())?;
            }
            String::from_utf8(buf).map_err(|e| e.to_string())
        }
        "ptt_get_git_context" => {
            let snapshot = get_or_scan_snapshot(&root)?;
            let ctx = &snapshot.git_context;
            let diff = compute_git_diff(&root, 256 * 1024).unwrap_or_default();
            let redacted_diff = redact_secrets(&diff);
            let summary = json!({
                "isGitRepo": ctx.is_git_repo,
                "currentBranch": ctx.current_branch,
                "baseBranch": ctx.base_branch,
                "modifiedFiles": ctx.modified_files,
                "branchChangedFiles": ctx.branch_changed_files,
                "recentCommits": ctx.recent_commits,
                "diff": redacted_diff,
            });
            serde_json::to_string_pretty(&summary).map_err(|e| e.to_string())
        }
        "ptt_get_related_files" => {
            let path = args
                .get("path")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .ok_or("ptt_get_related_files requires a non-empty `path`")?;
            let snapshot = get_or_scan_snapshot(&root)?;
            let normalized = normalize_rel_path(Path::new(path));
            if !snapshot
                .entries
                .iter()
                .any(|e| !e.is_dir && normalize_rel_path(&e.path) == normalized)
            {
                return Err(format!("file not found in project: {path}"));
            }
            let related = snapshot.dependency_graph().related_for(&normalized);
            serde_json::to_string_pretty(&related).map_err(|e| e.to_string())
        }
        "ptt_search_symbols" => {
            let query = args
                .get("query")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .ok_or("ptt_search_symbols requires a non-empty `query`")?;
            let requested: Vec<String> = args
                .get("paths")
                .and_then(Value::as_array)
                .map(|arr| {
                    arr.iter()
                        .filter_map(Value::as_str)
                        .map(str::to_string)
                        .collect()
                })
                .unwrap_or_default();
            let matcher = (!requested.is_empty()).then(|| SelectionMatcher::new(&requested));
            let snapshot = get_or_scan_snapshot(&root)?;
            let mut candidates: Vec<&ptt::core::walker::DirEntryMeta> = snapshot
                .entries
                .iter()
                .filter(|e| !e.is_dir)
                .filter(|e| language_for_path(&e.path) != "other")
                .filter(|e| matcher.as_ref().is_none_or(|m| m.is_selected(&e.path)))
                .filter(|e| e.size.is_none_or(|s| s <= SYMBOL_MAX_FILE_BYTES))
                .collect();
            // Architectural tiers first, so `src/` is searched and returned before tests and benchmarks.
            candidates.sort_by_cached_key(|e| {
                let rel = normalize_rel_path(&e.path);
                (architectural_tier(&rel), rel)
            });

            // Read and parse in parallel. The indexed collect keeps the tier order.
            let per_file: Vec<(String, Vec<SymbolMatch>)> = candidates
                .par_iter()
                .filter_map(|e| {
                    if cancelled.load(Ordering::Relaxed) {
                        return None;
                    }
                    let rel = normalize_rel_path(&e.path);
                    let lang = language_for_path(&e.path);
                    let full = resolve_under_canonical_root(&root, &rel).ok()?;
                    let raw = read_verified_file_string(&full, SYMBOL_MAX_FILE_BYTES).ok()?;
                    // Redact before parsing, so names and spans come from the masked text.
                    let content = redact_secrets(&raw).into_owned();
                    let hits = find_symbols(&content, lang, query);
                    (!hits.is_empty()).then_some((rel, hits))
                })
                .collect();

            if cancelled.load(Ordering::Relaxed) {
                return Err("operation cancelled".into());
            }

            let mut matches = Vec::new();
            let mut truncated = false;
            'files: for (rel, hits) in per_file {
                for hit in hits {
                    if matches.len() >= SYMBOL_MAX_RESULTS {
                        truncated = true;
                        break 'files;
                    }
                    matches.push(json!({
                        "path": rel,
                        "name": hit.name,
                        "kind": hit.kind,
                        "startLine": hit.start_line,
                        "endLine": hit.end_line,
                        "source": hit.source,
                    }));
                }
            }
            serde_json::to_string_pretty(&json!({
                "query": query,
                "truncated": truncated,
                "matches": matches,
            }))
            .map_err(|e| e.to_string())
        }
        other => Err(format!("Unknown MCP tool: {other}")),
    }
}
