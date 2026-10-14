//! Intra-repository import & dependency graph resolver.
//!
//! Parses `use` / `mod` (Rust), `import ... from` / `export ... from` / `require(...)` (TS/JS),
//! `import` / `from ... import` (Python), and `using` (C#) to resolve relative and crate-local
//! file dependencies inside a workspace snapshot.

use crate::core::walker::{normalize_rel_path, DirEntryMeta};
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeSet, HashMap, HashSet};
use std::path::Path;
use std::sync::OnceLock;

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RelatedFiles {
    pub target: String,
    pub imports: Vec<String>,
    pub importers: Vec<String>,
    pub tests: Vec<String>,
}

#[derive(Debug, Clone, Default)]
pub struct DependencyGraph {
    /// file -> set of files it directly imports
    pub imports: HashMap<String, BTreeSet<String>>,
    /// file -> set of files that directly import it
    pub importers: HashMap<String, BTreeSet<String>>,
    /// file -> set of matching test files
    pub matching_tests: HashMap<String, BTreeSet<String>>,
}

impl DependencyGraph {
    pub fn build(root: &Path, entries: &[DirEntryMeta]) -> Self {
        let file_set: HashSet<String> = entries
            .iter()
            .filter(|e| !e.is_dir)
            .map(|e| normalize_rel_path(&e.path))
            .collect();

        let mut imports: HashMap<String, BTreeSet<String>> = HashMap::new();
        let mut importers: HashMap<String, BTreeSet<String>> = HashMap::new();

        for rel in &file_set {
            let ext = Path::new(rel)
                .extension()
                .and_then(|e| e.to_str())
                .unwrap_or("")
                .to_ascii_lowercase();
            if !matches!(
                ext.as_str(),
                "rs" | "ts" | "tsx" | "js" | "jsx" | "mjs" | "cjs" | "py" | "cs" | "go"
            ) {
                continue;
            }
            let full = root.join(rel);
            let Ok(meta) = std::fs::metadata(&full) else {
                continue;
            };
            if !meta.is_file() || meta.len() > 512 * 1024 {
                continue;
            }
            let Ok(content) = std::fs::read_to_string(&full) else {
                continue;
            };

            let resolved = resolve_file_imports(rel, &ext, &content, &file_set);
            for target in &resolved {
                if target != rel {
                    imports
                        .entry(rel.clone())
                        .or_default()
                        .insert(target.clone());
                    importers
                        .entry(target.clone())
                        .or_default()
                        .insert(rel.clone());
                }
            }
        }

        let matching_tests = match_test_files(&file_set, &importers);

        Self {
            imports,
            importers,
            matching_tests,
        }
    }

    pub fn related_for(&self, path: &str) -> RelatedFiles {
        let norm = normalize_rel_path(Path::new(path));
        let imports = self
            .imports
            .get(&norm)
            .map(|s| s.iter().cloned().collect())
            .unwrap_or_default();
        let importers = self
            .importers
            .get(&norm)
            .map(|s| s.iter().cloned().collect())
            .unwrap_or_default();
        let tests = self
            .matching_tests
            .get(&norm)
            .map(|s| s.iter().cloned().collect())
            .unwrap_or_default();
        RelatedFiles {
            target: norm,
            imports,
            importers,
            tests,
        }
    }
}

fn ts_import_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r#"(?:import|export)\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]|require\(\s*['"]([^'"]+)['"]\s*\)"#)
            .expect("valid ts import regex")
    })
}

fn rust_use_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"(?m)^\s*(?:pub\s+)?(?:use\s+(?:crate|super|self)::([a-zA-Z0-9_:]+)|mod\s+([a-zA-Z0-9_]+)\s*;)")
            .expect("valid rust use/mod regex")
    })
}

fn py_import_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"(?m)^\s*(?:from\s+([.a-zA-Z0-9_]+)\s+import|import\s+([a-zA-Z0-9_.]+))")
            .expect("valid python import regex")
    })
}

fn resolve_file_imports(
    source_path: &str,
    ext: &str,
    content: &str,
    all_files: &HashSet<String>,
) -> BTreeSet<String> {
    let mut found = BTreeSet::new();
    let parent_dir = Path::new(source_path)
        .parent()
        .map(normalize_rel_path)
        .unwrap_or_default();

    match ext {
        "ts" | "tsx" | "js" | "jsx" | "mjs" | "cjs" => {
            for caps in ts_import_re().captures_iter(content) {
                let Some(spec) = caps.get(1).or_else(|| caps.get(2)).map(|m| m.as_str()) else {
                    continue;
                };
                if !spec.starts_with('.') {
                    continue;
                }
                let joined = join_relative(&parent_dir, spec);
                for candidate in [
                    joined.clone(),
                    format!("{joined}.ts"),
                    format!("{joined}.tsx"),
                    format!("{joined}.js"),
                    format!("{joined}.jsx"),
                    format!("{joined}/index.ts"),
                    format!("{joined}/index.tsx"),
                    format!("{joined}/index.js"),
                ] {
                    if all_files.contains(&candidate) {
                        found.insert(candidate);
                        break;
                    }
                }
            }
        }
        "rs" => {
            // Determine crate root prefix (e.g., "src" if source_path starts with "src/")
            let crate_dir = if let Some(idx) = source_path.find("/src/") {
                &source_path[..idx + 4]
            } else if source_path.starts_with("src/") {
                "src"
            } else {
                ""
            };

            for caps in rust_use_re().captures_iter(content) {
                if let Some(use_path) = caps.get(1).map(|m| m.as_str()) {
                    let segments: Vec<&str> =
                        use_path.split("::").filter(|s| !s.is_empty()).collect();
                    for len in (1..=segments.len().min(3)).rev() {
                        let rel_mod = segments[..len].join("/");
                        let prefix = if crate_dir.is_empty() {
                            rel_mod.clone()
                        } else {
                            format!("{crate_dir}/{rel_mod}")
                        };
                        for candidate in [format!("{prefix}.rs"), format!("{prefix}/mod.rs")] {
                            if all_files.contains(&candidate) {
                                found.insert(candidate);
                            }
                        }
                    }
                } else if let Some(mod_name) = caps.get(2).map(|m| m.as_str()) {
                    let base_dir = if source_path.ends_with("/mod.rs")
                        || source_path.ends_with("/lib.rs")
                        || source_path.ends_with("/main.rs")
                        || source_path == "lib.rs"
                        || source_path == "main.rs"
                    {
                        parent_dir.clone()
                    } else {
                        let stem = source_path.strip_suffix(".rs").unwrap_or(source_path);
                        stem.to_string()
                    };
                    for dir in [&base_dir, &parent_dir] {
                        let prefix = if dir.is_empty() {
                            mod_name.to_string()
                        } else {
                            format!("{dir}/{mod_name}")
                        };
                        for candidate in [format!("{prefix}.rs"), format!("{prefix}/mod.rs")] {
                            if all_files.contains(&candidate) {
                                found.insert(candidate);
                            }
                        }
                    }
                }
            }
        }
        "py" => {
            for caps in py_import_re().captures_iter(content) {
                let Some(spec) = caps.get(1).or_else(|| caps.get(2)).map(|m| m.as_str()) else {
                    continue;
                };
                let trimmed = spec.trim_start_matches('.');
                if trimmed.is_empty() {
                    continue;
                }
                let rel_mod = trimmed.replace('.', "/");
                for base in [&parent_dir, ""] {
                    let prefix = if base.is_empty() {
                        rel_mod.clone()
                    } else {
                        format!("{base}/{rel_mod}")
                    };
                    for candidate in [format!("{prefix}.py"), format!("{prefix}/__init__.py")] {
                        if all_files.contains(&candidate) {
                            found.insert(candidate);
                        }
                    }
                }
            }
        }
        _ => {}
    }

    found
}

fn join_relative(base_dir: &str, rel_spec: &str) -> String {
    let mut parts: Vec<&str> = if base_dir.is_empty() {
        Vec::new()
    } else {
        base_dir.split('/').filter(|s| !s.is_empty()).collect()
    };
    for seg in rel_spec.split('/') {
        match seg {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            other => parts.push(other),
        }
    }
    parts.join("/")
}

fn is_test_path(path: &str) -> bool {
    let lower = path.to_ascii_lowercase();
    lower.starts_with("tests/")
        || lower.starts_with("test/")
        || lower.contains("/tests/")
        || lower.contains("/test/")
        || lower.contains("/__tests__/")
        || lower.contains("/e2e/")
        || lower.ends_with(".test.ts")
        || lower.ends_with(".test.tsx")
        || lower.ends_with(".test.js")
        || lower.ends_with(".spec.ts")
        || lower.ends_with(".spec.tsx")
        || lower.ends_with(".spec.js")
        || lower.ends_with("_test.rs")
        || lower.ends_with("_test.go")
        || lower.ends_with("_test.py")
        || lower
            .rsplit('/')
            .next()
            .is_some_and(|f| f.starts_with("test_"))
}

fn file_stem_normalized(path: &str) -> String {
    let file_name = path.rsplit('/').next().unwrap_or(path).to_ascii_lowercase();
    let without_ext = file_name.split('.').next().unwrap_or(&file_name);
    without_ext
        .strip_prefix("test_")
        .or_else(|| without_ext.strip_suffix("_test"))
        .or_else(|| without_ext.strip_suffix("_tests"))
        .unwrap_or(without_ext)
        .to_string()
}

fn match_test_files(
    all_files: &HashSet<String>,
    importers: &HashMap<String, BTreeSet<String>>,
) -> HashMap<String, BTreeSet<String>> {
    let test_files: Vec<&String> = all_files.iter().filter(|p| is_test_path(p)).collect();
    let mut map: HashMap<String, BTreeSet<String>> = HashMap::new();

    for file in all_files {
        let mut matched = BTreeSet::new();
        // 1. Any test file that directly imports `file`
        if let Some(imps) = importers.get(file) {
            for imp in imps {
                if is_test_path(imp) {
                    matched.insert(imp.clone());
                }
            }
        }
        // 2. Any test file sharing the normalized stem (e.g., `secrets.rs` <-> `secrets.spec.ts` / `secrets_test.rs`)
        let stem = file_stem_normalized(file);
        if !stem.is_empty() && stem != "mod" && stem != "index" && stem != "main" && stem != "lib" {
            for &tf in &test_files {
                if tf != file && file_stem_normalized(tf) == stem {
                    matched.insert(tf.clone());
                }
            }
        }
        if !matched.is_empty() {
            map.insert(file.clone(), matched);
        }
    }

    map
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    #[test]
    fn resolves_ts_and_rust_imports_and_tests() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::create_dir_all(root.join("src")).unwrap();
        fs::create_dir_all(root.join("tests")).unwrap();

        fs::write(root.join("src/lib.rs"), "pub mod util;\n").unwrap();
        fs::write(
            root.join("src/main.rs"),
            "use crate::util::helper;\nfn main() {}\n",
        )
        .unwrap();
        fs::write(root.join("src/util.rs"), "pub fn helper() {}\n").unwrap();
        fs::write(root.join("tests/util_test.rs"), "// tests util\n").unwrap();

        fs::write(
            root.join("src/App.tsx"),
            "import { redact } from './secrets';\n",
        )
        .unwrap();
        fs::write(root.join("src/secrets.ts"), "export function redact() {}\n").unwrap();
        fs::write(
            root.join("tests/secrets.spec.ts"),
            "import { redact } from '../src/secrets';\n",
        )
        .unwrap();

        let entries: Vec<DirEntryMeta> = [
            "src/lib.rs",
            "src/main.rs",
            "src/util.rs",
            "tests/util_test.rs",
            "src/App.tsx",
            "src/secrets.ts",
            "tests/secrets.spec.ts",
        ]
        .iter()
        .map(|p| DirEntryMeta {
            path: PathBuf::from(p),
            is_dir: false,
            size: Some(20),
        })
        .collect();

        let graph = DependencyGraph::build(root, &entries);

        let app_rel = graph.related_for("src/App.tsx");
        assert_eq!(app_rel.imports, vec!["src/secrets.ts"]);

        let sec_rel = graph.related_for("src/secrets.ts");
        assert!(sec_rel.importers.contains(&"src/App.tsx".to_string()));
        assert!(sec_rel.tests.contains(&"tests/secrets.spec.ts".to_string()));

        let util_rel = graph.related_for("src/util.rs");
        assert!(util_rel.importers.contains(&"src/main.rs".to_string()));
        assert!(util_rel.tests.contains(&"tests/util_test.rs".to_string()));
    }
}
