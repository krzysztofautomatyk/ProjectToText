use ptt::core::{
    walker::{path_is_selected, SelectionMatcher},
    workspace::WorkspaceIndex,
};
use std::{hint::black_box, path::PathBuf, time::Instant};

fn main() {
    let candidates: Vec<_> = (0..10_000)
        .map(|i| PathBuf::from(format!("package{}/src/file{i}.rs", i / 100)))
        .collect();
    let selected: Vec<_> = candidates
        .iter()
        .take(8_000)
        .map(|path| path.to_string_lossy().into_owned())
        .collect();
    let matcher = SelectionMatcher::new(&selected);
    let expected: Vec<_> = candidates
        .iter()
        .filter(|path| selected.iter().any(|s| path_is_selected(path, s)))
        .cloned()
        .collect();
    let actual: Vec<_> = candidates
        .iter()
        .filter(|path| matcher.is_selected(path))
        .cloned()
        .collect();
    assert_eq!(expected, actual);
    assert_eq!(actual.len(), 8_000);
    let mut old = Vec::new();
    let mut new = Vec::new();
    for _ in 0..3 {
        let start = Instant::now();
        let count = candidates
            .iter()
            .filter(|path| selected.iter().any(|s| path_is_selected(path, s)))
            .count();
        black_box(count);
        old.push(start.elapsed().as_secs_f64() * 1000.0);
        let start = Instant::now();
        let matcher = SelectionMatcher::new(black_box(&selected));
        let count = candidates
            .iter()
            .filter(|path| matcher.is_selected(path))
            .count();
        assert_eq!(black_box(count), 8_000);
        new.push(start.elapsed().as_secs_f64() * 1000.0);
    }
    let median = |times: &mut Vec<f64>| {
        times.sort_by(f64::total_cmp);
        times[times.len() / 2]
    };
    println!("selection: 10000 paths / 8000 exact selections, 3 release repetitions");
    println!(
        "legacy_ms={:.3}; matcher_including_build_ms={:.3}",
        median(&mut old),
        median(&mut new)
    );

    let directory = tempfile::tempdir().unwrap();
    for path in &candidates {
        let full = directory.path().join(path);
        std::fs::create_dir_all(full.parent().unwrap()).unwrap();
        std::fs::write(full, "fn sample() {}\n").unwrap();
    }
    let index = WorkspaceIndex::default();
    let start = Instant::now();
    let snapshot = index.scan(directory.path()).unwrap();
    println!(
        "initial_non_git_scan_ms={:.3}",
        start.elapsed().as_secs_f64() * 1000.0
    );
    let mut cached = Vec::new();
    for _ in 0..5 {
        let start = Instant::now();
        let workspace = index.get(&snapshot.root, snapshot.revision).unwrap();
        let entries = workspace.selected(&selected);
        assert_eq!(entries.len(), 8_000);
        black_box(entries);
        cached.push(start.elapsed().as_secs_f64() * 1000.0);
    }
    println!(
        "cached_lookup_rules_check_and_selection_ms={:.3} (5 repetitions)",
        median(&mut cached)
    );
    println!(
        "Scope: no file-content reads, output serialization, IPC, debounce, or WebView rendering."
    );
}
