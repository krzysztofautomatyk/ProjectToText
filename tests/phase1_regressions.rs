use ptt::{
    load_preview, resolve_under_root, walk, write_output, write_output_cancellable, DirEntryMeta,
    OutputFormat, WriteOptions,
};
use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
};

fn init_git(root: &Path) {
    assert!(Command::new("git")
        .args(["init", "--quiet"])
        .current_dir(root)
        .status()
        .unwrap()
        .success());
}

fn files(root: &Path) -> Vec<PathBuf> {
    walk(root)
        .unwrap()
        .into_iter()
        .filter(|e| !e.is_dir)
        .map(|e| e.path)
        .collect()
}

fn pack(root: &Path, paths: &[&str], format: OutputFormat) -> String {
    let entries = paths
        .iter()
        .map(|p| DirEntryMeta {
            path: PathBuf::from(p),
            is_dir: false,
            size: None,
        })
        .collect::<Vec<_>>();
    let mut output = Vec::new();
    write_output(
        &mut output,
        &entries,
        root,
        &WriteOptions {
            format,
            ..Default::default()
        },
    )
    .unwrap();
    String::from_utf8(output).unwrap()
}

#[test]
fn git_directory_ignore_excludes_descendants() {
    let dir = tempfile::tempdir().unwrap();
    init_git(dir.path());
    fs::create_dir_all(dir.path().join("secrets/nested")).unwrap();
    fs::write(dir.path().join("secrets/nested/key.pem"), "SECRET").unwrap();
    fs::write(
        dir.path().join(".pttignore"),
        "secrets/\n!secrets/nested/key.pem\n",
    )
    .unwrap();
    assert!(!files(dir.path()).contains(&PathBuf::from("secrets/nested/key.pem")));
}

#[test]
fn git_nested_ignore_and_override_are_scoped() {
    let dir = tempfile::tempdir().unwrap();
    init_git(dir.path());
    fs::create_dir(dir.path().join("src")).unwrap();
    fs::create_dir(dir.path().join("other")).unwrap();
    fs::write(dir.path().join(".pttignore"), "*.log\n").unwrap();
    fs::write(
        dir.path().join("src/.pttignore"),
        "!keep.log\nprivate.txt\n",
    )
    .unwrap();
    for path in [
        "src/keep.log",
        "src/private.txt",
        "other/keep.log",
        "other/private.txt",
    ] {
        fs::write(dir.path().join(path), "data").unwrap();
    }
    let paths = files(dir.path());
    assert!(paths.contains(&PathBuf::from("src/keep.log")));
    assert!(!paths.contains(&PathBuf::from("src/private.txt")));
    assert!(!paths.contains(&PathBuf::from("other/keep.log")));
    assert!(paths.contains(&PathBuf::from("other/private.txt")));
}

#[test]
fn nested_rules_match_git_and_fallback_with_parent_pruning() {
    let dir = tempfile::tempdir().unwrap();
    fs::create_dir_all(dir.path().join("src/private")).unwrap();
    fs::write(dir.path().join(".pttignore"), "*.log\nblocked/\n").unwrap();
    fs::write(
        dir.path().join("src/.pttignore"),
        "!keep.log\nprivate/\n!private/key.txt\n",
    )
    .unwrap();
    fs::create_dir_all(dir.path().join("blocked")).unwrap();
    for path in [
        "src/keep.log",
        "src/noise.log",
        "src/private/key.txt",
        "blocked/key.txt",
        "normal.rs",
    ] {
        fs::write(dir.path().join(path), "fixture").unwrap();
    }
    let fallback = files(dir.path());
    init_git(dir.path());
    let git = files(dir.path());
    assert_eq!(fallback, git);
    assert!(git.contains(&PathBuf::from("src/keep.log")));
    assert!(!git.contains(&PathBuf::from("src/private/key.txt")));
    assert!(!git.contains(&PathBuf::from("blocked/key.txt")));
}

#[test]
fn selection_matcher_agrees_with_reference() {
    use ptt::core::walker::{path_is_selected, SelectionMatcher};
    let selected = vec!["src/".into(), "docs\\guide.md".into(), ".github".into()];
    let matcher = SelectionMatcher::new(&selected);
    for path in [
        "src/main.rs",
        "src2/main.rs",
        "docs/guide.md",
        "docs/other.md",
        ".github/workflows/ci.yml",
    ] {
        assert_eq!(
            matcher.is_selected(Path::new(path)),
            selected
                .iter()
                .any(|item| path_is_selected(Path::new(path), item)),
            "{path}"
        );
    }
    assert!(matcher.is_selected(Path::new("docs/guide.md")));
    assert!(!SelectionMatcher::new(&["".into()]).is_selected(Path::new("src/main.rs")));
}

#[cfg(windows)]
#[test]
fn windows_junction_is_not_a_project_file() {
    let dir = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    fs::write(outside.path().join("secret.txt"), "JUNCTION_SECRET").unwrap();
    let link = dir.path().join("junction");
    assert!(Command::new("cmd")
        .args(["/C", "mklink", "/J"])
        .arg(&link)
        .arg(outside.path())
        .status()
        .unwrap()
        .success());
    assert!(resolve_under_root(dir.path(), "junction/secret.txt").is_err());
    assert!(
        !pack(dir.path(), &["junction/secret.txt"], OutputFormat::Json).contains("JUNCTION_SECRET")
    );
}

#[test]
fn preview_missing_path_fails_closed() {
    let dir = tempfile::tempdir().unwrap();
    assert!(resolve_under_root(dir.path(), "missing.txt").is_err());
}

#[test]
fn pack_rejects_parent_escape() {
    let dir = tempfile::tempdir().unwrap();
    fs::create_dir(dir.path().join("project")).unwrap();
    fs::write(dir.path().join("secret.txt"), "OUTSIDE_SECRET").unwrap();
    let output = pack(
        &dir.path().join("project"),
        &["../secret.txt"],
        OutputFormat::Json,
    );
    assert!(!output.contains("OUTSIDE_SECRET"));
}

#[cfg(unix)]
#[test]
fn pack_rejects_intermediate_symlink() {
    let dir = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    fs::write(outside.path().join("secret.txt"), "OUTSIDE_SECRET").unwrap();
    std::os::unix::fs::symlink(outside.path(), dir.path().join("external")).unwrap();
    let output = pack(dir.path(), &["external/secret.txt"], OutputFormat::Json);
    assert!(!output.contains("OUTSIDE_SECRET"));
    assert!(resolve_under_root(dir.path(), "external/secret.txt").is_err());
}

#[test]
fn utf16_bom_is_text_in_pack_and_preview() {
    let dir = tempfile::tempdir().unwrap();
    let text = "<Grid>Zażółć gęślą jaźń 😀</Grid>\n";
    for little_endian in [true, false] {
        let mut bytes = if little_endian {
            vec![0xff, 0xfe]
        } else {
            vec![0xfe, 0xff]
        };
        for unit in text.encode_utf16() {
            bytes.extend(if little_endian {
                unit.to_le_bytes()
            } else {
                unit.to_be_bytes()
            });
        }
        fs::write(dir.path().join("view.xaml"), bytes).unwrap();
        let output = pack(dir.path(), &["view.xaml"], OutputFormat::Json);
        let value: serde_json::Value = serde_json::from_str(&output).unwrap();
        assert_eq!(value["files"][0]["content"], text);
        let preview = load_preview(&dir.path().join("view.xaml"), 1024).unwrap();
        assert!(!preview.binary);
        assert_eq!(preview.content, text);
    }
}

#[test]
fn markdown_fence_is_longer_than_every_content_run() {
    let dir = tempfile::tempdir().unwrap();
    let content = "```rust\ncode\n```\n~~~~\n``````\n~~~~\n";
    fs::write(dir.path().join("notes.md"), content).unwrap();
    let output = pack(dir.path(), &["notes.md"], OutputFormat::Markdown);
    assert!(output.contains("\n```````md\n"), "{output}");
    assert!(output.contains(content));
}

#[test]
fn packed_output_masks_secrets_in_every_format() {
    let dir = tempfile::tempdir().unwrap();
    // Split literals so packing this repo with ptt keeps its own tests readable.
    let aws = concat!("AK", "IAIOSFODNN7EXAMPLE");
    let pwd = concat!("Password=", "Sup3r");
    let content = format!("AWS_KEY={aws}\nServer=db;{pwd};\n");
    fs::write(dir.path().join("app.config"), &content).unwrap();
    for format in [
        OutputFormat::Xml,
        OutputFormat::Markdown,
        OutputFormat::Json,
        OutputFormat::Plain,
    ] {
        let output = pack(dir.path(), &["app.config"], format);
        assert!(
            !output.contains(concat!("AK", "IAIOSFODNN7EXAMPLE")),
            "{format:?}: {output}"
        );
        assert!(!output.contains(concat!("Sup", "3r")), "{format:?}: {output}");
        assert!(
            output.contains("[REDACTED: AWS_ACCESS_KEY]"),
            "{format:?}: {output}"
        );
        assert!(
            output.contains("Password=[REDACTED: PASSWORD];"),
            "{format:?}: {output}"
        );
    }
}

#[test]
fn malformed_foreign_gitignore_does_not_abort_walk() {
    // A broken line in a project's own .gitignore must not stop the scan; git ignores it too.
    let dir = tempfile::tempdir().unwrap();
    fs::create_dir(dir.path().join("sub")).unwrap();
    for bad in ["[\n", "\\\n", "**[\n", "a/**b\n", "!\n", "[z-a]\n"] {
        fs::write(dir.path().join("sub").join(".gitignore"), bad).unwrap();
        fs::write(dir.path().join("sub").join("ok.txt"), "ok").unwrap();
        let entries =
            walk(dir.path()).unwrap_or_else(|e| panic!("pattern {bad:?} aborted walk: {e}"));
        assert!(
            entries.iter().any(|e| e.path.ends_with("ok.txt")),
            "pattern {bad:?}"
        );
    }
}

#[test]
fn superseded_pack_stops_before_reading_next_file() {
    let dir = tempfile::tempdir().unwrap();
    fs::write(dir.path().join("a.txt"), "first").unwrap();
    fs::write(dir.path().join("b.txt"), "second").unwrap();
    let entries: Vec<DirEntryMeta> = ["a.txt", "b.txt"]
        .iter()
        .map(|p| DirEntryMeta {
            path: PathBuf::from(p),
            is_dir: false,
            size: None,
        })
        .collect();
    // Cancelled from the second file's check onward.
    let checks = std::cell::Cell::new(0);
    let cancelled = || {
        checks.set(checks.get() + 1);
        checks.get() >= 2
    };
    let mut output = Vec::new();
    let error = write_output_cancellable(
        &mut output,
        &entries,
        dir.path(),
        &WriteOptions::default(),
        &cancelled,
    )
    .unwrap_err();
    assert_eq!(error.kind(), std::io::ErrorKind::Interrupted);
    let text = String::from_utf8(output).unwrap();
    assert!(text.contains("first"));
    assert!(!text.contains("second"), "{text}");
}

#[test]
fn summary_total_counts_only_files_within_size_limit() {
    let dir = tempfile::tempdir().unwrap();
    fs::write(dir.path().join("small.txt"), "hello").unwrap();
    fs::write(dir.path().join("big.txt"), "x".repeat(100)).unwrap();
    let entries = vec![
        DirEntryMeta {
            path: PathBuf::from("small.txt"),
            is_dir: false,
            size: Some(5),
        },
        DirEntryMeta {
            path: PathBuf::from("big.txt"),
            is_dir: false,
            size: Some(100),
        },
    ];
    let mut output = Vec::new();
    write_output(
        &mut output,
        &entries,
        dir.path(),
        &WriteOptions {
            max_file_size: 10,
            ..Default::default()
        },
    )
    .unwrap();
    let text = String::from_utf8(output).unwrap();
    assert!(text.contains("Total size: 5 bytes"), "{text}");
    assert!(text.contains("[File too large"), "{text}");
}

#[test]
fn malformed_pttignore_still_fails_closed() {
    // Dropping .pttignore rules silently would leak files the user asked to exclude.
    let dir = tempfile::tempdir().unwrap();
    fs::write(dir.path().join(".pttignore"), "\\\n").unwrap();
    fs::write(dir.path().join("ok.txt"), "ok").unwrap();
    assert!(walk(dir.path()).is_err());
}
