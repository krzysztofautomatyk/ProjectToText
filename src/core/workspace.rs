use crate::core::{
    deps::DependencyGraph,
    git::{inspect_git_context, GitRepoContext},
    preview::resolve_under_canonical_root,
    walker::{walk, DirEntryMeta, SelectionMatcher},
};
use std::{
    collections::HashSet,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex, OnceLock,
    },
    time::SystemTime,
};

#[derive(Clone, Debug, PartialEq, Eq)]
struct ExistingIgnoreRule {
    relative: PathBuf,
    mtime: Option<SystemTime>,
    len: u64,
    bytes: Vec<u8>,
}

#[derive(Clone, Debug)]
struct IndexedDirectory {
    relative: PathBuf,
    mtime: Option<SystemTime>,
}

pub struct WorkspaceSnapshot {
    pub root: PathBuf,
    pub revision: u64,
    pub entries: Vec<DirEntryMeta>,
    pub git_context: GitRepoContext,
    existing_rules: Vec<ExistingIgnoreRule>,
    directories: Vec<IndexedDirectory>,
    dep_graph: OnceLock<DependencyGraph>,
}

impl std::fmt::Debug for WorkspaceSnapshot {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("WorkspaceSnapshot")
            .field("root", &self.root)
            .field("revision", &self.revision)
            .field("entries_len", &self.entries.len())
            .finish()
    }
}

#[derive(Default)]
pub struct WorkspaceIndex {
    current: Mutex<Option<Arc<WorkspaceSnapshot>>>,
    revision: AtomicU64,
}

/// `root` must already be canonical (see `WorkspaceIndex::scan`).
fn inspect_rule(root: &Path, relative: &Path) -> Result<Option<ExistingIgnoreRule>, String> {
    match resolve_under_canonical_root(root, &relative.to_string_lossy()) {
        Ok(path) => {
            let meta = std::fs::metadata(&path).map_err(|error| error.to_string())?;
            let bytes = std::fs::read(&path).map_err(|error| error.to_string())?;
            Ok(Some(ExistingIgnoreRule {
                relative: relative.to_path_buf(),
                mtime: meta.modified().ok(),
                len: meta.len(),
                bytes,
            }))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

fn dir_mtime(root: &Path, relative: &Path) -> Option<SystemTime> {
    let path = if relative.as_os_str().is_empty() {
        root.to_path_buf()
    } else {
        root.join(relative)
    };
    std::fs::metadata(path).ok().and_then(|m| m.modified().ok())
}

impl WorkspaceIndex {
    pub fn scan(&self, path: &Path) -> Result<Arc<WorkspaceSnapshot>, String> {
        let revision = self.revision.fetch_add(1, Ordering::SeqCst) + 1;
        let root = path.canonicalize().map_err(|error| error.to_string())?;
        let entries = walk(&root).map_err(|error| error.to_string())?;
        let git_context = inspect_git_context(&root);

        let mut dir_set: HashSet<PathBuf> = entries
            .iter()
            .filter(|entry| entry.is_dir)
            .map(|entry| entry.path.clone())
            .collect();
        dir_set.insert(PathBuf::new());

        let mut existing_rules = Vec::new();
        let mut directories = Vec::with_capacity(dir_set.len());

        for directory in dir_set {
            for name in [".pttignore", ".gitignore"] {
                let relative = directory.join(name);
                if let Some(rule) = inspect_rule(&root, &relative)? {
                    existing_rules.push(rule);
                }
            }
            directories.push(IndexedDirectory {
                mtime: dir_mtime(&root, &directory),
                relative: directory,
            });
        }

        // The root is canonical and returned to the frontend; revisions reject
        // stale generation requests, even when reopening the same path.
        let snapshot = Arc::new(WorkspaceSnapshot {
            root,
            revision,
            entries,
            git_context,
            existing_rules,
            directories,
            dep_graph: OnceLock::new(),
        });
        let mut current = self.current.lock().map_err(|_| "Workspace lock poisoned")?;
        if self.revision.load(Ordering::SeqCst) != revision {
            return Err("Scan superseded by a newer project request".into());
        }
        *current = Some(snapshot.clone());
        Ok(snapshot)
    }

    pub fn get(&self, path: &Path, revision: u64) -> Result<Arc<WorkspaceSnapshot>, String> {
        let snapshot = self
            .current
            .lock()
            .map_err(|_| "Workspace lock poisoned")?
            .clone()
            .ok_or("Open or refresh the project before packing")?;
        if snapshot.root != path
            || snapshot.revision != revision
            || self.revision.load(Ordering::SeqCst) != revision
            || path.canonicalize().map_err(|error| error.to_string())? != snapshot.root
        {
            return Err("Workspace changed; refresh the project".into());
        }

        // 1. Validate existing ignore files: if (mtime, len) matches, skip reading file content;
        //    if (mtime, len) differs or mtime is unavailable, compare bytes.
        let mut existing_paths: HashSet<PathBuf> =
            HashSet::with_capacity(snapshot.existing_rules.len());
        for rule in &snapshot.existing_rules {
            existing_paths.insert(rule.relative.clone());
            match resolve_under_canonical_root(&snapshot.root, &rule.relative.to_string_lossy()) {
                Ok(full_path) => {
                    let meta = std::fs::metadata(&full_path)
                        .map_err(|_| "Ignore rules changed; refresh the project before packing")?;
                    let same_stat = rule.mtime.is_some()
                        && meta.modified().ok() == rule.mtime
                        && meta.len() == rule.len;
                    if !same_stat {
                        let bytes = std::fs::read(&full_path).map_err(|e| e.to_string())?;
                        if bytes != rule.bytes {
                            return Err(
                                "Ignore rules changed; refresh the project before packing".into()
                            );
                        }
                    }
                }
                Err(_) => {
                    return Err("Ignore rules changed; refresh the project before packing".into());
                }
            }
        }

        // 2. For directories whose mtime changed (or where mtime is unavailable), check if a new
        //    `.pttignore` or `.gitignore` was created since the scan.
        for dir in &snapshot.directories {
            let current_mtime = dir_mtime(&snapshot.root, &dir.relative);
            if dir.mtime.is_some() && current_mtime == dir.mtime {
                continue;
            }
            for name in [".pttignore", ".gitignore"] {
                let candidate = dir.relative.join(name);
                if existing_paths.contains(&candidate) {
                    continue;
                }
                if inspect_rule(&snapshot.root, &candidate)?.is_some() {
                    return Err("Ignore rules changed; refresh the project before packing".into());
                }
            }
        }

        Ok(snapshot)
    }

    pub fn current_snapshot(&self) -> Option<Arc<WorkspaceSnapshot>> {
        self.current.lock().ok().and_then(|g| g.clone())
    }
}

impl WorkspaceSnapshot {
    pub fn selected(&self, paths: &[String]) -> Vec<DirEntryMeta> {
        let matcher = SelectionMatcher::new(paths);
        self.entries
            .iter()
            .filter(|entry| !entry.is_dir && matcher.is_selected(&entry.path))
            .cloned()
            .collect()
    }

    pub fn dependency_graph(&self) -> &DependencyGraph {
        self.dep_graph
            .get_or_init(|| DependencyGraph::build(&self.root, &self.entries))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn cached_selection_does_not_rescan_and_refresh_invalidates_old_revision() {
        let directory = tempfile::tempdir().unwrap();
        fs::write(directory.path().join("a.rs"), "a").unwrap();
        let index = WorkspaceIndex::default();
        let first = index.scan(directory.path()).unwrap();
        fs::write(directory.path().join("b.rs"), "b").unwrap();
        let cached = index.get(&first.root, first.revision).unwrap();
        assert!(Arc::ptr_eq(&first, &cached));
        assert_eq!(cached.selected(&["a.rs".into(), "b.rs".into()]).len(), 1);
        let next = index.scan(directory.path()).unwrap();
        assert!(index.get(&first.root, first.revision).is_err());
        assert_eq!(next.selected(&["a.rs".into(), "b.rs".into()]).len(), 2);
    }

    #[test]
    fn changed_ignore_rules_block_cached_pack() {
        let directory = tempfile::tempdir().unwrap();
        fs::write(directory.path().join("a.rs"), "a").unwrap();
        let index = WorkspaceIndex::default();
        let first = index.scan(directory.path()).unwrap();
        fs::write(directory.path().join(".pttignore"), "a.rs\n").unwrap();
        assert!(index
            .get(&first.root, first.revision)
            .unwrap_err()
            .contains("Ignore rules changed"));
    }
}
