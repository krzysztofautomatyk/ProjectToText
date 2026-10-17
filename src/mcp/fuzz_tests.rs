use super::*;
use std::fs;
use tempfile::tempdir;

/// Deterministic xorshift generator so the fuzz corpus is reproducible without a new dependency.
struct Rng(u64);

impl Rng {
    fn next_u64(&mut self) -> u64 {
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        self.0.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }

    fn below(&mut self, n: usize) -> usize {
        (self.next_u64() % n as u64) as usize
    }
}

#[test]
fn mcp_fuzzed_messages_never_panic_and_always_get_a_well_formed_reply() {
    const ALPHABET: &[u8] = b"{}[]\":,0123456789 \\\n\t\0-.eEtrufalsnul";
    let dir = tempdir().unwrap();
    fs::write(dir.path().join("lib.rs"), "pub fn f() {}\n").unwrap();
    let seeds = [
        r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25"}}"#,
        r#"{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}"#,
        r#"{"jsonrpc":"2.0","id":9003,"method":"tools/call","params":{"name":"ptt_search_symbols","arguments":{"query":"f"}}}"#,
        r#"{"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":9003}}"#,
    ];

    let mut rng = Rng(0x9E37_79B9_7F4A_7C15);
    let mut replies = 0usize;
    for i in 0..4000 {
        let mut bytes = seeds[i % seeds.len()].as_bytes().to_vec();
        for _ in 0..(1 + rng.below(6)) {
            match rng.below(4) {
                0 => {
                    let p = rng.below(bytes.len() + 1);
                    bytes.insert(p, ALPHABET[rng.below(ALPHABET.len())]);
                }
                1 if !bytes.is_empty() => {
                    let p = rng.below(bytes.len());
                    bytes.remove(p);
                }
                2 if !bytes.is_empty() => {
                    let p = rng.below(bytes.len());
                    bytes[p] = ALPHABET[rng.below(ALPHABET.len())];
                }
                _ => {
                    let cut = rng.below(bytes.len() + 1);
                    bytes.truncate(cut);
                }
            }
        }
        let raw = String::from_utf8_lossy(&bytes).into_owned();
        if let Some(reply) = handle_jsonrpc_message(&raw, dir.path()) {
            replies += 1;
            assert_eq!(reply["jsonrpc"], "2.0", "bad envelope for {raw:?}");
            let has_result = reply.get("result").is_some();
            let has_error = reply.get("error").is_some();
            assert!(
                has_result ^ has_error,
                "reply must carry exactly one of result/error: {reply} for {raw:?}"
            );
            if has_error {
                let code = reply["error"]["code"]
                    .as_i64()
                    .expect("error code must be an integer");
                assert!(
                    // -32800 is the server's own "request cancelled by client" reply.
                    matches!(code, -32700 | -32600 | -32601 | -32602 | -32603 | -32800),
                    "unexpected error code {code} for {raw:?}"
                );
            }
        }
    }
    assert!(
        replies > 1000,
        "fuzz corpus produced too few replies: {replies}"
    );
}

#[cfg(unix)]
#[test]
fn mcp_hostile_directory_arguments_are_refused_and_never_leak_outside_content() {
    let root = tempdir().unwrap();
    let outside = tempdir().unwrap();
    fs::write(
        outside.path().join("secret.rs"),
        "pub const OUTSIDE_SECRET_PAYLOAD: u8 = 1;\n",
    )
    .unwrap();
    fs::write(root.path().join("lib.rs"), "pub fn f() {}\n").unwrap();
    std::os::unix::fs::symlink(outside.path(), root.path().join("linked")).unwrap();
    let outside_name = outside
        .path()
        .file_name()
        .unwrap()
        .to_string_lossy()
        .into_owned();
    let hostile = [
        format!("../{outside_name}"),
        outside.path().display().to_string(),
        "linked".to_string(),
        "linked/secret.rs".to_string(),
        "../..".to_string(),
        "a/../../".to_string(),
        "\u{0}".to_string(),
        "a/".repeat(5000),
    ];
    for directory in hostile {
        let req = json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "tools/call",
            "params": {
                "name": "ptt_get_project_map",
                "arguments": { "directory": directory }
            }
        })
        .to_string();
        let reply =
            handle_jsonrpc_message(&req, root.path()).expect("tools/call always gets a reply");
        let refused = reply.get("error").is_some() || reply["result"]["isError"] == true;
        assert!(
            refused,
            "hostile directory was accepted: {directory:?} -> {reply}"
        );
        assert!(
            !reply.to_string().contains("OUTSIDE_SECRET_PAYLOAD"),
            "outside content leaked for {directory:?}"
        );
    }
}
