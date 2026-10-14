//! Git-aware context discovery ("Diff / Branch Mode").
//!
//! Queries Git for working-tree status badges (`M`, `A`, `U`, `D`), branch changed
//! files (`main...HEAD` / `master...HEAD`), unified diff (`git diff`), and recent commits.

use crate::core::walker::normalize_rel_path;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeSet, HashMap};
use std::path::Path;
use std::process::Command;

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitRepoContext {
    pub is_git_repo: bool,
    pub current_branch: Option<String>,
    pub base_branch: Option<String>,
    /// Map of normalized relative path -> status badge ("M", "A", "U", "D", "R")
    pub file_statuses: HashMap<String, String>,
    /// Sorted list of modified/staged/untracked files in working tree
    pub modified_files: Vec<String>,
    /// Sorted list of files changed on the current branch vs base branch
    pub branch_changed_files: Vec<String>,
    /// Recent commit log (`git log -n 5 --oneline`)
    pub recent_commits: Vec<String>,
}

/// Spawns `git` without flashing a console window on Windows GUI builds.
pub fn git_command() -> Command {
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

/// Inspects the Git status and branch changes for `root`.
pub fn inspect_git_context(root: &Path) -> GitRepoContext {
    let is_repo = git_command()
        .current_dir(root)
        .args(["rev-parse", "--is-inside-work-tree"])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);

    if !is_repo {
        return GitRepoContext::default();
    }

    let current_branch = git_command()
        .current_dir(root)
        .args(["rev-parse", "--abbrev-ref", "HEAD"])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .filter(|s| !s.is_empty());

    let mut file_statuses = HashMap::new();
    let mut modified_set = BTreeSet::new();

    if let Ok(output) = git_command()
        .current_dir(root)
        .args(["status", "--porcelain=v1", "-z", "-uall"])
        .output()
    {
        if output.status.success() {
            let mut parts = output.stdout.split(|&b| b == 0).peekable();
            while let Some(entry) = parts.next() {
                if entry.len() < 4 {
                    continue;
                }
                let xy = &entry[..2];
                let path_bytes = &entry[3..];
                let raw_path = String::from_utf8_lossy(path_bytes);
                let norm = normalize_rel_path(Path::new(raw_path.as_ref()));
                // If rename/copy (`R` or `C` in X or Y), porcelain -z follows with the original path NUL-delimited
                if xy[0] == b'R' || xy[0] == b'C' || xy[1] == b'R' || xy[1] == b'C' {
                    let _ = parts.next();
                }
                let badge = classify_porcelain_status(xy[0], xy[1]);
                if !norm.is_empty() {
                    if badge != "D" {
                        modified_set.insert(norm.clone());
                    }
                    file_statuses.insert(norm, badge.to_string());
                }
            }
        }
    }

    let (base_branch, branch_changed_files) = detect_branch_changes(root, &modified_set);

    let recent_commits = git_command()
        .current_dir(root)
        .args(["log", "-n", "5", "--oneline", "--no-decorate"])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| {
            String::from_utf8_lossy(&o.stdout)
                .lines()
                .map(|l| l.trim().to_string())
                .filter(|l| !l.is_empty())
                .collect()
        })
        .unwrap_or_default();

    GitRepoContext {
        is_git_repo: true,
        current_branch,
        base_branch,
        file_statuses,
        modified_files: modified_set.into_iter().collect(),
        branch_changed_files,
        recent_commits,
    }
}

fn classify_porcelain_status(x: u8, y: u8) -> &'static str {
    if x == b'?' && y == b'?' {
        "U"
    } else if x == b'A' || y == b'A' {
        "A"
    } else if x == b'D' || y == b'D' {
        "D"
    } else if x == b'R' || y == b'R' {
        "R"
    } else {
        "M"
    }
}

fn detect_branch_changes(
    root: &Path,
    working_modified: &BTreeSet<String>,
) -> (Option<String>, Vec<String>) {
    let candidates = ["main", "master", "origin/main", "origin/master", "develop"];
    for base in candidates {
        let verify = git_command()
            .current_dir(root)
            .args(["rev-parse", "--verify", "--quiet", base])
            .output();
        if !verify.map(|o| o.status.success()).unwrap_or(false) {
            continue;
        }
        let range = format!("{base}...HEAD");
        if let Ok(output) = git_command()
            .current_dir(root)
            .args(["diff", "--name-only", "-z", &range])
            .output()
        {
            if output.status.success() {
                let mut set: BTreeSet<String> = output
                    .stdout
                    .split(|&b| b == 0)
                    .filter(|s| !s.is_empty())
                    .map(|s| normalize_rel_path(Path::new(String::from_utf8_lossy(s).as_ref())))
                    .filter(|s| !s.is_empty())
                    .collect();
                for m in working_modified {
                    set.insert(m.clone());
                }
                return (Some(base.to_string()), set.into_iter().collect());
            }
        }
    }
    (None, working_modified.iter().cloned().collect())
}

/// Computes the unified Git diff (staged + unstaged working tree changes, or `HEAD~1..HEAD` if clean)
/// capped to `max_bytes` so huge diffs don't blow up memory.
pub fn compute_git_diff(root: &Path, max_bytes: usize) -> Option<String> {
    let is_repo = git_command()
        .current_dir(root)
        .args(["rev-parse", "--is-inside-work-tree"])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);
    if !is_repo {
        return None;
    }

    // Try `git diff HEAD` first (combines staged + unstaged against HEAD)
    let mut diff_bytes = git_command()
        .current_dir(root)
        .args(["diff", "HEAD", "--no-color", "--no-ext-diff"])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| o.stdout)
        .unwrap_or_default();

    // Fallback when repo has no HEAD commit yet (e.g. brand new repo with staged files)
    if diff_bytes.is_empty() {
        diff_bytes = git_command()
            .current_dir(root)
            .args(["diff", "--staged", "--no-color", "--no-ext-diff"])
            .output()
            .ok()
            .filter(|o| o.status.success())
            .map(|o| o.stdout)
            .unwrap_or_default();
    }

    if diff_bytes.is_empty() {
        diff_bytes = git_command()
            .current_dir(root)
            .args(["diff", "--no-color", "--no-ext-diff"])
            .output()
            .ok()
            .filter(|o| o.status.success())
            .map(|o| o.stdout)
            .unwrap_or_default();
    }

    if diff_bytes.is_empty() {
        return None;
    }

    let truncated = diff_bytes.len() > max_bytes;
    let slice = if truncated {
        &diff_bytes[..max_bytes]
    } else {
        &diff_bytes[..]
    };
    let mut text = String::from_utf8_lossy(slice).into_owned();
    if truncated {
        text.push_str(&format!(
            "\n... [git diff truncated at {} bytes] ...\n",
            max_bytes
        ));
    }
    Some(text)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn git_context_detects_modified_and_untracked_files() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();

        assert!(!inspect_git_context(root).is_git_repo);

        assert!(git_command()
            .args(["init", "--quiet"])
            .current_dir(root)
            .status()
            .unwrap()
            .success());
        let _ = git_command()
            .args(["config", "user.email", "ptt@test.local"])
            .current_dir(root)
            .status();
        let _ = git_command()
            .args(["config", "user.name", "ptt-test"])
            .current_dir(root)
            .status();

        fs::write(root.join("tracked.rs"), "fn a() {}\n").unwrap();
        let _ = git_command()
            .args(["add", "tracked.rs"])
            .current_dir(root)
            .status();
        let _ = git_command()
            .args(["commit", "-m", "initial", "--quiet"])
            .current_dir(root)
            .status();

        // Modify tracked.rs and add untracked.rs
        fs::write(root.join("tracked.rs"), "fn a() { let x = 1; }\n").unwrap();
        fs::write(root.join("untracked.rs"), "fn b() {}\n").unwrap();

        let ctx = inspect_git_context(root);
        assert!(ctx.is_git_repo);
        assert_eq!(
            ctx.file_statuses.get("tracked.rs").map(String::as_str),
            Some("M")
        );
        assert_eq!(
            ctx.file_statuses.get("untracked.rs").map(String::as_str),
            Some("U")
        );
        assert!(ctx.modified_files.contains(&"tracked.rs".to_string()));
        assert!(ctx.modified_files.contains(&"untracked.rs".to_string()));

        let diff = compute_git_diff(root, 64 * 1024).expect("should have diff");
        assert!(diff.contains("tracked.rs"), "{diff}");
        assert!(diff.contains("+fn a() { let x = 1; }"), "{diff}");
    }
}
