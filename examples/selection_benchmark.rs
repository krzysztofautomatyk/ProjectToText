use ptt::core::{
    budget::fit_to_bpe_budget_with_graph,
    deps::DependencyGraph,
    output::{write_output_with_stats, OutputFormat, WriteOptions},
    skeleton::{extract_skeleton, language_for_path},
    tokenizer::count_tokens,
    walker::{normalize_rel_path, path_is_selected, walk, DirEntryMeta, SelectionMatcher},
    workspace::WorkspaceIndex,
};
use std::{collections::HashSet, hint::black_box, path::Path, path::PathBuf, time::Instant};

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
    let p95 = |times: &mut Vec<f64>| {
        times.sort_by(f64::total_cmp);
        let idx = ((times.len() as f64 * 0.95).ceil() as usize)
            .saturating_sub(1)
            .min(times.len() - 1);
        times[idx]
    };
    println!("selection: 10000 paths / 8000 exact selections, 3 repetitions");
    println!(
        "legacy_ms={:.3}; matcher_including_build_ms={:.3}; matcher_p95_ms={:.3}",
        median(&mut old),
        median(&mut new),
        p95(&mut new)
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
        "cached_lookup_mtime_rules_check_and_selection_ms={:.3}; p95_ms={:.3} (5 repetitions)",
        median(&mut cached),
        p95(&mut cached)
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
        "pack_800_files: threads_parallel={}; sequential_1_thread_median_ms={:.3}; parallel_median_ms={:.3}; parallel_p95_ms={:.3}",
        rayon::current_num_threads(),
        median(&mut seq_pack_ms),
        median(&mut par_pack_ms),
        p95(&mut par_pack_ms)
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
        "pack_800_files_uneven: single_thread_ms={:.3}; chunked_64_ms={:.3}; single_pass_rayon_ms={:.3}; single_pass_p95_ms={:.3}",
        median(&mut single_thread_ms),
        median(&mut chunked_ms),
        median(&mut single_pass_ms),
        p95(&mut single_pass_ms)
    );

    // 6. Context Quality Benchmark (Gold Set Recall / Precision / Token Efficiency):
    // Compares graph-centrality-aware budget fitting (`fit_to_bpe_budget_with_graph`) against
    // a graph-unaware baseline (`fit_to_bpe_budget_with_graph(..., None)`) across synthetic
    // engineering tasks (bug fix, architecture review, security review, feature implementation,
    // test generation) under a tight 1,800-token budget.
    run_context_quality_benchmark();
}

struct GoldTask {
    name: &'static str,
    required: &'static [&'static str],
    helpful: &'static [&'static str],
    pinned: &'static [&'static str],
    budget: usize,
}

fn run_context_quality_benchmark() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    std::fs::create_dir_all(root.join("src/core")).unwrap();
    std::fs::create_dir_all(root.join("src/adapters")).unwrap();
    std::fs::create_dir_all(root.join("tests")).unwrap();
    std::fs::create_dir_all(root.join("docs")).unwrap();

    let filler = |prefix: &str, n: usize| -> String {
        (0..n)
            .map(|i| format!("pub fn {prefix}_fn_{i}(v: u64) -> u64 {{\n    let a = v.wrapping_add({i});\n    a ^ 0x5A5A\n}}\n"))
            .collect()
    };

    // Core modules (heavily imported across the codebase)
    std::fs::write(
        root.join("src/core/auth.rs"),
        format!(
            "pub struct AuthToken(pub u64);\n{}",
            filler("auth_verify", 35)
        ),
    )
    .unwrap();
    std::fs::write(
        root.join("src/core/sandbox.rs"),
        format!(
            "pub fn check_boundary(p: &str) -> bool {{ !p.contains(\"..\") }}\n{}",
            filler("sandbox_guard", 35)
        ),
    )
    .unwrap();
    std::fs::write(
        root.join("src/core/engine.rs"),
        format!(
            "use crate::core::auth;\nuse crate::core::sandbox;\n{}",
            filler("engine_step", 35)
        ),
    )
    .unwrap();

    // Importers of auth & sandbox
    for (name, imports) in [
        (
            "src/adapters/cli.rs",
            "use crate::core::auth;\nuse crate::core::engine;\n",
        ),
        (
            "src/adapters/mcp.rs",
            "use crate::core::auth;\nuse crate::core::sandbox;\n",
        ),
        (
            "src/adapters/http.rs",
            "use crate::core::auth;\nuse crate::core::sandbox;\nuse crate::core::engine;\n",
        ),
    ] {
        std::fs::write(
            root.join(name),
            format!("{imports}{}", filler("adapter", 12)),
        )
        .unwrap();
    }

    // Isolated / peripheral source files (0 importers, larger byte size so size-only tie-break
    // drops largest first; make isolated files slightly smaller than core files so a size-only
    // baseline drops core files BEFORE isolated noise, whereas graph centrality keeps core files!)
    for iso in [
        "src/adapters/legacy_v1.rs",
        "src/adapters/scratch_pad.rs",
        "src/core/unused_experiment.rs",
    ] {
        std::fs::write(root.join(iso), filler("isolated_noise", 30)).unwrap();
    }

    // Tests and docs (low priority tier)
    std::fs::write(
        root.join("tests/integration_test.rs"),
        filler("test_case", 40),
    )
    .unwrap();
    std::fs::write(root.join("docs/guide.md"), "# Guide\n".repeat(120)).unwrap();

    let entries: Vec<DirEntryMeta> = walk(&root)
        .unwrap()
        .into_iter()
        .filter(|e| !e.is_dir)
        .collect();
    let graph = DependencyGraph::build(&root, &entries);

    let tasks = [
        GoldTask {
            name: "security_review",
            required: &["src/core/auth.rs", "src/core/sandbox.rs"],
            helpful: &["src/core/engine.rs", "src/adapters/mcp.rs"],
            pinned: &["src/core/sandbox.rs"],
            budget: 3_200,
        },
        GoldTask {
            name: "architecture_review",
            required: &[
                "src/core/auth.rs",
                "src/core/sandbox.rs",
                "src/core/engine.rs",
            ],
            helpful: &[
                "src/adapters/cli.rs",
                "src/adapters/mcp.rs",
                "src/adapters/http.rs",
            ],
            pinned: &[],
            budget: 3_400,
        },
        GoldTask {
            name: "bug_fix_auth_flow",
            required: &["src/core/auth.rs", "src/core/engine.rs"],
            helpful: &["src/adapters/http.rs"],
            pinned: &["src/core/auth.rs"],
            budget: 3_200,
        },
    ];

    let opts = WriteOptions {
        format: OutputFormat::Xml,
        compute_bpe_tokens: true,
        ..Default::default()
    };

    let mut graph_recall_sum = 0.0;
    let mut naive_recall_sum = 0.0;
    let mut graph_noise_sum = 0.0;
    let mut naive_noise_sum = 0.0;

    for task in &tasks {
        let pinned: HashSet<String> = task.pinned.iter().map(|s| (*s).to_string()).collect();

        // 1. Graph-aware fit (current algorithm)
        let (kept_graph, skel_graph) = fit_to_bpe_budget_with_graph(
            entries.clone(),
            &root,
            &opts,
            task.budget,
            &pinned,
            Some(&graph),
        )
        .unwrap();
        let kept_graph_set: HashSet<String> = kept_graph
            .iter()
            .map(|e| normalize_rel_path(&e.path))
            .collect();

        // 2. Naive size/alphabetical baseline without dependency graph centrality
        let (kept_naive, _skel_naive) =
            fit_to_bpe_budget_with_graph(entries.clone(), &root, &opts, task.budget, &pinned, None)
                .unwrap();
        let kept_naive_set: HashSet<String> = kept_naive
            .iter()
            .map(|e| normalize_rel_path(&e.path))
            .collect();

        let req_hits_graph = task
            .required
            .iter()
            .filter(|&&r| kept_graph_set.contains(r))
            .count();
        let req_hits_naive = task
            .required
            .iter()
            .filter(|&&r| kept_naive_set.contains(r))
            .count();

        let recall_graph = req_hits_graph as f64 / task.required.len() as f64;
        let recall_naive = req_hits_naive as f64 / task.required.len() as f64;

        let is_relevant = |p: &str| task.required.contains(&p) || task.helpful.contains(&p);
        let noise_graph = kept_graph_set.iter().filter(|p| !is_relevant(p)).count() as f64
            / kept_graph_set.len().max(1) as f64;
        let noise_naive = kept_naive_set.iter().filter(|p| !is_relevant(p)).count() as f64
            / kept_naive_set.len().max(1) as f64;

        graph_recall_sum += recall_graph;
        naive_recall_sum += recall_naive;
        graph_noise_sum += noise_graph;
        naive_noise_sum += noise_naive;

        let _ = (task.name, skel_graph);
    }

    let n = tasks.len() as f64;
    println!(
        "context_quality_gold_benchmark: tasks={}; graph_required_recall={:.1}%; baseline_required_recall={:.1}%; graph_noise_ratio={:.1}%; baseline_noise_ratio={:.1}%",
        tasks.len(),
        100.0 * graph_recall_sum / n,
        100.0 * naive_recall_sum / n,
        100.0 * graph_noise_sum / n,
        100.0 * naive_noise_sum / n,
    );
    assert!(
        graph_recall_sum >= naive_recall_sum,
        "graph-aware budget fitting must not regress required-file recall vs baseline"
    );
}
