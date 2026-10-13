//! Git-aware file walker.
//! Respects .gitignore exactly like `git` (via the `ignore` crate / `git ls-files`).
//! Also supports `.pttignore` for extra LLM-specific exclusions.

use crate::core::preview::resolve_under_canonical_root;
use ignore::WalkBuilder;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DirEntryMeta {
    /// Relative path using forward slashes (LLM-friendly, cross-platform stable).
    pub path: PathBuf,
    pub is_dir: bool,
    pub size: Option<u64>,
}

/// Normalize a path to a relative, forward-slash form for stable UI + packing.
pub fn normalize_rel_path(path: &Path) -> String {
    let s = path.to_string_lossy();
    let s = s.strip_prefix("./").unwrap_or(&s);
    s.replace('\\', "/")
}

fn pathbuf_forward_slashes(path: &Path) -> PathBuf {
    PathBuf::from(normalize_rel_path(path))
}

/// Main entry point. Respects .gitignore + .pttignore.
pub fn walk(root: &Path) -> std::io::Result<Vec<DirEntryMeta>> {
    if !root.exists() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            format!("path does not exist: {}", root.display()),
        ));
    }
    if !root.is_dir() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            format!("path is not a directory: {}", root.display()),
        ));
    }

    let canonical_root = std::fs::canonicalize(root)?;

    // Prefer git ls-files for perfect fidelity when this is a git work tree.
    if let Ok(entries) = try_git_ls_files(&canonical_root) {
        return apply_pttignore_on_git_results(entries, &canonical_root);
    }

    walk_with_ignore(&canonical_root)
}

/// `git` command that never opens a console window. The GUI build of ptt has no
/// console, so on Windows each spawned child would otherwise flash a `cmd` window.
fn git_command() -> Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let mut cmd = Command::new("git");
        cmd.creation_flags(CREATE_NO_WINDOW);
        cmd
    }
    #[cfg(not(windows))]
    {
        Command::new("git")
    }
}

/// Fast path using actual git (best fidelity when available).
fn try_git_ls_files(root: &Path) -> Result<Vec<DirEntryMeta>, ()> {
    // Only use this path inside a git repository.
    let is_repo = git_command()
        .current_dir(root)
        .args(["rev-parse", "--is-inside-work-tree"])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);
    if !is_repo {
        return Err(());
    }

    let output = git_command()
        .current_dir(root)
        .args([
            "ls-files",
            "-z",
            "--cached",
            "--others",
            "--exclude-standard",
        ])
        .output();

    let output = match output {
        Ok(o) if o.status.success() => o,
        _ => return Err(()),
    };

    let mut entries = Vec::new();

    for part in output.stdout.split(|&b| b == 0) {
        if part.is_empty() {
            continue;
        }
        let rel_str = String::from_utf8_lossy(part);
        // Git always uses forward slashes in ls-files output.
        let rel_path = PathBuf::from(rel_str.replace('\\', "/"));

        let full = match resolve_under_canonical_root(root, &rel_str) {
            Ok(full) => full,
            Err(_) => continue,
        };
        // Skip entries that vanished between ls-files and stat. Symlinks are
        // skipped too: a tracked link can point at a file outside the project.
        match std::fs::symlink_metadata(&full) {
            Ok(m) if m.file_type().is_symlink() => continue,
            Ok(_) => {}
            Err(_) => continue,
        }
        let is_dir = full.is_dir();
        let size = if !is_dir {
            std::fs::metadata(&full).ok().map(|m| m.len())
        } else {
            None
        };

        entries.push(DirEntryMeta {
            path: rel_path,
            is_dir,
            size,
        });
    }

    Ok(entries)
}

/// Ensure directory entries exist for tree UI (git ls-files only lists files).
fn add_directory_entries(mut entries: Vec<DirEntryMeta>) -> Vec<DirEntryMeta> {
    let mut dir_paths: HashSet<PathBuf> = HashSet::new();
    for e in &entries {
        let mut current = e.path.parent();
        while let Some(p) = current {
            if p.as_os_str().is_empty() || p == Path::new(".") {
                break;
            }
            dir_paths.insert(pathbuf_forward_slashes(p));
            current = p.parent();
        }
    }
    let existing: HashSet<_> = entries.iter().map(|e| e.path.clone()).collect();
    for d in dir_paths {
        if !existing.contains(&d) {
            entries.push(DirEntryMeta {
                path: d,
                is_dir: true,
                size: None,
            });
        }
    }
    entries
}

/// Apply .pttignore on top of git results (additional exclusions for LLM packing).
fn apply_pttignore_on_git_results(
    entries: Vec<DirEntryMeta>,
    root: &Path,
) -> std::io::Result<Vec<DirEntryMeta>> {
    use ignore::gitignore::{Gitignore, GitignoreBuilder};
    type Rules = Vec<Arc<Gitignore>>;
    fn excluded(rules: &Rules, path: &Path, is_dir: bool) -> bool {
        rules
            .iter()
            .rev()
            .find_map(|rule| {
                let matched = rule.matched(path, is_dir);
                if matched.is_none() {
                    None
                } else {
                    Some(matched.is_ignore())
                }
            })
            .unwrap_or(false)
    }
    fn load_rules(root: &Path, directory: &Path, mut rules: Rules) -> std::io::Result<Rules> {
        let relative = directory.join(".pttignore");
        match resolve_under_canonical_root(root, &relative.to_string_lossy()) {
            Ok(path) => {
                let mut builder = GitignoreBuilder::new(root.join(directory));
                if let Some(error) = builder.add(&path) {
                    return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, error));
                }
                rules.push(Arc::new(builder.build().map_err(|error| {
                    std::io::Error::new(std::io::ErrorKind::InvalidData, error)
                })?));
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }
        Ok(rules)
    }
    // Process directories top-down, just like a walker: an excluded parent cannot
    // be resurrected by a child rule. Each nested file has its own pattern root.
    let with_dirs = add_directory_entries(entries);
    let mut directories: Vec<_> = with_dirs
        .iter()
        .filter(|e| e.is_dir)
        .map(|e| e.path.clone())
        .collect();
    directories.sort_by_key(|path| path.components().count());
    let mut contexts: HashMap<PathBuf, (Rules, bool)> = HashMap::new();
    contexts.insert(
        PathBuf::new(),
        (load_rules(root, Path::new(""), Vec::new())?, false),
    );
    for directory in directories {
        let parent = directory.parent().unwrap_or(Path::new(""));
        let (rules, parent_excluded) = &contexts[parent];
        let blocked = *parent_excluded || excluded(rules, &root.join(&directory), true);
        let rules = if blocked {
            rules.clone()
        } else {
            load_rules(root, &directory, rules.clone())?
        };
        contexts.insert(directory, (rules, blocked));
    }
    let mut filtered: Vec<_> = with_dirs
        .into_iter()
        .filter(|entry| {
            if entry.is_dir {
                return !contexts[&entry.path].1;
            }
            let parent = entry.path.parent().unwrap_or(Path::new(""));
            let (rules, blocked) = &contexts[parent];
            !blocked && !excluded(rules, &root.join(&entry.path), false)
        })
        .collect();
    filtered.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(filtered)
}

/// True when every failure belongs to a `.gitignore` file (parse or read error).
fn is_foreign_gitignore_error(error: &ignore::Error) -> bool {
    match error {
        ignore::Error::Partial(errors) => {
            !errors.is_empty() && errors.iter().all(is_foreign_gitignore_error)
        }
        ignore::Error::WithLineNumber { err, .. } | ignore::Error::WithDepth { err, .. } => {
            is_foreign_gitignore_error(err)
        }
        ignore::Error::WithPath { path, .. } => {
            path.file_name().is_some_and(|name| name == ".gitignore")
        }
        _ => false,
    }
}

/// Fallback using the ignore crate (gitignore + .pttignore).
fn walk_with_ignore(root: &Path) -> std::io::Result<Vec<DirEntryMeta>> {
    let mut builder = WalkBuilder::new(root);

    builder
        .standard_filters(true)
        .git_ignore(true)
        .git_exclude(true)
        .git_global(true)
        .require_git(false)
        .parents(true)
        .hidden(false)
        .ignore(false)
        .follow_links(false)
        .add_custom_ignore_filename(".pttignore");

    // Hard safety filters (junk that should never be included by default)
    builder.filter_entry(|entry| {
        let name = entry.file_name();
        !matches!(
            name.to_str(),
            Some(".git" | "node_modules" | "target" | ".idea" | ".venv" | "__pycache__")
        )
    });

    let walker = builder.build();
    let mut entries = Vec::new();

    for result in walker {
        let entry = match result {
            Ok(e) => e,
            Err(_) => continue,
        };

        // A broken line in a project's own .gitignore is skipped, as Git does.
        // Errors from .pttignore stay fail-closed: its rules must never be dropped silently.
        if let Some(error) = entry.error() {
            if !is_foreign_gitignore_error(error) {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    error.to_string(),
                ));
            }
        }
        let path = entry.path();

        if path != root
            && resolve_under_canonical_root(
                root,
                &path
                    .strip_prefix(root)
                    .map_err(std::io::Error::other)?
                    .to_string_lossy(),
            )
            .is_err()
        {
            continue;
        }

        let meta = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };

        let rel = path.strip_prefix(root).unwrap_or(path).to_path_buf();
        let rel = pathbuf_forward_slashes(&rel);

        // Skip the root itself
        if rel.as_os_str().is_empty() || rel == Path::new(".") {
            continue;
        }

        if meta.is_dir() {
            entries.push(DirEntryMeta {
                path: rel,
                is_dir: true,
                size: None,
            });
            continue;
        }

        if meta.is_file() {
            entries.push(DirEntryMeta {
                path: rel,
                is_dir: false,
                size: Some(meta.len()),
            });
        }
    }

    entries.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(entries)
}

/// Selection is normalized once; each candidate checks only its own ancestors.
pub struct SelectionMatcher {
    paths: HashSet<String>,
}

impl SelectionMatcher {
    pub fn new(selected: &[String]) -> Self {
        Self {
            paths: selected
                .iter()
                .map(|path| {
                    normalize_rel_path(Path::new(path))
                        .trim_end_matches('/')
                        .to_owned()
                })
                .filter(|path| !path.is_empty())
                .collect(),
        }
    }

    pub fn is_selected(&self, candidate: &Path) -> bool {
        let normalized = normalize_rel_path(candidate);
        let mut prefix = normalized.as_str();
        loop {
            if self.paths.contains(prefix) {
                return true;
            }
            match prefix.rfind('/') {
                Some(index) => prefix = &prefix[..index],
                None => return false,
            }
        }
    }
}

/// Return true if `candidate` is the same path as `selected` or a descendant of it.
/// Paths are compared with forward-slash normalization.
pub fn path_is_selected(candidate: &Path, selected: &str) -> bool {
    let c = normalize_rel_path(candidate);
    let s = selected
        .replace('\\', "/")
        .trim_end_matches('/')
        .to_string();
    c == s || c.starts_with(&format!("{s}/"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::process::Command;

    fn init_git_repo(root: &Path) {
        let status = Command::new("git")
            .args(["init"])
            .current_dir(root)
            .status()
            .expect("git init");
        assert!(status.success());
        // Identity required on some CI images
        let _ = Command::new("git")
            .args(["config", "user.email", "ptt@test.local"])
            .current_dir(root)
            .status();
        let _ = Command::new("git")
            .args(["config", "user.name", "ptt-test"])
            .current_dir(root)
            .status();
    }

    #[test]
    fn normalize_rel_path_uses_forward_slashes() {
        assert_eq!(normalize_rel_path(Path::new("a\\b\\c")), "a/b/c");
        assert_eq!(
            normalize_rel_path(Path::new("./src/main.rs")),
            "src/main.rs"
        );
    }

    #[test]
    fn path_is_selected_matches_prefix() {
        assert!(path_is_selected(Path::new("src/main.rs"), "src"));
        assert!(path_is_selected(Path::new("src/main.rs"), "src/main.rs"));
        assert!(!path_is_selected(Path::new("src2/main.rs"), "src"));
    }

    #[test]
    fn walk_nonexistent_errors() {
        let err = walk(Path::new("/this/path/does/not/exist/ptt-xyz")).unwrap_err();
        assert_eq!(err.kind(), std::io::ErrorKind::NotFound);
    }

    #[test]
    fn walk_respects_gitignore_via_git() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        init_git_repo(root);

        fs::write(root.join("keep.rs"), "ok").unwrap();
        fs::write(root.join("secret.env"), "KEY=1").unwrap();
        fs::write(root.join(".gitignore"), "secret.env\n").unwrap();

        // Stage keep.rs so ls-files --cached sees it; untracked keep would also
        // appear via --others, but ignored secret.env must not.
        let _ = Command::new("git")
            .args(["add", "keep.rs", ".gitignore"])
            .current_dir(root)
            .status();

        let entries = walk(root).expect("walk");
        let paths: Vec<String> = entries
            .iter()
            .filter(|e| !e.is_dir)
            .map(|e| normalize_rel_path(&e.path))
            .collect();

        assert!(paths.iter().any(|p| p == "keep.rs"), "paths={paths:?}");
        assert!(
            !paths.iter().any(|p| p == "secret.env"),
            "secret.env must be ignored, got {paths:?}"
        );
    }

    #[cfg(unix)]
    #[test]
    fn walk_skips_tracked_symlinks_pointing_outside_repo() {
        let outside = tempfile::tempdir().unwrap();
        let secret = outside.path().join("id_rsa");
        fs::write(&secret, "PRIVATE").unwrap();

        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        init_git_repo(root);
        fs::write(root.join("keep.rs"), "ok").unwrap();
        std::os::unix::fs::symlink(&secret, root.join("link")).unwrap();

        let _ = Command::new("git")
            .args(["add", "-A"])
            .current_dir(root)
            .status();

        let entries = walk(root).expect("walk");
        let paths: Vec<String> = entries
            .iter()
            .filter(|e| !e.is_dir)
            .map(|e| normalize_rel_path(&e.path))
            .collect();

        assert!(paths.iter().any(|p| p == "keep.rs"), "paths={paths:?}");
        assert!(
            !paths.iter().any(|p| p == "link"),
            "symlink must be skipped, got {paths:?}"
        );
    }

    #[test]
    fn walk_applies_pttignore() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        init_git_repo(root);

        fs::write(root.join("app.rs"), "ok").unwrap();
        fs::write(root.join("noise.log"), "log").unwrap();
        fs::write(root.join(".pttignore"), "*.log\n").unwrap();

        let _ = Command::new("git")
            .args(["add", "-A"])
            .current_dir(root)
            .status();

        let entries = walk(root).expect("walk");
        let paths: Vec<String> = entries
            .iter()
            .filter(|e| !e.is_dir)
            .map(|e| normalize_rel_path(&e.path))
            .collect();

        assert!(paths.iter().any(|p| p == "app.rs"), "paths={paths:?}");
        assert!(
            !paths.iter().any(|p| p.ends_with("noise.log")),
            ".pttignore should drop noise.log, got {paths:?}"
        );
    }

    #[test]
    fn walk_without_git_still_works() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::create_dir(root.join("src")).unwrap();
        fs::write(root.join("src/lib.rs"), "pub fn x() {}").unwrap();
        fs::write(root.join("README.md"), "# hi").unwrap();

        let entries = walk(root).expect("walk");
        let files: Vec<_> = entries.iter().filter(|e| !e.is_dir).collect();
        assert!(files.len() >= 2);
        assert!(files
            .iter()
            .any(|e| normalize_rel_path(&e.path) == "src/lib.rs"));
    }

    #[test]
    fn add_directory_entries_fills_parents() {
        let entries = vec![DirEntryMeta {
            path: PathBuf::from("a/b/c.rs"),
            is_dir: false,
            size: Some(1),
        }];
        let with = add_directory_entries(entries);
        let dirs: Vec<_> = with
            .iter()
            .filter(|e| e.is_dir)
            .map(|e| normalize_rel_path(&e.path))
            .collect();
        assert!(dirs.contains(&"a".to_string()));
        assert!(dirs.contains(&"a/b".to_string()));
    }
}
