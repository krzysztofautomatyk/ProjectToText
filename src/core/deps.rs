//! Intra-repository import & dependency graph resolver.
//!
//! Parses `use` / `mod` (Rust, including brace-grouped `use crate::a::{b::X, c::Y}`),
//! `import ... from` / `export ... from` / `require(...)` (TS/JS, including ESM `.js`
//! specifiers that point at `.ts` sources and `@/` aliases), `import` / `from ... import`
//! (Python), and `using` (C#) to resolve relative and crate-local file dependencies inside a
//! workspace snapshot. File reading and import extraction run in parallel.

use crate::core::preview::{is_link, read_verified_file_string};
use crate::core::walker::{normalize_rel_path, DirEntryMeta};
use rayon::prelude::*;
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeSet, HashMap, HashSet};
use std::path::Path;
use std::sync::{Arc, OnceLock};
use std::time::SystemTime;

/// One file's cached state: the `(mtime, len)` stamp it was read with, its text, and its resolved imports.
#[derive(Debug, Clone)]
struct CachedFileEntry {
    mtime: Option<SystemTime>,
    len: u64,
    content: Arc<str>,
    resolved: BTreeSet<String>,
}

/// One file's cache entry, keyed by its relative path.
type FileResolution = (String, CachedFileEntry);

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
    /// file -> cached text and imports, reused by `build_incremental` while the stamp matches.
    file_cache: HashMap<String, CachedFileEntry>,
    /// The file set the cache was resolved against.
    cached_files: HashSet<String>,
}

impl DependencyGraph {
    pub fn build(root: &Path, entries: &[DirEntryMeta]) -> Self {
        Self::build_incremental(root, entries, None)
    }

    /// Rebuilds the graph. A file whose `(mtime, len)` is unchanged is never read from disk again: its
    /// cached text is reused. When the file set changed, its imports are re-resolved from that text,
    /// because a new file can satisfy an import that previously resolved to nothing.
    pub fn build_incremental(
        root: &Path,
        entries: &[DirEntryMeta],
        previous: Option<&DependencyGraph>,
    ) -> Self {
        let file_set: HashSet<String> = entries
            .iter()
            .filter(|e| !e.is_dir)
            .map(|e| normalize_rel_path(&e.path))
            .collect();

        let same_file_set = previous.is_some_and(|p| p.cached_files == file_set);
        let index = FileLookupIndex::new(&file_set);

        // Reading and parsing each file is independent, so it runs on the rayon pool. The
        // results are merged afterwards, which keeps the graph deterministic (BTreeSet values).
        let resolved_per_file: Vec<FileResolution> = file_set
            .par_iter()
            .filter_map(|rel| {
                let ext = Path::new(rel)
                    .extension()
                    .and_then(|e| e.to_str())
                    .unwrap_or("")
                    .to_ascii_lowercase();
                if !matches!(
                    ext.as_str(),
                    "rs" | "ts" | "tsx" | "js" | "jsx" | "mjs" | "cjs" | "py" | "cs" | "go"
                ) {
                    return None;
                }
                let full = root.join(rel);
                let meta = std::fs::symlink_metadata(&full).ok()?;
                if is_link(&meta) || !meta.is_file() || meta.len() > 512 * 1024 {
                    return None;
                }
                let stamp = (meta.modified().ok(), meta.len());
                // A stamp without an mtime cannot prove the file is unchanged, so it is never reused.
                let cached = if stamp.0.is_some() {
                    previous
                        .and_then(|p| p.file_cache.get(rel))
                        .filter(|entry| (entry.mtime, entry.len) == stamp)
                } else {
                    None
                };
                let entry = match cached {
                    Some(entry) => {
                        // Unchanged file: its text is already in memory, so it is not read again.
                        let resolved = if same_file_set {
                            entry.resolved.clone()
                        } else {
                            resolve_file_imports(rel, &ext, &entry.content, &index)
                        };
                        CachedFileEntry {
                            mtime: stamp.0,
                            len: stamp.1,
                            content: Arc::clone(&entry.content),
                            resolved,
                        }
                    }
                    None => {
                        let content: Arc<str> =
                            read_verified_file_string(&full, 512 * 1024).ok()?.into();
                        let resolved = resolve_file_imports(rel, &ext, &content, &index);
                        CachedFileEntry {
                            mtime: stamp.0,
                            len: stamp.1,
                            content,
                            resolved,
                        }
                    }
                };
                Some((rel.clone(), entry))
            })
            .collect();

        let mut imports: HashMap<String, BTreeSet<String>> = HashMap::new();
        let mut importers: HashMap<String, BTreeSet<String>> = HashMap::new();
        let mut file_cache = HashMap::with_capacity(resolved_per_file.len());
        for (rel, entry) in resolved_per_file {
            for target in &entry.resolved {
                if *target != rel {
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
            file_cache.insert(rel, entry);
        }

        let matching_tests = match_test_files(&file_set, &importers);

        Self {
            imports,
            importers,
            matching_tests,
            file_cache,
            cached_files: file_set,
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

/// `use crate::a::b::{c::X, d, e::{f, g}};`: captures the module prefix (`a::b::`) and the
/// brace-group body. The body runs to the statement's `;`, so nested braces are included.
fn rust_use_group_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(
            r"(?ms)^\s*(?:pub\s+)?use\s+(?:crate|super|self)::((?:[a-zA-Z0-9_]+::)*)\{([^;]*)\}",
        )
        .expect("valid rust grouped use regex")
    })
}

fn py_import_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"(?m)^\s*(?:from\s+([.a-zA-Z0-9_]+)\s+import|import\s+([a-zA-Z0-9_.]+))")
            .expect("valid python import regex")
    })
}

fn go_single_import_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r#"(?m)^\s*import\s+(?:[a-zA-Z0-9_.]+\s+)?"([^"]+)""#)
            .expect("valid go single import regex")
    })
}

fn go_grouped_import_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r#"(?ms)^\s*import\s*\(([^)]*)\)"#).expect("valid go grouped import regex")
    })
}

fn go_spec_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r#"(?:[a-zA-Z0-9_.]+\s+)?"([^"]+)""#).expect("valid go spec regex")
    })
}

fn cs_using_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r#"(?m)^\s*using\s+(?:static\s+)?(?:[a-zA-Z0-9_]+\s*=\s*)?([a-zA-Z0-9_.]+)\s*;"#)
            .expect("valid cs using regex")
    })
}

/// The first identifier of each top-level item in a brace group.
/// `deps::Foo, git::{Bar, Baz}, self` -> `["deps", "git"]` (`self` refers to the prefix itself).
fn group_items(body: &str) -> Vec<String> {
    let mut items: Vec<String> = Vec::new();
    let mut depth = 0i32;
    let mut current = String::new();
    for ch in body.chars().chain(std::iter::once(',')) {
        match ch {
            '{' => {
                depth += 1;
                current.push(ch);
            }
            '}' => {
                depth -= 1;
                current.push(ch);
            }
            ',' if depth == 0 => items.push(std::mem::take(&mut current)),
            _ => current.push(ch),
        }
    }
    items
        .into_iter()
        .filter_map(|item| {
            let ident: String = item
                .trim()
                .chars()
                .take_while(|c| c.is_ascii_alphanumeric() || *c == '_')
                .collect();
            (!ident.is_empty() && ident != "self").then_some(ident)
        })
        .collect()
}

/// Finds `<crate_dir>/<module>.rs` or `<crate_dir>/<module>/mod.rs` for a `::`-free path.
fn find_rust_module(module: &str, crate_dir: &str, all_files: &HashSet<String>) -> Option<String> {
    let prefix = if crate_dir.is_empty() {
        module.to_string()
    } else {
        format!("{crate_dir}/{module}")
    };
    [format!("{prefix}.rs"), format!("{prefix}/mod.rs")]
        .into_iter()
        .find(|candidate| all_files.contains(candidate))
}

/// The `src` directory that contains `source_path`, used for `@/` aliases and crate roots.
fn src_root_of(source_path: &str) -> Option<String> {
    if let Some(idx) = source_path.find("/src/") {
        return Some(source_path[..idx + 4].to_string());
    }
    source_path.starts_with("src/").then(|| "src".to_string())
}

/// Resolves a TS/JS module path (without extension) to a file in the project.
/// ESM code often imports `./util.js` when the source is `util.ts` or `util.tsx`, so the `.js`
/// family is also probed with TypeScript extensions.
fn probe_ts_module(joined: &str, all_files: &HashSet<String>) -> Option<String> {
    let mut candidates = vec![joined.to_string()];
    for js_ext in [".js", ".jsx", ".mjs", ".cjs"] {
        if let Some(stem) = joined.strip_suffix(js_ext) {
            candidates.push(format!("{stem}.ts"));
            candidates.push(format!("{stem}.tsx"));
        }
    }
    candidates.extend([
        format!("{joined}.ts"),
        format!("{joined}.tsx"),
        format!("{joined}.js"),
        format!("{joined}.jsx"),
        format!("{joined}/index.ts"),
        format!("{joined}/index.tsx"),
        format!("{joined}/index.js"),
    ]);
    candidates
        .into_iter()
        .find(|candidate| all_files.contains(candidate))
}

struct FileLookupIndex<'a> {
    all_files: &'a HashSet<String>,
    /// dir_path (bez końcowego '/') -> posortowana lista plików .go bezpośrednio w tym katalogu
    go_files_by_dir: HashMap<String, Vec<String>>,
    /// suffix katalogu (do 4 segmentów) -> lista plików .go lub .cs
    go_by_suffix: HashMap<String, Vec<String>>,
    cs_by_suffix: HashMap<String, Vec<String>>,
    /// nazwa pliku "ClassName.cs" -> lista pełnych ścieżek względnych
    cs_by_filename: HashMap<String, Vec<String>>,
}

impl<'a> FileLookupIndex<'a> {
    fn new(all_files: &'a HashSet<String>) -> Self {
        let mut go_files_by_dir: HashMap<String, Vec<String>> = HashMap::new();
        let mut go_by_suffix: HashMap<String, Vec<String>> = HashMap::new();
        let mut cs_by_suffix: HashMap<String, Vec<String>> = HashMap::new();
        let mut cs_by_filename: HashMap<String, Vec<String>> = HashMap::new();

        for f in all_files {
            let (dir, file_name) = match f.rfind('/') {
                Some(idx) => (&f[..idx], &f[idx + 1..]),
                None => ("", f.as_str()),
            };

            if f.ends_with(".go") {
                go_files_by_dir
                    .entry(dir.to_string())
                    .or_default()
                    .push(f.clone());

                let segments: Vec<&str> = dir.split('/').filter(|s| !s.is_empty()).collect();
                for len in 1..=segments.len().min(4) {
                    let suffix = segments[segments.len() - len..].join("/");
                    go_by_suffix.entry(suffix).or_default().push(f.clone());
                }
            } else if f.ends_with(".cs") {
                let segments: Vec<&str> = dir.split('/').filter(|s| !s.is_empty()).collect();
                for len in 1..=segments.len().min(4) {
                    let suffix = segments[segments.len() - len..].join("/");
                    cs_by_suffix.entry(suffix).or_default().push(f.clone());
                }

                cs_by_filename
                    .entry(file_name.to_string())
                    .or_default()
                    .push(f.clone());
            }
        }

        for list in go_files_by_dir.values_mut() {
            list.sort();
        }
        for list in go_by_suffix.values_mut() {
            list.sort();
        }
        for list in cs_by_suffix.values_mut() {
            list.sort();
        }
        for list in cs_by_filename.values_mut() {
            list.sort();
        }

        Self {
            all_files,
            go_files_by_dir,
            go_by_suffix,
            cs_by_suffix,
            cs_by_filename,
        }
    }
}

fn resolve_file_imports(
    source_path: &str,
    ext: &str,
    content: &str,
    index: &FileLookupIndex<'_>,
) -> BTreeSet<String> {
    let mut found = BTreeSet::new();
    let parent_dir = Path::new(source_path)
        .parent()
        .map(normalize_rel_path)
        .unwrap_or_default();

    match ext {
        "ts" | "tsx" | "js" | "jsx" | "mjs" | "cjs" => {
            // `@/x` is an alias for the project's `src` directory. Try the file's own `src`
            // root first, then the two common layouts.
            let mut alias_bases: Vec<String> = src_root_of(source_path).into_iter().collect();
            for fallback in ["src", "ui/src"] {
                if !alias_bases.iter().any(|b| b == fallback) {
                    alias_bases.push(fallback.to_string());
                }
            }
            for caps in ts_import_re().captures_iter(content) {
                let Some(spec) = caps.get(1).or_else(|| caps.get(2)).map(|m| m.as_str()) else {
                    continue;
                };
                let joins: Vec<String> = if spec.starts_with('.') {
                    vec![join_relative(&parent_dir, spec)]
                } else if let Some(rest) = spec.strip_prefix("@/") {
                    alias_bases
                        .iter()
                        .map(|base| join_relative(base, rest))
                        .collect()
                } else {
                    continue;
                };
                for joined in joins {
                    if let Some(hit) = probe_ts_module(&joined, index.all_files) {
                        found.insert(hit);
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
                        if let Some(hit) = find_rust_module(&rel_mod, crate_dir, index.all_files) {
                            found.insert(hit);
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
                            if index.all_files.contains(&candidate) {
                                found.insert(candidate);
                            }
                        }
                    }
                }
            }

            // Grouped imports: `use crate::core::{deps::Foo, git::Bar};` resolves both
            // `core/deps` and `core/git`. Each item's first segment is one module.
            for caps in rust_use_group_re().captures_iter(content) {
                let prefix: Vec<&str> = caps[1].split("::").filter(|s| !s.is_empty()).collect();
                let prefix_path = prefix.join("/");
                let mut modules: Vec<String> = group_items(&caps[2])
                    .into_iter()
                    .map(|item| {
                        if prefix_path.is_empty() {
                            item
                        } else {
                            format!("{prefix_path}/{item}")
                        }
                    })
                    .collect();
                if !prefix_path.is_empty() {
                    modules.push(prefix_path.clone());
                }
                for module in modules {
                    if let Some(hit) = find_rust_module(&module, crate_dir, index.all_files) {
                        found.insert(hit);
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
                        if index.all_files.contains(&candidate) {
                            found.insert(candidate);
                        }
                    }
                }
            }
        }
        "go" => {
            let mut specs = Vec::new();
            for caps in go_single_import_re().captures_iter(content) {
                if let Some(spec) = caps.get(1).map(|m| m.as_str()) {
                    specs.push(spec);
                }
            }
            for group in go_grouped_import_re().captures_iter(content) {
                if let Some(body) = group.get(1).map(|m| m.as_str()) {
                    for caps in go_spec_re().captures_iter(body) {
                        if let Some(spec) = caps.get(1).map(|m| m.as_str()) {
                            specs.push(spec);
                        }
                    }
                }
            }

            for spec in specs {
                let spec = spec.trim();
                if spec.is_empty() {
                    continue;
                }
                if spec.starts_with('.') {
                    let target_dir = join_relative(&parent_dir, spec);
                    if let Some(files) = index.go_files_by_dir.get(&target_dir) {
                        for f in files {
                            found.insert(f.clone());
                        }
                    }
                } else {
                    let segments: Vec<&str> = spec.split('/').filter(|s| !s.is_empty()).collect();
                    for len in (1..=segments.len().min(4)).rev() {
                        let sub_dir = segments[segments.len() - len..].join("/");
                        if let Some(files) = index.go_by_suffix.get(&sub_dir) {
                            for f in files {
                                found.insert(f.clone());
                            }
                            break;
                        }
                    }
                }
            }
        }
        "cs" => {
            for caps in cs_using_re().captures_iter(content) {
                let Some(spec) = caps.get(1).map(|m| m.as_str()) else {
                    continue;
                };
                let spec = spec.trim();
                if spec.is_empty()
                    || spec == "System"
                    || spec.starts_with("System.")
                    || spec == "Microsoft"
                    || spec.starts_with("Microsoft.")
                {
                    continue;
                }

                let segments: Vec<&str> = spec.split('.').filter(|s| !s.is_empty()).collect();
                if segments.is_empty() {
                    continue;
                }

                for len in (1..=segments.len().min(4)).rev() {
                    let sub_dir = segments[segments.len() - len..].join("/");
                    if let Some(files) = index.cs_by_suffix.get(&sub_dir) {
                        for f in files {
                            found.insert(f.clone());
                        }
                        break;
                    }
                }

                let class_file = format!("{}.cs", segments[segments.len() - 1]);
                if let Some(files) = index.cs_by_filename.get(&class_file) {
                    for f in files {
                        found.insert(f.clone());
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
    let mut tests_by_stem: HashMap<String, Vec<&String>> = HashMap::new();
    for path in all_files.iter().filter(|path| is_test_path(path)) {
        let stem = file_stem_normalized(path);
        if !stem.is_empty() && !matches!(stem.as_str(), "mod" | "index" | "main" | "lib") {
            tests_by_stem.entry(stem).or_default().push(path);
        }
    }

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
        if let Some(candidates) = tests_by_stem.get(&stem) {
            for &test_file in candidates {
                if test_file != file {
                    matched.insert(test_file.clone());
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

    #[test]
    fn match_test_files_indexes_stems_and_preserves_direct_import_matches() {
        let all_files: HashSet<String> = [
            "src/auth.rs",
            "src/service.rs",
            "src/auth_test.rs",
            "tests/auth.spec.ts",
            "tests/service_flow_test.rs",
            "src/mod.rs",
            "tests/mod_test.rs",
            "src/index.rs",
            "tests/index_test.rs",
            "src/main.rs",
            "tests/main_test.rs",
            "src/lib.rs",
            "tests/lib_test.rs",
            "src/.rs",
            "tests/test_.rs",
        ]
        .into_iter()
        .map(str::to_string)
        .collect();
        let importers: HashMap<String, BTreeSet<String>> = [
            (
                "src/service.rs".to_string(),
                ["tests/service_flow_test.rs".to_string()]
                    .into_iter()
                    .collect(),
            ),
            (
                "src/mod.rs".to_string(),
                ["tests/mod_test.rs".to_string()].into_iter().collect(),
            ),
        ]
        .into_iter()
        .collect();

        let matches = match_test_files(&all_files, &importers);
        let expected = |paths: &[&str]| paths.iter().map(|path| path.to_string()).collect();
        assert_eq!(
            matches.get("src/auth.rs"),
            Some(&expected(&["src/auth_test.rs", "tests/auth.spec.ts"]))
        );
        assert_eq!(
            matches.get("src/service.rs"),
            Some(&expected(&["tests/service_flow_test.rs"]))
        );
        assert_eq!(
            matches.get("src/mod.rs"),
            Some(&expected(&["tests/mod_test.rs"]))
        );

        for stem in ["mod", "index", "main", "lib"] {
            assert!(
                !matches.contains_key(&format!("tests/{stem}_test.rs")),
                "reserved test stem {stem:?} should not match by stem"
            );
            if stem != "mod" {
                assert!(
                    !matches.contains_key(&format!("src/{stem}.rs")),
                    "reserved target stem {stem:?} should not match by stem"
                );
            }
        }
        assert!(file_stem_normalized("tests/test_.rs").is_empty());
        assert!(!matches.contains_key("src/.rs"));
        assert!(!matches.contains_key("tests/test_.rs"));
    }

    #[test]
    fn incremental_graph_skips_disk_read_when_file_set_changes() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::create_dir_all(root.join("src")).unwrap();
        let a = root.join("src/a.ts");
        fs::write(&a, "import './b';\nimport './c';\n").unwrap();
        fs::write(root.join("src/b.ts"), "export const b = 1;\n").unwrap();
        let entry = |p: &str| DirEntryMeta {
            path: PathBuf::from(p),
            is_dir: false,
            size: Some(20),
        };

        let first = DependencyGraph::build(root, &[entry("src/a.ts"), entry("src/b.ts")]);
        let first_a = first.imports.get("src/a.ts").cloned().unwrap_or_default();
        assert!(first_a.contains("src/b.ts"), "{first_a:?}");
        // `src/c.ts` does not exist yet, so `./c` resolves to nothing.
        assert!(!first_a.contains("src/c.ts"), "{first_a:?}");

        // Add `c.ts`. Then rewrite `a.ts` with same-length text that no longer imports `./c`, and restore
        // its original mtime. The stamp still matches, so the cached text must be used. Reading the file
        // again would drop the `./c` import.
        let original_mtime = fs::metadata(&a).unwrap().modified().unwrap();
        fs::write(root.join("src/c.ts"), "export const c = 2;\n").unwrap();
        fs::write(&a, "import './b';\nimport './x';\n").unwrap();
        fs::OpenOptions::new()
            .write(true)
            .open(&a)
            .unwrap()
            .set_modified(original_mtime)
            .unwrap();

        let second = DependencyGraph::build_incremental(
            root,
            &[entry("src/a.ts"), entry("src/b.ts"), entry("src/c.ts")],
            Some(&first),
        );
        let second_a = second.imports.get("src/a.ts").cloned().unwrap_or_default();
        assert!(second_a.contains("src/b.ts"), "{second_a:?}");
        assert!(second_a.contains("src/c.ts"), "{second_a:?}");
        assert!(
            second
                .importers
                .get("src/c.ts")
                .is_some_and(|s| s.contains("src/a.ts")),
            "{second:?}"
        );
    }

    #[test]
    fn resolves_grouped_rust_use_and_esm_js_specifiers() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::create_dir_all(root.join("src/core")).unwrap();
        fs::write(
            root.join("src/main.rs"),
            "use crate::core::{deps::Foo, git::{inspect, compute}};\nfn main() {}\n",
        )
        .unwrap();
        fs::write(root.join("src/core/deps.rs"), "pub struct Foo;\n").unwrap();
        fs::write(root.join("src/core/git.rs"), "pub fn inspect() {}\n").unwrap();
        fs::write(root.join("src/util.ts"), "export const x = 1;\n").unwrap();
        fs::write(
            root.join("src/app.ts"),
            "import { x } from './util.js';\nimport { y } from '@/util';\n",
        )
        .unwrap();

        let entries: Vec<DirEntryMeta> = [
            "src/main.rs",
            "src/core/deps.rs",
            "src/core/git.rs",
            "src/util.ts",
            "src/app.ts",
        ]
        .iter()
        .map(|p| DirEntryMeta {
            path: PathBuf::from(p),
            is_dir: false,
            size: Some(20),
        })
        .collect();

        let graph = DependencyGraph::build(root, &entries);

        let main = graph.related_for("src/main.rs");
        assert!(
            main.imports.contains(&"src/core/deps.rs".to_string()),
            "{main:?}"
        );
        assert!(
            main.imports.contains(&"src/core/git.rs".to_string()),
            "{main:?}"
        );

        let app = graph.related_for("src/app.ts");
        assert_eq!(app.imports, vec!["src/util.ts"], "{app:?}");
    }

    #[test]
    fn resolves_go_and_csharp_imports() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::create_dir_all(root.join("pkg/auth")).unwrap();
        fs::create_dir_all(root.join("cmd/server")).unwrap();
        fs::write(root.join("pkg/auth/auth.go"), "package auth\n").unwrap();
        fs::write(
            root.join("cmd/server/main.go"),
            "package main\n\nimport (\n\t\"fmt\"\n\t\"example.com/project/pkg/auth\"\n)\n\nfunc main() {}\n",
        )
        .unwrap();

        fs::create_dir_all(root.join("ProSCADA/Core/Preview")).unwrap();
        fs::create_dir_all(root.join("ProSCADA/Services")).unwrap();
        fs::write(
            root.join("ProSCADA/Core/Preview/PreviewEngine.cs"),
            "namespace ProSCADA.Core.Preview;\npublic class PreviewEngine {}\n",
        )
        .unwrap();
        fs::write(
            root.join("ProSCADA/Services/ProjectService.cs"),
            "using System;\nusing ProSCADA.Core.Preview;\nusing static PreviewEngine;\n\nnamespace ProSCADA.Services;\npublic class ProjectService {}\n",
        )
        .unwrap();

        let entries: Vec<DirEntryMeta> = [
            "pkg/auth/auth.go",
            "cmd/server/main.go",
            "ProSCADA/Core/Preview/PreviewEngine.cs",
            "ProSCADA/Services/ProjectService.cs",
        ]
        .iter()
        .map(|p| DirEntryMeta {
            path: PathBuf::from(p),
            is_dir: false,
            size: Some(50),
        })
        .collect();

        let graph = DependencyGraph::build(root, &entries);

        let go_main = graph.related_for("cmd/server/main.go");
        assert!(
            go_main.imports.contains(&"pkg/auth/auth.go".to_string()),
            "Go import not resolved: {go_main:?}"
        );

        let cs_service = graph.related_for("ProSCADA/Services/ProjectService.cs");
        assert!(
            cs_service
                .imports
                .contains(&"ProSCADA/Core/Preview/PreviewEngine.cs".to_string()),
            "C# using not resolved: {cs_service:?}"
        );
    }

    #[test]
    fn go_and_csharp_o1_lookup_resolves_relative_and_multi_segment_imports() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();

        fs::create_dir_all(root.join("pkg/api/sub")).unwrap();
        fs::create_dir_all(root.join("pkg/models")).unwrap();
        fs::write(root.join("pkg/api/sub/sub.go"), "package sub\n").unwrap();
        fs::write(root.join("pkg/models/user.go"), "package models\n").unwrap();
        fs::write(
            root.join("pkg/api/handlers.go"),
            "package api\n\nimport (\n\t\"./sub\"\n\t\"../models\"\n)\n",
        )
        .unwrap();

        fs::create_dir_all(root.join("Company/Platform/Security/Auth")).unwrap();
        fs::create_dir_all(root.join("Company/App")).unwrap();
        fs::write(
            root.join("Company/Platform/Security/Auth/Token.cs"),
            "namespace Company.Platform.Security.Auth;\npublic class Token {}\n",
        )
        .unwrap();
        fs::write(
            root.join("Company/App/Program.cs"),
            "using Company.Platform.Security.Auth;\nusing static Token;\n\nnamespace Company.App;\npublic class Program {}\n",
        )
        .unwrap();

        let entries: Vec<DirEntryMeta> = [
            "pkg/api/sub/sub.go",
            "pkg/models/user.go",
            "pkg/api/handlers.go",
            "Company/Platform/Security/Auth/Token.cs",
            "Company/App/Program.cs",
        ]
        .iter()
        .map(|p| DirEntryMeta {
            path: PathBuf::from(p),
            is_dir: false,
            size: Some(60),
        })
        .collect();

        let graph = DependencyGraph::build(root, &entries);

        let handlers = graph.related_for("pkg/api/handlers.go");
        assert!(
            handlers.imports.contains(&"pkg/api/sub/sub.go".to_string()),
            "Go relative ./sub not resolved: {handlers:?}"
        );
        assert!(
            handlers.imports.contains(&"pkg/models/user.go".to_string()),
            "Go relative ../models not resolved: {handlers:?}"
        );

        let prog = graph.related_for("Company/App/Program.cs");
        assert!(
            prog.imports
                .contains(&"Company/Platform/Security/Auth/Token.cs".to_string()),
            "C# deep namespace or static class not resolved: {prog:?}"
        );
    }
}
