//! Built-in Model Context Protocol (MCP) Server (`ptt mcp [DIR]`).
//!
//! Implements JSON-RPC 2.0 over `stdio` so AI assistants (Claude Desktop, Claude Code,
//! Cursor, Zed, etc.) can dynamically inspect and pack the repository while honoring
//! `.gitignore`, `.pttignore`, path sandboxing, AST skeletonization, and secret redaction.

use std::io::{self, BufRead, Write};
use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use ptt::core::deps::DependencyGraph;
use ptt::core::git::{compute_git_diff, inspect_git_context};
use ptt::core::output::{
    architectural_tier, write_output_with_stats, OutputFormat, WriteOptions, DEFAULT_MAX_FILE_SIZE,
};
use ptt::core::preview::resolve_under_canonical_root;
use ptt::core::secrets::redact_secrets;
use rayon::prelude::*;

use ptt::core::skeleton::{extract_skeleton, find_symbols, language_for_path, SymbolMatch};
use ptt::core::tokenizer::{count_tokens, estimate_tokens_from_bytes, TokenizerModel};
use ptt::core::walker::{normalize_rel_path, walk, SelectionMatcher};

use crate::cli::{filter_entries_for_cli, fit_to_bpe_budget, parse_preset, PackArgs};

const MCP_PROTOCOL_VERSION: &str = "2024-11-05";
/// Files above this size are never read for skeletons or symbol search.
const MAP_SKELETON_MAX_BYTES: u64 = 128 * 1024;
const MAP_SKELETON_MAX_FILES: usize = 15;
const SYMBOL_MAX_FILE_BYTES: u64 = 512 * 1024;
const SYMBOL_MAX_RESULTS: usize = 100;

pub fn run_mcp_stdio(default_root: PathBuf) -> Result<(), String> {
    let stdin = io::stdin();
    let stdout = io::stdout();
    let mut reader = stdin.lock();
    let mut writer = stdout.lock();

    let mut line = String::new();
    loop {
        line.clear();
        let bytes = reader
            .read_line(&mut line)
            .map_err(|e| format!("failed to read stdin: {e}"))?;
        if bytes == 0 {
            break;
        }
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        if let Some(response) = handle_jsonrpc_message(trimmed, &default_root) {
            let serialized =
                serde_json::to_string(&response).map_err(|e| format!("serialize error: {e}"))?;
            writeln!(writer, "{serialized}").map_err(|e| format!("write stdout error: {e}"))?;
            writer
                .flush()
                .map_err(|e| format!("flush stdout error: {e}"))?;
        }
    }
    Ok(())
}

pub fn handle_jsonrpc_message(raw: &str, default_root: &Path) -> Option<Value> {
    let parsed: Value = match serde_json::from_str(raw) {
        Ok(v) => v,
        Err(e) => {
            return Some(json!({
                "jsonrpc": "2.0",
                "id": Value::Null,
                "error": {
                    "code": -32700,
                    "message": format!("Parse error: {e}")
                }
            }));
        }
    };

    let id = parsed.get("id").cloned();
    let method = parsed.get("method").and_then(Value::as_str).unwrap_or("");
    let params = parsed.get("params").cloned().unwrap_or_else(|| json!({}));

    // Notifications (no `id`) do not expect a response
    if id.is_none() || method.starts_with("notifications/") {
        return None;
    }
    let id = id.unwrap_or(Value::Null);

    match method {
        "initialize" => Some(json!({
            "jsonrpc": "2.0",
            "id": id,
            "result": {
                "protocolVersion": MCP_PROTOCOL_VERSION,
                "capabilities": {
                    "tools": {}
                },
                "serverInfo": {
                    "name": "ptt-mcp",
                    "version": env!("CARGO_PKG_VERSION")
                }
            }
        })),
        "ping" => Some(json!({
            "jsonrpc": "2.0",
            "id": id,
            "result": {}
        })),
        "tools/list" => Some(json!({
            "jsonrpc": "2.0",
            "id": id,
            "result": {
                "tools": tool_definitions()
            }
        })),
        "tools/call" => {
            let tool_name = params.get("name").and_then(Value::as_str).unwrap_or("");
            let args = params
                .get("arguments")
                .cloned()
                .unwrap_or_else(|| json!({}));
            match dispatch_tool(tool_name, &args, default_root) {
                Ok(text) => Some(json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "result": {
                        "content": [
                            {
                                "type": "text",
                                "text": text
                            }
                        ],
                        "isError": false
                    }
                })),
                Err(err) => Some(json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "result": {
                        "content": [
                            {
                                "type": "text",
                                "text": format!("Error: {err}")
                            }
                        ],
                        "isError": true
                    }
                })),
            }
        }
        other => Some(json!({
            "jsonrpc": "2.0",
            "id": id,
            "error": {
                "code": -32601,
                "message": format!("Method not found: {other}")
            }
        })),
    }
}

fn tool_definitions() -> Value {
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
                }
            }
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
                    }
                }
            }
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
                }
            }
        }
        ,
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
                "required": ["path"]
            }
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
                "required": ["query"]
            }
        }
    ])
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

fn dispatch_tool(name: &str, args: &Value, default_root: &Path) -> Result<String, String> {
    let root = resolve_root(args, default_root)?;
    match name {
        "ptt_get_project_map" => {
            let include_skeletons = args
                .get("include_skeletons")
                .and_then(Value::as_bool)
                .unwrap_or(true);
            let entries = walk(&root).map_err(|e| e.to_string())?;
            let files: Vec<_> = entries.iter().filter(|e| !e.is_dir).collect();

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
                    .collect();
                candidates.sort_by_cached_key(|f| {
                    let rel = normalize_rel_path(&f.path);
                    (architectural_tier(&rel), rel)
                });
                for f in candidates.into_iter().take(MAP_SKELETON_MAX_FILES) {
                    let rel = normalize_rel_path(&f.path);
                    let lang = language_for_path(&f.path);
                    let Ok(full) = resolve_under_canonical_root(&root, &rel) else {
                        continue;
                    };
                    let Ok(content) = std::fs::read_to_string(&full) else {
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
            let entries = walk(&root).map_err(|e| e.to_string())?;
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

            let selected_entries: Vec<_> = if requested.is_empty() {
                entries.into_iter().filter(|e| !e.is_dir).collect()
            } else {
                let matcher = ptt::core::walker::SelectionMatcher::new(&requested);
                entries
                    .into_iter()
                    .filter(|e| !e.is_dir && matcher.is_selected(&e.path))
                    .collect()
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
                "markdown" | "md" => OutputFormat::Markdown,
                "json" => OutputFormat::Json,
                "plain" | "txt" => OutputFormat::Plain,
                _ => OutputFormat::Xml,
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

            // Same selection as `ptt pack`: preset and the heuristic budget pass first.
            let pack_args = PackArgs {
                dir: root.clone(),
                preset,
                skeleton,
                max_tokens,
                ..Default::default()
            };
            let (selected_entries, skeleton_files) =
                filter_entries_for_cli(selected_entries, &root, &pack_args)?;

            let mut opts = WriteOptions {
                format,
                include_file_summary: true,
                max_file_size: DEFAULT_MAX_FILE_SIZE,
                redact_secrets: true,
                skeleton_all: skeleton,
                skeleton_files,
                git_diff: None,
                task_prompt: None,
                tokenizer_model: TokenizerModel::O200kBase,
                compute_bpe_tokens: true,
            };

            // The exact BPE fit runs last, because it needs the final options.
            let selected_entries = match max_tokens {
                Some(budget) => {
                    let (entries, skeleton_files) =
                        fit_to_bpe_budget(selected_entries, &root, &opts, budget)?;
                    opts.skeleton_files = skeleton_files;
                    entries
                }
                None => selected_entries,
            };
            if git_diff {
                opts.git_diff = compute_git_diff(&root, 256 * 1024);
            }

            let mut buf = Vec::new();
            let _ = write_output_with_stats(&mut buf, &selected_entries, &root, &opts, &|| false)
                .map_err(|e| e.to_string())?;
            String::from_utf8(buf).map_err(|e| e.to_string())
        }
        "ptt_get_git_context" => {
            let ctx = inspect_git_context(&root);
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
            let entries = walk(&root).map_err(|e| e.to_string())?;
            let normalized = normalize_rel_path(Path::new(path));
            if !entries
                .iter()
                .any(|e| !e.is_dir && normalize_rel_path(&e.path) == normalized)
            {
                return Err(format!("file not found in project: {path}"));
            }
            let graph = DependencyGraph::build(&root, &entries);
            serde_json::to_string_pretty(&graph.related_for(&normalized)).map_err(|e| e.to_string())
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
            let entries = walk(&root).map_err(|e| e.to_string())?;
            let mut candidates: Vec<&ptt::core::walker::DirEntryMeta> = entries
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
                    let rel = normalize_rel_path(&e.path);
                    let lang = language_for_path(&e.path);
                    let full = resolve_under_canonical_root(&root, &rel).ok()?;
                    let raw = std::fs::read_to_string(&full).ok()?;
                    // Redact before parsing, so names and spans come from the masked text.
                    let content = redact_secrets(&raw).into_owned();
                    let hits = find_symbols(&content, lang, query);
                    (!hits.is_empty()).then_some((rel, hits))
                })
                .collect();

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

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    #[test]
    fn mcp_initialize_and_tools_work() {
        let dir = tempdir().unwrap();
        fs::write(
            dir.path().join("lib.rs"),
            "pub fn greet(name: &str) -> String {\n    let msg = format!(\"hi {name}\");\n    msg\n}\n",
        )
        .unwrap();

        let init_resp = handle_jsonrpc_message(
            r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}"#,
            dir.path(),
        )
        .unwrap();
        assert_eq!(init_resp["result"]["serverInfo"]["name"], "ptt-mcp");

        let list_resp = handle_jsonrpc_message(
            r#"{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}"#,
            dir.path(),
        )
        .unwrap();
        let tools = list_resp["result"]["tools"].as_array().unwrap();
        assert_eq!(tools.len(), 5);

        let map_resp = handle_jsonrpc_message(
            r#"{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"ptt_get_project_map","arguments":{}}}"#,
            dir.path(),
        )
        .unwrap();
        let map_text = map_resp["result"]["content"][0]["text"].as_str().unwrap();
        assert!(map_text.contains("lib.rs"), "{map_text}");
        assert!(map_text.contains("pub fn greet"), "{map_text}");

        let pack_resp = handle_jsonrpc_message(
            r#"{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"ptt_pack_files","arguments":{"paths":["lib.rs"],"skeleton":true}}}"#,
            dir.path(),
        )
        .unwrap();
        let pack_text = pack_resp["result"]["content"][0]["text"].as_str().unwrap();
        assert!(pack_text.contains("mode=\"skeleton\""), "{pack_text}");
        assert!(pack_text.contains("{ /* ... */ }"), "{pack_text}");
    }

    fn call(name: &str, args: Value, root: &Path) -> Value {
        let req = json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "tools/call",
            "params": { "name": name, "arguments": args }
        })
        .to_string();
        handle_jsonrpc_message(&req, root).unwrap()
    }

    #[test]
    fn mcp_rejects_directories_outside_the_project_root() {
        let root = tempdir().unwrap();
        let outside = tempdir().unwrap();
        fs::write(outside.path().join("secret.rs"), "pub fn leaked() {}\n").unwrap();

        let absolute = call(
            "ptt_get_project_map",
            json!({ "directory": outside.path().to_string_lossy() }),
            root.path(),
        );
        assert_eq!(absolute["result"]["isError"], true, "{absolute}");
        let text = absolute["result"]["content"][0]["text"].as_str().unwrap();
        assert!(!text.contains("leaked"), "{text}");

        let traversal = call(
            "ptt_pack_files",
            json!({ "directory": "../../.." }),
            root.path(),
        );
        assert_eq!(traversal["result"]["isError"], true, "{traversal}");
    }

    #[test]
    fn mcp_symbol_search_returns_src_first_and_pack_accepts_new_params() {
        let dir = tempdir().unwrap();
        fs::create_dir_all(dir.path().join("src")).unwrap();
        fs::create_dir_all(dir.path().join("tests")).unwrap();
        fs::write(
            dir.path().join("src/lib.rs"),
            "pub fn shared_target() -> u8 {\n    1\n}\n",
        )
        .unwrap();
        fs::write(
            dir.path().join("tests/a_test.rs"),
            "fn shared_target_check() -> u8 {\n    2\n}\n",
        )
        .unwrap();
        // `.dat` is neither a source nor a doc extension, so the source preset must drop it.
        fs::write(dir.path().join("notes.dat"), "# scratch notes\n").unwrap();

        let found = dispatch_tool(
            "ptt_search_symbols",
            &json!({"query": "shared_target"}),
            dir.path(),
        )
        .unwrap();
        let value: Value = serde_json::from_str(&found).unwrap();
        let paths: Vec<&str> = value["matches"]
            .as_array()
            .unwrap()
            .iter()
            .map(|m| m["path"].as_str().unwrap())
            .collect();
        assert_eq!(paths, vec!["src/lib.rs", "tests/a_test.rs"]);

        let packed =
            dispatch_tool("ptt_pack_files", &json!({"preset": "source"}), dir.path()).unwrap();
        assert!(packed.contains("shared_target"), "{packed}");
        assert!(
            !packed.contains("scratch notes"),
            "source preset kept notes.dat"
        );

        let budgeted = dispatch_tool(
            "ptt_pack_files",
            &json!({"max_tokens": 1, "git_diff": false}),
            dir.path(),
        )
        .unwrap();
        assert!(!budgeted.is_empty());
        assert!(dispatch_tool("ptt_pack_files", &json!({"preset": "bogus"}), dir.path()).is_err());
    }

    #[test]
    fn mcp_search_symbols_and_related_files() {
        let dir = tempdir().unwrap();
        fs::create_dir_all(dir.path().join("src")).unwrap();
        fs::write(dir.path().join("src/lib.rs"), "pub mod util;\n").unwrap();
        fs::write(
            dir.path().join("src/util.rs"),
            "pub fn helper_value() -> u32 {\n    42\n}\n",
        )
        .unwrap();

        let search = call(
            "ptt_search_symbols",
            json!({ "query": "helper" }),
            dir.path(),
        );
        let text = search["result"]["content"][0]["text"].as_str().unwrap();
        assert!(text.contains("\"name\": \"helper_value\""), "{text}");
        assert!(text.contains("\"startLine\": 1"), "{text}");
        assert!(text.contains("\"endLine\": 3"), "{text}");

        let related = call(
            "ptt_get_related_files",
            json!({ "path": "src/lib.rs" }),
            dir.path(),
        );
        let text = related["result"]["content"][0]["text"].as_str().unwrap();
        assert!(text.contains("src/util.rs"), "{text}");

        let missing = call(
            "ptt_get_related_files",
            json!({ "path": "src/nope.rs" }),
            dir.path(),
        );
        assert_eq!(missing["result"]["isError"], true, "{missing}");
    }
}
