//! Built-in Model Context Protocol (MCP) Server (`ptt mcp [DIR]`).
//!
//! Implements JSON-RPC 2.0 over `stdio` so AI assistants (Claude Desktop, Claude Code,
//! Cursor, Zed, etc.) can dynamically inspect and pack the repository while honoring
//! `.gitignore`, `.pttignore`, path sandboxing, AST skeletonization, and secret redaction.

use std::collections::HashSet;
use std::io::{self, BufRead, Write};
use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use ptt::core::git::{compute_git_diff, inspect_git_context};
use ptt::core::output::{
    write_output_with_stats, OutputFormat, WriteOptions, DEFAULT_MAX_FILE_SIZE,
};
use ptt::core::preview::resolve_under_canonical_root;
use ptt::core::secrets::redact_secrets;
use ptt::core::skeleton::{extract_skeleton, language_for_path};
use ptt::core::tokenizer::{estimate_tokens_from_bytes, TokenizerModel};
use ptt::core::walker::{normalize_rel_path, walk};

const MCP_PROTOCOL_VERSION: &str = "2024-11-05";

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
    ])
}

fn resolve_root(args: &Value, default_root: &Path) -> Result<PathBuf, String> {
    let dir = args
        .get("directory")
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| default_root.to_path_buf());
    dir.canonicalize()
        .map_err(|e| format!("cannot canonicalize directory {}: {e}", dir.display()))
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
                let mut count = 0usize;
                for f in &files {
                    if count >= 15 {
                        break;
                    }
                    let lang = language_for_path(&f.path);
                    if lang == "other" {
                        continue;
                    }
                    let rel = normalize_rel_path(&f.path);
                    if let Ok(full) = resolve_under_canonical_root(&root, &rel) {
                        if let Ok(content) = std::fs::read_to_string(&full) {
                            if content.len() <= 128 * 1024 {
                                let redacted = redact_secrets(&content);
                                let skel = extract_skeleton(&redacted, lang);
                                out.push_str(&format!("\n### `{rel}`\n```{lang}\n{skel}\n```\n"));
                                count += 1;
                            }
                        }
                    }
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

            let opts = WriteOptions {
                format,
                include_file_summary: true,
                max_file_size: DEFAULT_MAX_FILE_SIZE,
                redact_secrets: true,
                skeleton_all: skeleton,
                skeleton_files: HashSet::new(),
                git_diff: None,
                task_prompt: None,
                tokenizer_model: TokenizerModel::O200kBase,
                compute_bpe_tokens: true,
            };

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
        assert_eq!(tools.len(), 3);

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
}
