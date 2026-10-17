use super::tools::dispatch_tool;
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

    let packed = dispatch_tool("ptt_pack_files", &json!({"preset": "source"}), dir.path()).unwrap();
    assert!(packed.contains("shared_target"), "{packed}");
    assert!(
        !packed.contains("scratch notes"),
        "source preset kept notes.dat"
    );

    let budgeted = dispatch_tool(
        "ptt_pack_files",
        &json!({"max_tokens": 250, "git_diff": false}),
        dir.path(),
    )
    .unwrap();
    assert!(!budgeted.is_empty());
    assert!(
        dispatch_tool("ptt_pack_files", &json!({"max_tokens": 1}), dir.path()).is_err(),
        "impossible 1-token budget must return an explicit error instead of overflowing"
    );
    assert!(dispatch_tool("ptt_pack_files", &json!({"preset": "bogus"}), dir.path()).is_err());
}

#[test]
fn mcp_pack_files_supports_include_exclude_and_git_filters() {
    let dir = tempdir().unwrap();
    fs::create_dir_all(dir.path().join("src")).unwrap();
    fs::write(dir.path().join("src/keep.rs"), "pub fn keep() {}\n").unwrap();
    fs::write(dir.path().join("src/drop.rs"), "pub fn drop_me() {}\n").unwrap();
    fs::write(dir.path().join("notes.md"), "notes\n").unwrap();

    let filtered = call(
        "ptt_pack_files",
        json!({ "include": ["src/*.rs"], "exclude": ["*drop.rs"] }),
        dir.path(),
    );
    assert_eq!(filtered["result"]["isError"], false, "{filtered}");
    let text = filtered["result"]["content"][0]["text"].as_str().unwrap();
    assert!(text.contains("src/keep.rs"), "{text}");
    assert!(!text.contains("src/drop.rs"), "{text}");
    assert!(!text.contains("notes.md"), "{text}");

    let git_dir = tempdir().unwrap();
    let git = |args: &[&str]| {
        let output = std::process::Command::new("git")
            .args(args)
            .current_dir(git_dir.path())
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "git {args:?} failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        output
    };
    git(&["init"]);
    git(&["symbolic-ref", "HEAD", "refs/heads/main"]);
    git(&["config", "user.email", "ptt-test@example.com"]);
    git(&["config", "user.name", "PTT test"]);
    fs::create_dir_all(git_dir.path().join("src")).unwrap();
    fs::write(git_dir.path().join("src/base.rs"), "pub fn base() {}\n").unwrap();
    fs::write(
        git_dir.path().join("src/branch.rs"),
        "pub fn branch_v1() {}\n",
    )
    .unwrap();
    fs::write(
        git_dir.path().join("src/working.rs"),
        "pub fn working_v1() {}\n",
    )
    .unwrap();
    git(&["add", "."]);
    git(&["commit", "-m", "base"]);
    git(&["checkout", "-b", "feature"]);
    fs::write(
        git_dir.path().join("src/branch.rs"),
        "pub fn branch_v2() {}\n",
    )
    .unwrap();
    git(&["commit", "-am", "change branch file"]);
    fs::write(
        git_dir.path().join("src/working.rs"),
        "pub fn working_v2() {}\n",
    )
    .unwrap();

    let selected_paths = |filter: &str| {
        let mut args = serde_json::Map::new();
        args.insert("format".into(), json!("json"));
        args.insert(filter.into(), json!(true));
        let response = call("ptt_pack_files", Value::Object(args), git_dir.path());
        assert_eq!(response["result"]["isError"], false, "{response}");
        let text = response["result"]["content"][0]["text"].as_str().unwrap();
        let packed: Value = serde_json::from_str(text).unwrap();
        packed["files"]
            .as_array()
            .unwrap()
            .iter()
            .map(|file| file["path"].as_str().unwrap().to_string())
            .collect::<Vec<_>>()
    };
    let modified = selected_paths("git_modified");
    assert_eq!(modified, ["src/working.rs"]);
    let branch = selected_paths("git_branch");
    assert_eq!(branch, ["src/branch.rs", "src/working.rs"]);

    let definitions = super::tools::tool_definitions();
    let pack_schema = definitions
        .as_array()
        .unwrap()
        .iter()
        .find(|tool| tool["name"] == "ptt_pack_files")
        .unwrap();
    for (name, expected_type) in [
        ("include", "array"),
        ("exclude", "array"),
        ("git_modified", "boolean"),
        ("git_branch", "boolean"),
    ] {
        assert_eq!(
            pack_schema["inputSchema"]["properties"][name]["type"],
            expected_type
        );
    }

    let invalid = call("ptt_pack_files", json!({ "include": [false] }), dir.path());
    assert_eq!(invalid["error"]["code"], -32602, "{invalid}");
    let invalid = call(
        "ptt_pack_files",
        json!({ "git_modified": "yes" }),
        dir.path(),
    );
    assert_eq!(invalid["error"]["code"], -32602, "{invalid}");
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

#[test]
fn pending_cancellations_are_bounded_and_known_ids_refresh_in_place() {
    let mut set = HashSet::new();
    for i in 0..(MAX_PENDING_CANCELLATIONS * 3) {
        record_cancellation(&mut set, i.to_string());
    }
    assert_eq!(set.len(), MAX_PENDING_CANCELLATIONS);
    // A new id is dropped once the set is full.
    assert!(!record_cancellation(&mut set, "new-id".to_string()));
    assert_eq!(set.len(), MAX_PENDING_CANCELLATIONS);
    // An id already recorded can be re-recorded without growing the set.
    assert!(record_cancellation(&mut set, "0".to_string()));
    assert_eq!(set.len(), MAX_PENDING_CANCELLATIONS);
}

#[test]
fn mcp_negotiates_protocol_versions_and_validates_schemas_and_cancellation() {
    let dir = tempdir().unwrap();
    fs::write(dir.path().join("lib.rs"), "pub fn f() {}\n").unwrap();

    // 1. Version negotiation: supported revisions are echoed back exactly.
    for requested in ["2024-11-05", "2025-06-18", "2025-11-25"] {
        let req = json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": { "protocolVersion": requested }
        })
        .to_string();
        let resp = handle_jsonrpc_message(&req, dir.path()).unwrap();
        assert_eq!(resp["result"]["protocolVersion"], requested);
    }
    let unknown_ver = handle_jsonrpc_message(
            r#"{"jsonrpc":"2.0","id":2,"method":"initialize","params":{"protocolVersion":"1999-01-01"}}"#,
            dir.path(),
        )
        .unwrap();
    assert_eq!(
        unknown_ver["result"]["protocolVersion"],
        LATEST_MCP_PROTOCOL_VERSION
    );
    // 2026-07-28 is not implemented, so it must not be echoed back as supported.
    let unimplemented = handle_jsonrpc_message(
            r#"{"jsonrpc":"2.0","id":3,"method":"initialize","params":{"protocolVersion":"2026-07-28"}}"#,
            dir.path(),
        )
        .unwrap();
    assert_eq!(unimplemented["result"]["protocolVersion"], "2025-11-25");

    // 2. Strict JSON-RPC 2.0 envelope and schema validation (-32600 / -32602)
    let non_object = handle_jsonrpc_message("[1,2,3]", dir.path()).unwrap();
    assert_eq!(non_object["error"]["code"], -32600);

    let missing_jsonrpc =
        handle_jsonrpc_message(r#"{"id":1,"method":"ping"}"#, dir.path()).unwrap();
    assert_eq!(missing_jsonrpc["error"]["code"], -32600);

    let unknown_arg = call(
        "ptt_get_project_map",
        json!({ "unknown_field": true }),
        dir.path(),
    );
    assert_eq!(unknown_arg["error"]["code"], -32602, "{unknown_arg}");

    let wrong_type = call(
        "ptt_pack_files",
        json!({ "max_tokens": "not-a-number" }),
        dir.path(),
    );
    assert_eq!(wrong_type["error"]["code"], -32602, "{wrong_type}");

    let zero_budget = call("ptt_pack_files", json!({ "max_tokens": 0 }), dir.path());
    assert_eq!(zero_budget["error"]["code"], -32602, "{zero_budget}");

    // 3. Cancellation via `notifications/cancelled`
    assert!(handle_jsonrpc_message(
        r#"{"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":999}}"#,
        dir.path(),
    )
    .is_none());
    let cancelled = handle_jsonrpc_message(
        r#"{"jsonrpc":"2.0","id":999,"method":"tools/list","params":{}}"#,
        dir.path(),
    )
    .unwrap();
    assert_eq!(cancelled["error"]["code"], -32800, "{cancelled}");
}

#[test]
fn mcp_resources_and_tool_annotations() {
    let dir = tempdir().unwrap();
    fs::write(dir.path().join("main.rs"), "fn main() {}\n").unwrap();

    // 1. Verify initialize reports resources capability
    let init_resp = handle_jsonrpc_message(
        r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}"#,
        dir.path(),
    )
    .unwrap();
    assert_eq!(
        init_resp["result"]["capabilities"]["resources"]["listChanged"],
        false
    );

    // 2. Verify all tool definitions contain MCP 2025-11-25 annotations
    let list_resp = handle_jsonrpc_message(
        r#"{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}"#,
        dir.path(),
    )
    .unwrap();
    let tools = list_resp["result"]["tools"].as_array().unwrap();
    for tool in tools {
        let ann = &tool["annotations"];
        assert_eq!(ann["readOnlyHint"], true);
        assert_eq!(ann["destructiveHint"], false);
        assert_eq!(ann["idempotentHint"], true);
        assert_eq!(ann["openWorldHint"], false);
    }

    // 3. Verify resources/list returns ptt://project/map and ptt://project/git-diff
    let res_list = handle_jsonrpc_message(
        r#"{"jsonrpc":"2.0","id":3,"method":"resources/list","params":{}}"#,
        dir.path(),
    )
    .unwrap();
    let resources = res_list["result"]["resources"].as_array().unwrap();
    assert_eq!(resources.len(), 2);
    let uris: Vec<&str> = resources.iter().filter_map(|r| r["uri"].as_str()).collect();
    assert!(uris.contains(&"ptt://project/map"));
    assert!(uris.contains(&"ptt://project/git-diff"));

    // 4. Verify resources/read reads ptt://project/map as text/markdown
    let res_read = handle_jsonrpc_message(
        r#"{"jsonrpc":"2.0","id":4,"method":"resources/read","params":{"uri":"ptt://project/map"}}"#,
        dir.path(),
    )
    .unwrap();
    let contents = res_read["result"]["contents"].as_array().unwrap();
    assert_eq!(contents.len(), 1);
    assert_eq!(contents[0]["uri"], "ptt://project/map");
    assert_eq!(contents[0]["mimeType"], "text/markdown");
    assert!(contents[0]["text"]
        .as_str()
        .unwrap()
        .contains("Project Map"));

    // 5. Verify resources/read reads ptt://project/git-diff as application/json
    let res_read_diff = handle_jsonrpc_message(
        r#"{"jsonrpc":"2.0","id":5,"method":"resources/read","params":{"uri":"ptt://project/git-diff"}}"#,
        dir.path(),
    )
    .unwrap();
    let contents_diff = res_read_diff["result"]["contents"].as_array().unwrap();
    assert_eq!(contents_diff.len(), 1);
    assert_eq!(contents_diff[0]["uri"], "ptt://project/git-diff");
    assert_eq!(contents_diff[0]["mimeType"], "application/json");
}

#[test]
fn mcp_prompts_list_and_get() {
    let dir = tempdir().unwrap();
    fs::create_dir_all(dir.path().join("src")).unwrap();
    fs::write(
        dir.path().join("src/lib.rs"),
        "pub fn core_logic() -> &'static str {\n    \"proscada\"\n}\n",
    )
    .unwrap();

    // 1. Verify initialize reports prompts capability
    let init_resp = handle_jsonrpc_message(
        r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}"#,
        dir.path(),
    )
    .unwrap();
    assert_eq!(
        init_resp["result"]["capabilities"]["prompts"]["listChanged"],
        false
    );

    // 2. Verify prompts/list returns the 3 standard engineering prompts
    let list_resp = handle_jsonrpc_message(
        r#"{"jsonrpc":"2.0","id":2,"method":"prompts/list","params":{}}"#,
        dir.path(),
    )
    .unwrap();
    let prompts = list_resp["result"]["prompts"].as_array().unwrap();
    assert_eq!(prompts.len(), 3);
    let names: Vec<&str> = prompts.iter().filter_map(|p| p["name"].as_str()).collect();
    assert_eq!(
        names,
        vec!["architecture_review", "security_audit", "git_diff_review"]
    );

    // 3. Verify prompts/get for architecture_review (with and without focus_path)
    let arch_get = handle_jsonrpc_message(
        r#"{"jsonrpc":"2.0","id":3,"method":"prompts/get","params":{"name":"architecture_review","arguments":{"focus_path":"src/lib.rs"}}}"#,
        dir.path(),
    )
    .unwrap();
    assert_eq!(
        arch_get["result"]["description"],
        "Deep architectural, modularity, and dependency-graph review of the repository"
    );
    let arch_text = arch_get["result"]["messages"][0]["content"]["text"]
        .as_str()
        .unwrap();
    assert!(arch_text.contains("Architecture & Dependency-Graph Review Request"));
    assert!(arch_text.contains("src/lib.rs"));
    assert!(arch_text.contains("core_logic"));

    // 4. Verify prompts/get for security_audit
    let sec_get = handle_jsonrpc_message(
        r#"{"jsonrpc":"2.0","id":4,"method":"prompts/get","params":{"name":"security_audit"}}"#,
        dir.path(),
    )
    .unwrap();
    let sec_text = sec_get["result"]["messages"][0]["content"]["text"]
        .as_str()
        .unwrap();
    assert!(sec_text.contains("Security & Secret-Exposure Audit Request"));
    assert!(sec_text.contains("Path traversal & sandboxing"));

    // 5. Verify prompts/get for git_diff_review
    let git_get = handle_jsonrpc_message(
        r#"{"jsonrpc":"2.0","id":5,"method":"prompts/get","params":{"name":"git_diff_review"}}"#,
        dir.path(),
    )
    .unwrap();
    let git_text = git_get["result"]["messages"][0]["content"]["text"]
        .as_str()
        .unwrap();
    assert!(git_text.contains("Pre-Merge Git Diff Review Request"));

    // 6. Verify error handling for missing name and unknown prompt
    let missing_name = handle_jsonrpc_message(
        r#"{"jsonrpc":"2.0","id":6,"method":"prompts/get","params":{}}"#,
        dir.path(),
    )
    .unwrap();
    assert_eq!(missing_name["error"]["code"], -32602);

    let unknown_prompt = handle_jsonrpc_message(
        r#"{"jsonrpc":"2.0","id":7,"method":"prompts/get","params":{"name":"non_existent"}}"#,
        dir.path(),
    )
    .unwrap();
    assert_eq!(unknown_prompt["error"]["code"], -32602);
}

#[test]
fn mcp_pack_files_supports_pinned_paths_and_budget() {
    let dir = tempdir().unwrap();
    fs::create_dir_all(dir.path().join("src")).unwrap();
    fs::write(
        dir.path().join("src/pinned.rs"),
        "pub fn pinned_fn() -> usize { 42 }\n",
    )
    .unwrap();
    fs::write(
        dir.path().join("src/drop_me.rs"),
        (0..100)
            .map(|i| format!("pub fn filler_{i}() -> usize {{ {i} }}\n"))
            .collect::<String>(),
    )
    .unwrap();

    let req = json!({
        "jsonrpc": "2.0",
        "id": 10,
        "method": "tools/call",
        "params": {
            "name": "ptt_pack_files",
            "arguments": {
                "pinned_paths": ["src/pinned.rs"],
                "max_tokens": 500
            }
        }
    })
    .to_string();

    let resp = handle_jsonrpc_message(&req, dir.path()).unwrap();
    assert_eq!(resp["result"]["isError"], false, "{resp}");
    let text = resp["result"]["content"][0]["text"].as_str().unwrap();
    assert!(
        text.contains("pinned.rs"),
        "pinned file must be preserved: {text}"
    );
    assert!(
        !text.contains("drop_me.rs"),
        "non-pinned file must be dropped: {text}"
    );
}

#[test]
fn mcp_pack_files_accepts_tokenizer_and_prompt() {
    let dir = tempdir().unwrap();
    fs::create_dir_all(dir.path().join("src")).unwrap();
    fs::write(
        dir.path().join("src/lib.rs"),
        "pub fn core_logic() -> &'static str { \"valid\" }\n",
    )
    .unwrap();

    let req = json!({
        "jsonrpc": "2.0",
        "id": 11,
        "method": "tools/call",
        "params": {
            "name": "ptt_pack_files",
            "arguments": {
                "paths": ["src/lib.rs"],
                "tokenizer": "claude",
                "prompt": "Review this module"
            }
        }
    })
    .to_string();

    let resp = handle_jsonrpc_message(&req, dir.path()).unwrap();
    assert_eq!(resp["result"]["isError"], false, "{resp}");
    let text = resp["result"]["content"][0]["text"].as_str().unwrap();
    assert!(text.contains("src/lib.rs"), "{text}");
    assert!(text.contains("<task_instructions>"), "{text}");
    assert!(text.contains("Review this module"), "{text}");

    // Invalid tokenizer must be rejected
    let invalid_req = json!({
        "jsonrpc": "2.0",
        "id": 12,
        "method": "tools/call",
        "params": {
            "name": "ptt_pack_files",
            "arguments": {
                "tokenizer": "invalid_model"
            }
        }
    })
    .to_string();
    let invalid_resp = handle_jsonrpc_message(&invalid_req, dir.path()).unwrap();
    assert_eq!(invalid_resp["error"]["code"], -32602, "{invalid_resp}");

    // Also verify get_git_context works cleanly via snapshot
    let git_req = json!({
        "jsonrpc": "2.0",
        "id": 13,
        "method": "tools/call",
        "params": {
            "name": "ptt_get_git_context",
            "arguments": {}
        }
    })
    .to_string();
    let git_resp = handle_jsonrpc_message(&git_req, dir.path()).unwrap();
    assert_eq!(git_resp["result"]["isError"], false, "{git_resp}");
}
