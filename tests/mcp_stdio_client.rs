//! Drives the built `ptt mcp` binary over stdio the way an MCP client does: handshake,
//! `tools/list`, then one call to every advertised tool with valid arguments. It checks that
//! stdout carries only protocol JSON, stderr stays empty, and every tool answers without an error.

use serde_json::{json, Value};
use std::{
    fs,
    io::Write,
    process::{Command, Stdio},
};

const EXPECTED_TOOLS: [&str; 5] = [
    "ptt_get_project_map",
    "ptt_pack_files",
    "ptt_get_git_context",
    "ptt_get_related_files",
    "ptt_search_symbols",
];

fn tool_text(reply: &Value) -> &str {
    reply["result"]["content"][0]["text"]
        .as_str()
        .unwrap_or_default()
}

#[test]
fn every_advertised_tool_answers_over_stdio_with_a_clean_protocol_stream() {
    let dir = tempfile::tempdir().unwrap();
    fs::create_dir_all(dir.path().join("src")).unwrap();
    fs::write(
        dir.path().join("src/lib.rs"),
        "pub fn entry_point(x: u32) -> u32 {\n    x + 1\n}\n",
    )
    .unwrap();

    let mut child = Command::new(env!("CARGO_BIN_EXE_ptt"))
        .args(["mcp", dir.path().to_str().unwrap()])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn ptt mcp");

    let calls: [(u64, &str, Value); 5] = [
        (3, "ptt_get_project_map", json!({})),
        (4, "ptt_pack_files", json!({ "max_tokens": 20000 })),
        (5, "ptt_get_git_context", json!({})),
        (6, "ptt_get_related_files", json!({ "path": "src/lib.rs" })),
        (7, "ptt_search_symbols", json!({ "query": "entry_point" })),
    ];
    let mut requests = vec![
        json!({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
            "protocolVersion": "2025-11-25",
            "capabilities": {},
            "clientInfo": {"name": "ptt-stdio-test", "version": "0"}
        }}),
        json!({"jsonrpc": "2.0", "method": "notifications/initialized", "params": {}}),
        json!({"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}}),
    ];
    for (id, name, arguments) in &calls {
        requests.push(json!({"jsonrpc": "2.0", "id": id, "method": "tools/call",
            "params": {"name": name, "arguments": arguments}}));
    }
    requests.push(json!({"jsonrpc": "2.0", "id": 8, "method": "resources/list", "params": {}}));
    requests.push(json!({"jsonrpc": "2.0", "id": 9, "method": "resources/read", "params": {"uri": "ptt://project/map"}}));
    requests.push(json!({"jsonrpc": "2.0", "id": 10, "method": "prompts/list", "params": {}}));
    requests.push(json!({"jsonrpc": "2.0", "id": 11, "method": "prompts/get", "params": {"name": "architecture_review", "arguments": {"focus_path": "src/lib.rs"}}}));
    {
        let stdin = child.stdin.as_mut().unwrap();
        for request in &requests {
            writeln!(stdin, "{request}").unwrap();
        }
    }

    let output = child.wait_with_output().unwrap();
    let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
    assert!(
        output.status.success(),
        "ptt mcp exited with an error; stderr: {stderr}"
    );
    assert!(
        stderr.is_empty(),
        "stdout must carry protocol only; stderr had: {stderr}"
    );

    let stdout = String::from_utf8(output.stdout).unwrap();
    let responses: Vec<Value> = stdout
        .lines()
        .filter(|line| !line.trim().is_empty())
        .map(|line| {
            serde_json::from_str(line)
                .unwrap_or_else(|e| panic!("non-JSON stdout line {line:?}: {e}"))
        })
        .collect();
    // One reply per request; the `notifications/initialized` notification gets none.
    assert_eq!(responses.len(), 11, "unexpected reply count:\n{stdout}");
    let reply_for = |id: u64| {
        responses
            .iter()
            .find(|r| r["id"] == json!(id))
            .unwrap_or_else(|| panic!("no reply for request {id}:\n{stdout}"))
    };

    let init = reply_for(1);
    assert_eq!(init["result"]["protocolVersion"], "2025-11-25");
    assert_eq!(init["result"]["serverInfo"]["name"], "ptt-mcp");

    let advertised: Vec<&str> = reply_for(2)["result"]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|tool| tool["name"].as_str().unwrap())
        .collect();
    assert_eq!(advertised, EXPECTED_TOOLS, "advertised tool list changed");

    for (id, name, _) in &calls {
        assert!(advertised.contains(name), "{name} is not advertised");
        let reply = reply_for(*id);
        assert!(
            reply.get("error").is_none(),
            "{name} returned a protocol error: {reply}"
        );
        assert_ne!(
            reply["result"]["isError"],
            json!(true),
            "{name} failed: {reply}"
        );
        assert!(
            !tool_text(reply).is_empty(),
            "{name} returned empty content: {reply}"
        );
    }

    // Content checks: each tool returns what it promises for this fixture.
    assert!(
        tool_text(reply_for(4)).contains("entry_point"),
        "pack omitted the fixture source"
    );
    assert!(
        tool_text(reply_for(7)).contains("entry_point"),
        "symbol search missed entry_point"
    );
    let git: Value =
        serde_json::from_str(tool_text(reply_for(5))).expect("git context must be JSON text");
    assert!(
        git.get("isGitRepo").is_some(),
        "git context lacks isGitRepo: {git}"
    );

    // Resources and prompts checks over stdio
    assert_eq!(
        reply_for(8)["result"]["resources"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    assert!(reply_for(9)["result"]["contents"][0]["text"]
        .as_str()
        .unwrap()
        .contains("Project Map"));
    assert_eq!(
        reply_for(10)["result"]["prompts"].as_array().unwrap().len(),
        3
    );
    assert!(reply_for(11)["result"]["messages"][0]["content"]["text"]
        .as_str()
        .unwrap()
        .contains("entry_point"));
}
