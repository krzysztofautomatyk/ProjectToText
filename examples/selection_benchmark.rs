use ptt::core::{
    output::{write_output_with_stats, OutputFormat, WriteOptions},
    skeleton::{extract_skeleton, language_for_path},
    tokenizer::count_tokens,
    walker::{path_is_selected, walk, DirEntryMeta, SelectionMatcher},
    workspace::WorkspaceIndex,
};
use std::{hint::black_box, path::Path, path::PathBuf, time::Instant};

fn pack_once(entries: &[DirEntryMeta], root: &Path, opts: &WriteOptions) -> Vec<u8> {
    let mut buf = Vec::new();
    write_output_with_stats(&mut buf, entries, root, opts, &|| false).unwrap();
    buf
}

/// Packs each 64-file chunk on its own, as the 0.4.0 build did. Chunks wait for one another.
fn pack_chunked_64(entries: &[DirEntryMeta], root: &Path, opts: &WriteOptions) {
    for chunk in entries.chunks(64) {
        let mut sink = Vec::new();
        write_output_with_stats(&mut sink, chunk, root, opts, &|| false).unwrap();
        black_box(sink);
    }
}

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
    println!("selection: 10000 paths / 8000 exact selections, 3 repetitions");
    println!(
        "legacy_ms={:.3}; matcher_including_build_ms={:.3}",
        median(&mut old),
        median(&mut new)
    );

    // 2. Cached lookup + mtime ignore validation benchmark
    let directory = tempfile::tempdir().unwrap();
    for path in candidates.iter().take(1_000) {
        let full = directory.path().join(path);
        std::fs::create_dir_all(full.parent().unwrap()).unwrap();
        std::fs::write(
            full,
            "pub fn compute(x: usize) -> usize {\n    let y = x * 2;\n    y + 1\n}\n",
        )
        .unwrap();
    }
    let index = WorkspaceIndex::default();
    let start = Instant::now();
    let snapshot = index.scan(directory.path()).unwrap();
    println!(
        "initial_non_git_scan_1000_files_ms={:.3}",
        start.elapsed().as_secs_f64() * 1000.0
    );
    let selected_1k: Vec<_> = candidates
        .iter()
        .take(800)
        .map(|p| p.to_string_lossy().into_owned())
        .collect();
    let mut cached = Vec::new();
    for _ in 0..5 {
        let start = Instant::now();
        let workspace = index.get(&snapshot.root, snapshot.revision).unwrap();
        let entries = workspace.selected(&selected_1k);
        assert_eq!(entries.len(), 800);
        black_box(entries);
        cached.push(start.elapsed().as_secs_f64() * 1000.0);
    }
    println!(
        "cached_lookup_mtime_rules_check_and_selection_ms={:.3} (5 repetitions)",
        median(&mut cached)
    );

    // 3. Packing throughput with realistic options (BPE counting and secret redaction on).
    // "Sequential" runs the same code on a one-thread rayon pool; "parallel" uses the default pool.
    // Each timing is the median of three repetitions, and both outputs must be byte-identical.
    let entries_to_pack = snapshot.selected(&selected_1k);
    let opts = WriteOptions {
        format: OutputFormat::Xml,
        redact_secrets: true,
        compute_bpe_tokens: true,
        ..Default::default()
    };
    let single_thread = rayon::ThreadPoolBuilder::new()
        .num_threads(1)
        .build()
        .unwrap();
    let mut seq_pack_ms = Vec::new();
    let mut par_pack_ms = Vec::new();
    for _ in 0..3 {
        let start = Instant::now();
        let seq_buf = single_thread.install(|| pack_once(&entries_to_pack, &snapshot.root, &opts));
        seq_pack_ms.push(start.elapsed().as_secs_f64() * 1000.0);

        let start = Instant::now();
        let par_buf = pack_once(&entries_to_pack, &snapshot.root, &opts);
        par_pack_ms.push(start.elapsed().as_secs_f64() * 1000.0);
        assert_eq!(seq_buf, par_buf);
    }
    println!(
        "pack_800_files: threads_parallel={}; sequential_1_thread_median_ms={:.3}; parallel_median_ms={:.3}",
        rayon::current_num_threads(),
        median(&mut seq_pack_ms),
        median(&mut par_pack_ms)
    );

    // 4. BPE tokenizer throughput and AST skeleton compression ratio on ptt itself.
    // File reads are excluded from every timing. The BPE encoder is warmed up first so its
    // one-time table load is not counted; each timing is the median of three repetitions.
    let repo_root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let repo_entries = walk(repo_root).unwrap();
    let mut sources: Vec<(String, &'static str)> = Vec::new();
    for entry in repo_entries.iter().filter(|e| !e.is_dir) {
        let lang = language_for_path(&entry.path);
        if lang == "other" {
            continue;
        }
        let Ok(content) = std::fs::read_to_string(repo_root.join(&entry.path)) else {
            continue;
        };
        sources.push((content, lang));
    }
    let total_bytes: usize = sources.iter().map(|(c, _)| c.len()).sum();
    black_box(count_tokens("warm-up encoder"));

    let mut bpe_full_ms = Vec::new();
    let mut full_tokens = 0usize;
    for _ in 0..3 {
        let start = Instant::now();
        full_tokens = sources.iter().map(|(c, _)| count_tokens(c)).sum();
        bpe_full_ms.push(start.elapsed().as_secs_f64() * 1000.0);
    }
    let bpe_full = median(&mut bpe_full_ms);

    let mut ast_ms = Vec::new();
    let mut skeletons: Vec<String> = Vec::new();
    for _ in 0..3 {
        let start = Instant::now();
        skeletons = sources
            .iter()
            .map(|(c, lang)| extract_skeleton(c, lang))
            .collect();
        ast_ms.push(start.elapsed().as_secs_f64() * 1000.0);
    }
    let ast = median(&mut ast_ms);

    let mut bpe_skel_ms = Vec::new();
    let mut skel_tokens = 0usize;
    for _ in 0..3 {
        let start = Instant::now();
        skel_tokens = skeletons.iter().map(|s| count_tokens(s)).sum();
        bpe_skel_ms.push(start.elapsed().as_secs_f64() * 1000.0);
    }
    let bpe_skel = median(&mut bpe_skel_ms);

    let reduction_pct = if full_tokens > 0 {
        100.0 * (1.0 - (skel_tokens as f64 / full_tokens as f64))
    } else {
        0.0
    };
    let mib = total_bytes as f64 / (1024.0 * 1024.0);
    println!(
        "bpe_tokenizer_full_source: files={}; bytes={total_bytes}; tokens={full_tokens}; median_ms={bpe_full:.3}; tokens_per_sec={:.0}; mib_per_sec={:.2}",
        sources.len(),
        full_tokens as f64 / (bpe_full / 1000.0),
        mib / (bpe_full / 1000.0)
    );
    println!("ast_skeleton_extraction: median_ms={ast:.3}");
    println!(
        "ptt_source_skeleton_compression: full_bpe_tokens={full_tokens}; skeleton_bpe_tokens={skel_tokens}; token_reduction={reduction_pct:.1}%; skeleton_bpe_median_ms={bpe_skel:.3}"
    );

    // 5. Chunked vs single-pass packing on an uneven workload. `chunked_64` reproduces the 0.4.0
    // structure: each 64-file chunk is packed on its own, so chunks wait for one another. It is a
    // simulation of that structure, not the 0.4.0 code. Every 32nd file is about 32 KB, the rest
    // about 1 KB. Each timing is the median of three repetitions.
    let uneven_dir = tempfile::tempdir().unwrap();
    let uneven_root = uneven_dir.path();
    let big = "pub fn heavy(x: usize) -> usize {\n    x * 2\n}\n".repeat(700);
    let small = "pub fn light(x: usize) -> usize {\n    x + 1\n}\n".repeat(20);
    let mut uneven = Vec::new();
    for i in 0..800usize {
        let rel = PathBuf::from(format!("pkg{}/mod{i}.rs", i / 50));
        let full = uneven_root.join(&rel);
        std::fs::create_dir_all(full.parent().unwrap()).unwrap();
        std::fs::write(&full, if i % 32 == 0 { &big } else { &small }).unwrap();
        uneven.push(DirEntryMeta {
            path: rel,
            is_dir: false,
            size: None,
        });
    }
    let mut single_thread_ms = Vec::new();
    let mut chunked_ms = Vec::new();
    let mut single_pass_ms = Vec::new();
    for _ in 0..3 {
        let start = Instant::now();
        black_box(single_thread.install(|| pack_once(&uneven, uneven_root, &opts)));
        single_thread_ms.push(start.elapsed().as_secs_f64() * 1000.0);

        let start = Instant::now();
        pack_chunked_64(&uneven, uneven_root, &opts);
        chunked_ms.push(start.elapsed().as_secs_f64() * 1000.0);

        let start = Instant::now();
        black_box(pack_once(&uneven, uneven_root, &opts));
        single_pass_ms.push(start.elapsed().as_secs_f64() * 1000.0);
    }
    println!(
        "pack_800_files_uneven: single_thread_ms={:.3}; chunked_64_ms={:.3}; single_pass_rayon_ms={:.3}",
        median(&mut single_thread_ms),
        median(&mut chunked_ms),
        median(&mut single_pass_ms)
    );
}
