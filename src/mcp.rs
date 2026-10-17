//! Built-in Model Context Protocol (MCP) Server (`ptt mcp [DIR]`).
//!
//! Implements JSON-RPC 2.0 over `stdio` so AI assistants (Claude Desktop, Claude Code,
//! Cursor, Zed, etc.) can dynamically inspect and pack the repository while honoring
//! `.gitignore`, `.pttignore`, path sandboxing, AST skeletonization, and secret redaction.

use std::collections::{HashMap, HashSet};
use std::io::{self, BufRead, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use serde_json::{json, Value};

mod workers;
use workers::tool_workers;

mod tools;
use tools::{dispatch_tool_cancellable, tool_definitions, validate_tool_arguments};

#[cfg(test)]
mod fuzz_tests;
#[cfg(test)]
mod tests;

/// Supported MCP protocol revisions in descending preference order.
/// Per MCP Lifecycle specification: if the client requests a version the server supports,
/// the server responds with that exact version; otherwise it responds with its latest
/// supported version so the client can decide whether to proceed or disconnect.
///
/// `2026-07-28` is deliberately NOT listed. That revision removes the `initialize` handshake
/// and requires `server/discover`, per-request `_meta` protocol versions, and `resultType`.
/// This server implements the handshake lifecycle only, so it must not claim that revision.
pub const SUPPORTED_MCP_VERSIONS: &[&str] = &["2025-11-25", "2025-06-18", "2024-11-05"];
const DEFAULT_MCP_PROTOCOL_VERSION: &str = "2024-11-05";
const LATEST_MCP_PROTOCOL_VERSION: &str = "2025-11-25";
/// Maximum bytes accepted in a single stdio JSON-RPC line (4 MiB) to prevent memory exhaustion.
const MAX_STDIN_MESSAGE_BYTES: usize = 4 * 1024 * 1024;
/// Maximum UTF-8 bytes returned by a single MCP tool call (8 MiB).
const MAX_TOOL_OUTPUT_BYTES: usize = 8 * 1024 * 1024;

/// Tracks request IDs cancelled via `notifications/cancelled`.
fn cancelled_requests() -> &'static Mutex<HashSet<String>> {
    static CANCELLED: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    CANCELLED.get_or_init(|| Mutex::new(HashSet::new()))
}

/// Tracks currently active workers so `notifications/cancelled` can immediately signal them.
fn active_workers() -> &'static Mutex<HashMap<String, Arc<AtomicBool>>> {
    static ACTIVE: OnceLock<Mutex<HashMap<String, Arc<AtomicBool>>>> = OnceLock::new();
    ACTIVE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Upper bound on cancellations recorded for requests that have not arrived yet. Untrusted clients
/// can send any number of `notifications/cancelled`, so the set must not grow without limit.
const MAX_PENDING_CANCELLATIONS: usize = 1024;

/// Records a cancelled request id. Returns `false` when the set is full and the id is new; the
/// cancellation is then dropped, which only means that request runs to completion.
fn record_cancellation(set: &mut HashSet<String>, key: String) -> bool {
    if set.len() >= MAX_PENDING_CANCELLATIONS && !set.contains(&key) {
        return false;
    }
    set.insert(key);
    true
}

fn negotiate_protocol_version(requested: Option<&str>) -> &'static str {
    let Some(req) = requested.map(str::trim).filter(|s| !s.is_empty()) else {
        return DEFAULT_MCP_PROTOCOL_VERSION;
    };
    for &supported in SUPPORTED_MCP_VERSIONS {
        if supported == req {
            return supported;
        }
    }
    LATEST_MCP_PROTOCOL_VERSION
}

pub fn run_mcp_stdio(default_root: PathBuf) -> Result<(), String> {
    let stdin = io::stdin();
    let stdout = io::stdout();
    let mut reader = stdin.lock();
    let mut writer = stdout.lock();

    let mut buf = Vec::new();
    loop {
        buf.clear();
        let bytes = (&mut reader)
            .take((MAX_STDIN_MESSAGE_BYTES + 1) as u64)
            .read_until(b'\n', &mut buf)
            .map_err(|e| format!("failed to read stdin: {e}"))?;
        if bytes == 0 {
            break;
        }
        if buf.len() > MAX_STDIN_MESSAGE_BYTES && !buf.ends_with(b"\n") {
            // Drain remainder of oversized line so the stream stays aligned
            let mut sink = [0u8; 4096];
            loop {
                match reader.read(&mut sink) {
                    Ok(0) => break,
                    Ok(n) if sink[..n].contains(&b'\n') => break,
                    Ok(_) => continue,
                    Err(_) => break,
                }
            }
            let err_resp = json!({
                "jsonrpc": "2.0",
                "id": Value::Null,
                "error": {
                    "code": -32600,
                    "message": format!("Invalid Request: message exceeds maximum size of {MAX_STDIN_MESSAGE_BYTES} bytes")
                }
            });
            let serialized = serde_json::to_string(&err_resp).map_err(|e| e.to_string())?;
            writeln!(writer, "{serialized}").map_err(|e| format!("write stdout error: {e}"))?;
            writer
                .flush()
                .map_err(|e| format!("flush stdout error: {e}"))?;
            continue;
        }
        let line = match std::str::from_utf8(&buf) {
            Ok(s) => s.trim(),
            Err(e) => {
                let err_resp = json!({
                    "jsonrpc": "2.0",
                    "id": Value::Null,
                    "error": {
                        "code": -32700,
                        "message": format!("Parse error: invalid UTF-8: {e}")
                    }
                });
                let serialized = serde_json::to_string(&err_resp).map_err(|e| e.to_string())?;
                writeln!(writer, "{serialized}").map_err(|e| format!("write stdout error: {e}"))?;
                writer
                    .flush()
                    .map_err(|e| format!("flush stdout error: {e}"))?;
                continue;
            }
        };
        if line.is_empty() {
            continue;
        }
        if let Some(response) = handle_jsonrpc_message(line, &default_root) {
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
    if raw.len() > MAX_STDIN_MESSAGE_BYTES {
        return Some(json!({
            "jsonrpc": "2.0",
            "id": Value::Null,
            "error": {
                "code": -32600,
                "message": format!("Invalid Request: message exceeds maximum size of {MAX_STDIN_MESSAGE_BYTES} bytes")
            }
        }));
    }

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

    let Some(obj) = parsed.as_object() else {
        return Some(json!({
            "jsonrpc": "2.0",
            "id": Value::Null,
            "error": {
                "code": -32600,
                "message": "Invalid Request: expected JSON object"
            }
        }));
    };

    let id = obj.get("id").cloned();
    if obj.get("jsonrpc").and_then(Value::as_str) != Some("2.0") {
        return Some(json!({
            "jsonrpc": "2.0",
            "id": id.unwrap_or(Value::Null),
            "error": {
                "code": -32600,
                "message": "Invalid Request: missing or invalid \"jsonrpc\": \"2.0\""
            }
        }));
    }

    let Some(method) = obj.get("method").and_then(Value::as_str) else {
        return Some(json!({
            "jsonrpc": "2.0",
            "id": id.unwrap_or(Value::Null),
            "error": {
                "code": -32600,
                "message": "Invalid Request: missing string \"method\""
            }
        }));
    };

    let params = obj.get("params").cloned().unwrap_or_else(|| json!({}));

    if method == "notifications/cancelled" {
        if let Some(req_id) = params.get("requestId") {
            let key = req_id.to_string();
            if let Ok(running) = active_workers().lock() {
                if let Some(flag) = running.get(&key) {
                    flag.store(true, Ordering::SeqCst);
                }
            }
            if let Ok(mut set) = cancelled_requests().lock() {
                record_cancellation(&mut set, key);
            }
        }
        return None;
    }

    // Notifications (no `id`) do not expect a response
    if id.is_none() || method.starts_with("notifications/") {
        return None;
    }
    let id = id.unwrap_or(Value::Null);

    // If this request ID was previously cancelled, skip execution cleanly.
    let id_key = id.to_string();
    if let Ok(mut set) = cancelled_requests().lock() {
        if set.remove(&id_key) {
            return Some(json!({
                "jsonrpc": "2.0",
                "id": id,
                "error": {
                    "code": -32800,
                    "message": "Request cancelled by client"
                }
            }));
        }
    }

    match method {
        "initialize" => {
            let requested_version = params.get("protocolVersion").and_then(Value::as_str);
            let negotiated = negotiate_protocol_version(requested_version);
            Some(json!({
                "jsonrpc": "2.0",
                "id": id,
                "result": {
                    "protocolVersion": negotiated,
                    "capabilities": {
                        "tools": {
                            "listChanged": false
                        },
                        "resources": {
                            "subscribe": false,
                            "listChanged": false
                        },
                        "prompts": {
                            "listChanged": false
                        }
                    },
                    "serverInfo": {
                        "name": "ptt-mcp",
                        "version": env!("CARGO_PKG_VERSION")
                    }
                }
            }))
        }
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
            let Some(params_obj) = params.as_object() else {
                return Some(json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "error": {
                        "code": -32602,
                        "message": "Invalid params: expected object for tools/call"
                    }
                }));
            };
            let Some(tool_name) = params_obj
                .get("name")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
            else {
                return Some(json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "error": {
                        "code": -32602,
                        "message": "Invalid params: missing string \"name\" for tools/call"
                    }
                }));
            };
            let args = match params_obj.get("arguments") {
                None | Some(Value::Null) => json!({}),
                Some(v @ Value::Object(_)) => v.clone(),
                Some(_) => {
                    return Some(json!({
                        "jsonrpc": "2.0",
                        "id": id,
                        "error": {
                            "code": -32602,
                            "message": "Invalid params: \"arguments\" must be a JSON object"
                        }
                    }));
                }
            };
            if let Err(param_err) = validate_tool_arguments(tool_name, &args) {
                return Some(json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "error": {
                        "code": -32602,
                        "message": format!("Invalid params: {param_err}")
                    }
                }));
            }
            let cancel_flag = Arc::new(AtomicBool::new(false));
            if let Ok(mut active) = active_workers().lock() {
                active.insert(id_key.clone(), Arc::clone(&cancel_flag));
            }
            let work = {
                let name = tool_name.to_string();
                let args = args.clone();
                let root = default_root.to_path_buf();
                let cancel_worker = Arc::clone(&cancel_flag);
                move || dispatch_tool_cancellable(&name, &args, &root, cancel_worker)
            };
            let run_res =
                tool_workers().run_cancellable(MCP_TOOL_TIME_LIMIT, Arc::clone(&cancel_flag), work);
            if let Ok(mut active) = active_workers().lock() {
                active.remove(&id_key);
            }
            match run_res {
                Ok(mut text) => {
                    if text.len() > MAX_TOOL_OUTPUT_BYTES {
                        let mut cut = MAX_TOOL_OUTPUT_BYTES;
                        while cut > 0 && !text.is_char_boundary(cut) {
                            cut -= 1;
                        }
                        text.truncate(cut);
                        text.push_str("\n...[output truncated at 8 MiB MCP safety cap]...");
                    }
                    Some(json!({
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
                    }))
                }
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
        "resources/list" => Some(json!({
            "jsonrpc": "2.0",
            "id": id,
            "result": {
                "resources": [
                    {
                        "uri": "ptt://project/map",
                        "name": "Project Map",
                        "description": "Ignore-aware directory tree with token estimates and AST skeleton of key files",
                        "mimeType": "text/markdown"
                    },
                    {
                        "uri": "ptt://project/git-diff",
                        "name": "Git Diff Context",
                        "description": "Working tree git status badges and unified git diff",
                        "mimeType": "application/json"
                    }
                ]
            }
        })),
        "resources/read" => {
            let Some(params_obj) = params.as_object() else {
                return Some(json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "error": {
                        "code": -32602,
                        "message": "Invalid params: expected object for resources/read"
                    }
                }));
            };
            let Some(uri) = params_obj.get("uri").and_then(Value::as_str) else {
                return Some(json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "error": {
                        "code": -32602,
                        "message": "Invalid params: missing string \"uri\" for resources/read"
                    }
                }));
            };

            let mime = if uri == "ptt://project/map" {
                "text/markdown"
            } else if uri == "ptt://project/git-diff" {
                "application/json"
            } else {
                "text/plain"
            };

            let cancel_flag = Arc::new(AtomicBool::new(false));
            if let Ok(mut active) = active_workers().lock() {
                active.insert(id_key.clone(), Arc::clone(&cancel_flag));
            }

            let work = {
                let uri = uri.to_string();
                let root = default_root.to_path_buf();
                let cancel_worker = Arc::clone(&cancel_flag);
                move || match uri.as_str() {
                    "ptt://project/map" => dispatch_tool_cancellable(
                        "ptt_get_project_map",
                        &json!({}),
                        &root,
                        cancel_worker,
                    ),
                    "ptt://project/git-diff" => dispatch_tool_cancellable(
                        "ptt_get_git_context",
                        &json!({}),
                        &root,
                        cancel_worker,
                    ),
                    _ => Err(format!("Resource not found: {uri}")),
                }
            };

            let run_res =
                tool_workers().run_cancellable(MCP_TOOL_TIME_LIMIT, Arc::clone(&cancel_flag), work);

            if let Ok(mut active) = active_workers().lock() {
                active.remove(&id_key);
            }

            match run_res {
                Ok(text) => Some(json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "result": {
                        "contents": [
                            {
                                "uri": uri,
                                "mimeType": mime,
                                "text": text
                            }
                        ]
                    }
                })),
                Err(err) => Some(json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "error": {
                        "code": -32602,
                        "message": err
                    }
                })),
            }
        }
        "prompts/list" => Some(json!({
            "jsonrpc": "2.0",
            "id": id,
            "result": {
                "prompts": [
                    {
                        "name": "architecture_review",
                        "description": "Deep architectural, modularity, and dependency-graph review of the repository",
                        "arguments": [
                            {
                                "name": "focus_path",
                                "description": "Optional file or module path to focus the architecture review on.",
                                "required": false
                            }
                        ]
                    },
                    {
                        "name": "security_audit",
                        "description": "Security, path-sandbox, and secret-exposure audit of the codebase",
                        "arguments": [
                            {
                                "name": "directory",
                                "description": "Optional subdirectory or module to audit.",
                                "required": false
                            }
                        ]
                    },
                    {
                        "name": "git_diff_review",
                        "description": "Pre-merge code review of current working tree changes and git diff",
                        "arguments": []
                    }
                ]
            }
        })),
        "prompts/get" => {
            let Some(params_obj) = params.as_object() else {
                return Some(json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "error": {
                        "code": -32602,
                        "message": "Invalid params: expected object for prompts/get"
                    }
                }));
            };
            let Some(prompt_name) = params_obj
                .get("name")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
            else {
                return Some(json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "error": {
                        "code": -32602,
                        "message": "Invalid params: missing string \"name\" for prompts/get"
                    }
                }));
            };
            let prompt_args = match params_obj.get("arguments") {
                None | Some(Value::Null) => json!({}),
                Some(v @ Value::Object(_)) => v.clone(),
                Some(_) => {
                    return Some(json!({
                        "jsonrpc": "2.0",
                        "id": id,
                        "error": {
                            "code": -32602,
                            "message": "Invalid params: \"arguments\" must be a JSON object"
                        }
                    }));
                }
            };

            let description = match prompt_name {
                "architecture_review" => {
                    "Deep architectural, modularity, and dependency-graph review of the repository"
                }
                "security_audit" => {
                    "Security, path-sandbox, and secret-exposure audit of the codebase"
                }
                "git_diff_review" => {
                    "Pre-merge code review of current working tree changes and git diff"
                }
                other => {
                    return Some(json!({
                        "jsonrpc": "2.0",
                        "id": id,
                        "error": {
                            "code": -32602,
                            "message": format!("Prompt not found: {other}")
                        }
                    }));
                }
            };

            let cancel_flag = Arc::new(AtomicBool::new(false));
            if let Ok(mut active) = active_workers().lock() {
                active.insert(id_key.clone(), Arc::clone(&cancel_flag));
            }

            let work = {
                let name = prompt_name.to_string();
                let args = prompt_args.clone();
                let root = default_root.to_path_buf();
                let cancel_worker = Arc::clone(&cancel_flag);
                move || generate_prompt_text(&name, &args, &root, cancel_worker)
            };

            let run_res =
                tool_workers().run_cancellable(MCP_TOOL_TIME_LIMIT, Arc::clone(&cancel_flag), work);

            if let Ok(mut active) = active_workers().lock() {
                active.remove(&id_key);
            }

            match run_res {
                Ok(text) => Some(json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "result": {
                        "description": description,
                        "messages": [
                            {
                                "role": "user",
                                "content": {
                                    "type": "text",
                                    "text": text
                                }
                            }
                        ]
                    }
                })),
                Err(err) => Some(json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "error": {
                        "code": -32602,
                        "message": err
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

fn generate_prompt_text(
    name: &str,
    args: &Value,
    root: &Path,
    cancelled: Arc<AtomicBool>,
) -> Result<String, String> {
    match name {
        "architecture_review" => {
            let focus_path = args
                .get("focus_path")
                .and_then(Value::as_str)
                .map(str::trim);
            let map = dispatch_tool_cancellable(
                "ptt_get_project_map",
                &json!({ "include_skeletons": true }),
                root,
                Arc::clone(&cancelled),
            )?;
            let mut text = String::from(
                "# Architecture & Dependency-Graph Review Request\n\n\
                 You are a Principal Systems Architect performing a deep architectural review of this repository.\n\n\
                 ## Review Goals\n\
                 1. Analyze architectural tiers and modular decoupling across packages and modules.\n\
                 2. Identify potential circular dependencies, tight coupling, and boundary leaks.\n\
                 3. Review error propagation and system invariants for fail-closed behavior.\n\
                 4. Suggest structural refactorings to improve cohesion and testability.\n\n",
            );
            if let Some(focus) = focus_path.filter(|s| !s.is_empty()) {
                text.push_str(&format!(
                    "## Review Focus\nFocused file/module: `{focus}`\n\n"
                ));
                if let Ok(rel) = dispatch_tool_cancellable(
                    "ptt_get_related_files",
                    &json!({ "path": focus }),
                    root,
                    Arc::clone(&cancelled),
                ) {
                    text.push_str(&format!("### Related Dependencies (1-hop imports, importers, tests)\n```json\n{rel}\n```\n\n"));
                }
            }
            text.push_str("## Repository Structure & Module Skeletons\n\n");
            text.push_str(&map);
            Ok(text)
        }
        "security_audit" => {
            let directory = args.get("directory").and_then(Value::as_str).map(str::trim);
            let tool_args = if let Some(dir) = directory.filter(|s| !s.is_empty()) {
                json!({ "directory": dir, "include_skeletons": true })
            } else {
                json!({ "include_skeletons": true })
            };
            let map = dispatch_tool_cancellable(
                "ptt_get_project_map",
                &tool_args,
                root,
                Arc::clone(&cancelled),
            )?;
            let mut text = String::from(
                "# Security & Secret-Exposure Audit Request\n\n\
                 You are a Principal Security Architect performing a security audit of this codebase.\n\n\
                 ## Audit Scope\n\
                 1. Path traversal & sandboxing: verify canonical root enforcement, symlink handling, and path normalization.\n\
                 2. Secret detection & credential hygiene: review secret redaction rules, API key exposure, and sanitization in logs/artifacts.\n\
                 3. Denial of Service (DoS) protections: review input size caps, regex backtracking safety, and token budget limits.\n\
                 4. Supply-chain & memory safety: review unsafe boundaries, dependency trust, and untrusted archive/input processing.\n\n",
            );
            if let Some(dir) = directory.filter(|s| !s.is_empty()) {
                text.push_str(&format!("Audit scope restricted to directory: `{dir}`\n\n"));
            }
            text.push_str("## Codebase Skeletons & Map\n\n");
            text.push_str(&map);
            Ok(text)
        }
        "git_diff_review" => {
            let git_ctx = dispatch_tool_cancellable(
                "ptt_get_git_context",
                &json!({}),
                root,
                Arc::clone(&cancelled),
            )?;
            let text = format!(
                "# Pre-Merge Git Diff Review Request\n\n\
                 You are a Principal Software Engineer performing a rigorous pre-merge code review of the current working tree changes.\n\n\
                 ## Review Checklist\n\
                 1. Logic correctness, edge cases, and off-by-one errors.\n\
                 2. Adherence to architectural invariants and backward compatibility.\n\
                 3. Performance implications: zero-waste I/O, allocation pressure, and concurrency safety.\n\
                 4. Test coverage for new features, regression guards, and error cases.\n\n\
                 ## Working Tree Git Context & Diff\n\n\
                 {git_ctx}"
            );
            Ok(text)
        }
        other => Err(format!("Prompt not found: {other}")),
    }
}

/// Upper bound on one tool call's wall-clock time as seen by the client.
const MCP_TOOL_TIME_LIMIT: std::time::Duration = std::time::Duration::from_secs(30);
