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
