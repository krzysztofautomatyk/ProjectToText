use crate::core::{
    preview::resolve_under_canonical_root,
    walker::{walk, DirEntryMeta, SelectionMatcher},
};
use std::{
    collections::HashSet,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
};

#[derive(Clone, Debug)]
pub struct WorkspaceSnapshot {
    pub root: PathBuf,
    pub revision: u64,
    pub entries: Vec<DirEntryMeta>,
    rules: Vec<(PathBuf, Option<Vec<u8>>)>,
}

#[derive(Default)]
pub struct WorkspaceIndex {
    current: Mutex<Option<Arc<WorkspaceSnapshot>>>,
    revision: AtomicU64,
}

/// `root` must already be canonical (see `WorkspaceIndex::scan`).
fn rule_bytes(root: &Path, relative: &Path) -> Result<Option<Vec<u8>>, String> {
    match resolve_under_canonical_root(root, &relative.to_string_lossy()) {
        Ok(path) => std::fs::read(path)
            .map(Some)
            .map_err(|error| error.to_string()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

impl WorkspaceIndex {
    pub fn scan(&self, path: &Path) -> Result<Arc<WorkspaceSnapshot>, String> {
        let revision = self.revision.fetch_add(1, Ordering::SeqCst) + 1;
        let root = path.canonicalize().map_err(|error| error.to_string())?;
        let entries = walk(&root).map_err(|error| error.to_string())?;
        let mut directories: HashSet<PathBuf> = entries
            .iter()
            .filter(|entry| entry.is_dir)
            .map(|entry| entry.path.clone())
            .collect();
        directories.insert(PathBuf::new());
        let mut rules = Vec::new();
        for directory in directories {
            for name in [".pttignore", ".gitignore"] {
                let relative = directory.join(name);
                rules.push((relative.clone(), rule_bytes(&root, &relative)?));
            }
        }
        // The root is canonical and returned to the frontend; revisions reject
        // stale generation requests, even when reopening the same path.
        let snapshot = Arc::new(WorkspaceSnapshot {
            root,
            revision,
            entries,
            rules,
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
        for (relative, expected) in &snapshot.rules {
            if &rule_bytes(&snapshot.root, relative)? != expected {
                return Err("Ignore rules changed; refresh the project before packing".into());
            }
        }
        Ok(snapshot)
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
