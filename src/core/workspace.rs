use crate::core::{
    deps::DependencyGraph,
    git::{inspect_git_context, GitRepoContext},
    preview::resolve_under_canonical_root,
    walker::{normalize_rel_path, walk, DirEntryMeta, SelectionMatcher},
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
    dep_graph: OnceLock<Arc<DependencyGraph>>,
    /// The previous snapshot's graph for the same root, used to skip unchanged files.
    previous_graph: Option<Arc<DependencyGraph>>,
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

        let previous_graph = self.current.lock().ok().and_then(|guard| {
            guard
                .as_ref()
                .filter(|previous| previous.root == root)
                .and_then(|previous| previous.dep_graph.get().cloned())
        });

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
            previous_graph,
        });
        let mut current = self.current.lock().map_err(|_| "Workspace lock poisoned")?;
        if self.revision.load(Ordering::SeqCst) != revision {
            return Err("Scan superseded by a newer project request".into());
        }
        *current = Some(snapshot.clone());
        Ok(snapshot)
    }

    /// Incrementally updates the current snapshot when `changed_paths` only modify existing
    /// regular files in place and no ignore rules changed. Falls back to a full `scan(path)`
    /// when files or directories are created/removed or ignore files are touched.
    pub fn refresh_paths(
        &self,
        path: &Path,
        changed_paths: &[PathBuf],
    ) -> Result<Arc<WorkspaceSnapshot>, String> {
        if changed_paths.is_empty() {
            return self.scan(path);
        }
        let Ok(canon_root) = path.canonicalize() else {
            return self.scan(path);
        };
        let Some(current) = self.current_snapshot().filter(|s| s.root == canon_root) else {
            return self.scan(path);
        };
        // If ignore rules changed on disk, do a full scan.
        if self.get(&current.root, current.revision).is_err() {
            return self.scan(path);
        }

        let mut rel_targets = HashSet::new();
        for p in changed_paths {
            let rel_pb = if p.is_absolute() {
                match p.strip_prefix(&current.root) {
                    Ok(r) => r.to_path_buf(),
                    Err(_) => return self.scan(path),
                }
            } else {
                p.clone()
            };
            let norm = normalize_rel_path(&rel_pb);
            if norm.is_empty() || norm.ends_with(".gitignore") || norm.ends_with(".pttignore") {
                return self.scan(path);
            }
            // A deleted, moved, or non-file path needs the full walk.
            let Ok(meta) = std::fs::symlink_metadata(current.root.join(&norm)) else {
                return self.scan(path);
            };
            if !meta.is_file() {
                return self.scan(path);
            }
            rel_targets.insert(norm);
        }

        // Every changed path must already be an indexed file. A new file needs the full walk.
        let mut entries = current.entries.clone();
        let mut matched = 0usize;
        for entry in &mut entries {
            if entry.is_dir {
                continue;
            }
            if rel_targets.contains(&normalize_rel_path(&entry.path)) {
                entry.size = std::fs::metadata(current.root.join(&entry.path))
                    .ok()
                    .map(|m| m.len());
                matched += 1;
            }
        }
        if matched != rel_targets.len() {
            return self.scan(path);
        }

        let revision = self.revision.fetch_add(1, Ordering::SeqCst) + 1;
        let git_context = inspect_git_context(&current.root);
        // The graph re-reads only files whose (mtime, len) stamp changed.
        let previous_graph = current
            .dep_graph
            .get()
            .cloned()
            .or_else(|| current.previous_graph.clone());

        let snapshot = Arc::new(WorkspaceSnapshot {
            root: current.root.clone(),
            revision,
            entries,
            git_context,
            existing_rules: current.existing_rules.clone(),
            directories: current.directories.clone(),
            dep_graph: OnceLock::new(),
            previous_graph,
        });
        let mut slot = self.current.lock().map_err(|_| "Workspace lock poisoned")?;
        *slot = Some(snapshot.clone());
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
            .get_or_init(|| {
                Arc::new(DependencyGraph::build_incremental(
                    &self.root,
                    &self.entries,
                    self.previous_graph.as_deref(),
                ))
            })
            .as_ref()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn rescan_reuses_unchanged_import_resolutions_and_picks_up_edits() {
        use std::collections::BTreeSet;
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        let a = root.join("a.ts");
        fs::write(&a, "import './b';\n").unwrap();
        fs::write(root.join("b.ts"), "export const b = 1;\n").unwrap();
        fs::write(root.join("c.ts"), "export const c = 1;\n").unwrap();
        let index = WorkspaceIndex::default();
        let first = index.scan(root).unwrap();
        assert_eq!(
            first.dependency_graph().imports["a.ts"],
            BTreeSet::from(["b.ts".to_string()])
        );

        // Same length and mtime: the stamp matches, so the cached resolution is reused and the
        // file is not parsed again. The edited content below is therefore not read.
        let original_mtime = fs::metadata(&a).unwrap().modified().unwrap();
        fs::write(&a, "import './c';\n").unwrap();
        fs::OpenOptions::new()
            .write(true)
            .open(&a)
            .unwrap()
            .set_modified(original_mtime)
            .unwrap();
        let second = index.scan(root).unwrap();
        assert_eq!(
            second.dependency_graph().imports["a.ts"],
            BTreeSet::from(["b.ts".to_string()]),
            "an unchanged stamp must reuse the cached imports"
        );

        // A real edit changes the stamp: the file is parsed again and the new import appears.
        fs::write(&a, "import './c';\nimport './b';\n").unwrap();
        let third = index.scan(root).unwrap();
        assert_eq!(
            third.dependency_graph().imports["a.ts"],
            BTreeSet::from(["b.ts".to_string(), "c.ts".to_string()])
        );
    }

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

    #[test]
    fn refresh_paths_updates_in_place_edits_and_falls_back_on_new_files() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        fs::write(root.join("a.rs"), "a").unwrap();
        fs::write(root.join("b.rs"), "b").unwrap();
        let index = WorkspaceIndex::default();
        let first = index.scan(root).unwrap();

        // In-place edit of an indexed file: the entry list keeps its shape and the size is refreshed.
        fs::write(root.join("a.rs"), "aaaa").unwrap();
        let edited = index.refresh_paths(root, &[root.join("a.rs")]).unwrap();
        assert!(edited.revision > first.revision);
        assert_eq!(edited.entries.len(), first.entries.len());
        let a = edited
            .entries
            .iter()
            .find(|e| e.path == Path::new("a.rs"))
            .unwrap();
        assert_eq!(a.size, Some(4));
        assert!(index.get(&edited.root, edited.revision).is_ok());

        // A new file is not in the index, so the refresh falls back to a full scan and finds it.
        fs::write(root.join("c.rs"), "c").unwrap();
        let grown = index.refresh_paths(root, &[root.join("c.rs")]).unwrap();
        assert!(grown.entries.iter().any(|e| e.path == Path::new("c.rs")));

        // A deleted file also falls back to a full scan and drops out of the index.
        fs::remove_file(root.join("b.rs")).unwrap();
        let shrunk = index.refresh_paths(root, &[root.join("b.rs")]).unwrap();
        assert!(!shrunk.entries.iter().any(|e| e.path == Path::new("b.rs")));

        // A changed ignore file falls back to a full scan, so the new rule applies.
        fs::write(root.join(".pttignore"), "a.rs\n").unwrap();
        let ignored = index
            .refresh_paths(root, &[root.join(".pttignore")])
            .unwrap();
        assert!(!ignored.entries.iter().any(|e| e.path == Path::new("a.rs")));
    }
}
