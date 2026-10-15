//! Token-budget fitting for `--max-tokens` (CLI and MCP pack).
//!
//! Two stages, one owner. [`prefit_by_estimate`] is a cheap pass over file sizes. It upgrades heavy
//! files to skeletons and pre-drops only when far over budget. [`fit_to_bpe_budget_with_pins`] then
//! makes the exact fit against the complete serialized artifact. Pinned paths are never dropped, and a
//! budget too small to hold them fails with an error.

use std::collections::{HashMap, HashSet};
use std::path::Path;

use crate::core::output::{write_output_with_stats, PackStats, WriteOptions};
use crate::core::tokenizer::estimate_tokens_from_bytes;
use crate::core::walker::{normalize_rel_path, DirEntryMeta};

fn is_low_priority_path(path: &str) -> bool {
    let lower = path.to_ascii_lowercase();
    lower.contains("test")
        || lower.contains("spec")
        || lower.contains("fixture")
        || lower.contains("bench")
        || lower.contains("example")
        || lower.ends_with(".lock")
        || lower.ends_with("-lock.json")
        || lower.ends_with(".md")
        || lower.ends_with(".txt")
}

/// Estimated tokens for a file packed as an AST skeleton: about 30% of its full size.
fn skeleton_cost(tokens: usize) -> usize {
    tokens * 3 / 10
}

/// Indices of `files` in the order budget pressure drops them: non-pinned low-priority paths first,
/// then largest non-pinned files. Pinned files are excluded from drop candidates.
fn drop_priority_order(files: &[DirEntryMeta], pinned: &HashSet<String>) -> Vec<usize> {
    let mut order: Vec<usize> = (0..files.len())
        .filter(|&i| !pinned.contains(&normalize_rel_path(&files[i].path)))
        .collect();
    order.sort_by(|&a, &b| {
        let low_a = is_low_priority_path(&normalize_rel_path(&files[a].path));
        let low_b = is_low_priority_path(&normalize_rel_path(&files[b].path));
        low_b
            .cmp(&low_a)
            .then_with(|| files[b].size.unwrap_or(0).cmp(&files[a].size.unwrap_or(0)))
    });
    order
}

/// Packs `entries` in memory and returns the pack's statistics. Used for exact BPE counts.
pub fn pack_stats(
    entries: &[DirEntryMeta],
    root: &Path,
    opts: &WriteOptions,
) -> Result<PackStats, String> {
    let mut sink = Vec::new();
    write_output_with_stats(&mut sink, entries, root, opts, &|| false).map_err(|e| e.to_string())
}

pub fn fit_to_bpe_budget(
    entries: Vec<DirEntryMeta>,
    root: &Path,
    opts: &WriteOptions,
    budget: usize,
) -> Result<(Vec<DirEntryMeta>, HashSet<String>), String> {
    fit_to_bpe_budget_with_pins(entries, root, opts, budget, &HashSet::new())
}

/// Fits `entries` within `budget` using the complete serialized artifact token count while
/// never dropping files in `pinned_rel_paths`.
pub fn fit_to_bpe_budget_with_pins(
    entries: Vec<DirEntryMeta>,
    root: &Path,
    opts: &WriteOptions,
    budget: usize,
    pinned_rel_paths: &HashSet<String>,
) -> Result<(Vec<DirEntryMeta>, HashSet<String>), String> {
    let mut opts = opts.clone();
    opts.compute_bpe_tokens = true;
    let mut kept = entries;
    if kept.is_empty() {
        let stats = pack_stats(&kept, root, &opts)?;
        if stats.total_tokens > budget {
            return Err(format!(
                "Strict token budget ({budget} tokens, {}) exceeded by artifact wrapper/diff/prompt overhead ({} tokens) with 0 files",
                opts.tokenizer_model.label(),
                stats.total_tokens
            ));
        }
        return Ok((kept, opts.skeleton_files));
    }

    loop {
        let stats = pack_stats(&kept, root, &opts)?;
        if stats.total_tokens <= budget {
            return Ok((kept, opts.skeleton_files));
        }
        let exact: HashMap<String, usize> = stats
            .file_tokens
            .iter()
            .map(|f| (f.path.clone(), f.tokens))
            .collect();
        let tokens_of = |e: &DirEntryMeta| {
            exact
                .get(&normalize_rel_path(&e.path))
                .copied()
                .unwrap_or(0)
        };
        let order = drop_priority_order(&kept, pinned_rel_paths);
        let mut running = stats.total_tokens;

        // Round A: upgrade full non-pinned files to skeletons, lowest priority first, then pack again.
        if !opts.skeleton_all {
            let mut upgraded = false;
            for &idx in &order {
                if running <= budget {
                    break;
                }
                let rel = normalize_rel_path(&kept[idx].path);
                let tok = tokens_of(&kept[idx]);
                if tok > 15
                    && !opts.skeleton_files.contains(&rel)
                    && crate::core::skeleton::language_for_path(Path::new(&rel)) != "other"
                {
                    running = running.saturating_sub(tok * 7 / 10);
                    opts.skeleton_files.insert(rel);
                    upgraded = true;
                }
            }
            if upgraded {
                continue;
            }
        }

        // If no non-pinned files can be dropped (either only 1 file remains or all remaining files are pinned),
        // fail closed with a clear diagnostic rather than silently dropping a pinned file or overflowing.
        let min_keep = pinned_rel_paths.len().max(1);
        if kept.len() <= min_keep || order.is_empty() {
            let only_rel = kept
                .first()
                .map(|e| normalize_rel_path(&e.path))
                .unwrap_or_else(|| "<none>".to_string());
            return Err(format!(
                "Strict token budget ({budget} tokens, {}) cannot fit minimum/pinned artifact: '{}' (and {} pinned files) require {} total tokens ({} content + {} wrapper/diff/prompt overhead)",
                opts.tokenizer_model.label(),
                only_rel,
                pinned_rel_paths.len(),
                stats.total_tokens,
                stats.content_tokens,
                stats.overhead_tokens
            ));
        }

        // Round B: drop non-pinned files in priority order until the exact estimate fits, then pack again.
        let mut dropped = HashSet::new();
        for &idx in &order {
            if running <= budget || kept.len() - dropped.len() <= min_keep {
                break;
            }
            running = running.saturating_sub(tokens_of(&kept[idx]).max(1));
            dropped.insert(idx);
        }
        if dropped.is_empty() {
            if let Some(&idx) = order.first() {
                dropped.insert(idx);
            }
        }
        kept = kept
            .into_iter()
            .enumerate()
            .filter_map(|(i, e)| (!dropped.contains(&i)).then_some(e))
            .collect();
    }
}

/// Heuristic pre-fit for `--max-tokens`, run before the exact fit. `skeleton_all` is `--skeleton`.
/// Upgrades heavy files to skeletons while the estimate is over budget, then drops low-priority
/// files only when the estimate is more than twice the budget.
pub fn prefit_by_estimate(
    mut files: Vec<DirEntryMeta>,
    skeleton_files: &mut HashSet<String>,
    skeleton_all: bool,
    budget: usize,
    pinned_rel_paths: &HashSet<String>,
) -> Vec<DirEntryMeta> {
    // Files already marked for skeleton mode (`--skeleton` or a glob) cost ~30% of their full size.
    let mut total_est: usize = files
        .iter()
        .map(|f| {
            let tok = estimate_tokens_from_bytes(f.size.unwrap_or(0));
            let rel = normalize_rel_path(&f.path);
            if skeleton_all || skeleton_files.contains(&rel) {
                skeleton_cost(tok)
            } else {
                tok
            }
        })
        .sum();

    // Pass 1 (heuristic): upgrade heavy files to AST skeleton mode while the estimate exceeds the budget.
    if total_est > budget {
        let order = drop_priority_order(&files, pinned_rel_paths);
        for &idx in &order {
            if total_est <= budget {
                break;
            }
            let rel = normalize_rel_path(&files[idx].path);
            let tok = estimate_tokens_from_bytes(files[idx].size.unwrap_or(0));
            if tok > 20 && !skeleton_all && !skeleton_files.contains(&rel) {
                skeleton_files.insert(rel);
                let saved = tok - skeleton_cost(tok);
                total_est = total_est.saturating_sub(saved);
            }
        }
    }

    // Pass 2 (heuristic): pre-drop only when the estimate is far above the budget. The exact counts
    // in `fit_to_bpe_budget_with_pins` decide the final fit, so this keeps a 2x margin.
    if total_est > budget * 2 {
        let order = drop_priority_order(&files, pinned_rel_paths);
        let mut dropped = HashSet::new();
        for &idx in &order {
            if total_est <= budget * 2 || files.len() - dropped.len() <= 1 {
                break;
            }
            let rel = normalize_rel_path(&files[idx].path);
            let tok = estimate_tokens_from_bytes(files[idx].size.unwrap_or(0));
            let effective = if skeleton_files.contains(&rel) {
                skeleton_cost(tok)
            } else {
                tok
            };
            dropped.insert(idx);
            total_est = total_est.saturating_sub(effective);
        }

        if !dropped.is_empty() {
            files = files
                .into_iter()
                .enumerate()
                .filter_map(|(i, f)| (!dropped.contains(&i)).then_some(f))
                .collect();
        }
    }

    files
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::output::{OutputFormat, WriteOptions};
    use crate::core::tokenizer::TokenizerModel;
    use crate::core::walker::walk;
    use std::fs;
    use tempfile::tempdir;

    #[test]
    fn strict_budget_measures_entire_serialized_artifact_in_every_format() {
        use crate::core::tokenizer::count_tokens_with_model;

        let dir = tempdir().unwrap();
        let nested = dir
            .path()
            .join("deeply/nested/path/with/many/segments/for/overhead");
        fs::create_dir_all(&nested).unwrap();
        fs::write(
            nested.join("escape_heavy.rs"),
            "pub fn check() -> &'static str {\n    \"<tag attr=\\\"val\\\"> & ]]> \\n \\t\"\n}\n",
        )
        .unwrap();
        fs::write(
            dir.path().join("second.rs"),
            (0..60)
                .map(|i| format!("pub fn helper_{i}(x: usize) -> usize {{ x + {i} }}\n"))
                .collect::<String>(),
        )
        .unwrap();

        let root = dir.path().canonicalize().unwrap();
        let entries = walk(&root).unwrap();
        let files: Vec<DirEntryMeta> = entries.into_iter().filter(|e| !e.is_dir).collect();

        for format in [
            OutputFormat::Xml,
            OutputFormat::Markdown,
            OutputFormat::Json,
            OutputFormat::Plain,
        ] {
            let opts = WriteOptions {
                format,
                include_file_summary: true,
                git_diff: Some("diff --git a/second.rs b/second.rs\n+pub fn added() {}\n".into()),
                task_prompt: Some("Verify <xml> & \"json\" escaping under budget.".into()),
                tokenizer_model: TokenizerModel::O200kBase,
                compute_bpe_tokens: true,
                ..Default::default()
            };
            let mut full_buf = Vec::new();
            let full_stats =
                write_output_with_stats(&mut full_buf, &files, &root, &opts, &|| false).unwrap();
            let rendered_str = String::from_utf8(full_buf).unwrap();
            let exact_doc_tokens = count_tokens_with_model(&rendered_str, opts.tokenizer_model);

            // total_tokens must equal the exact BPE count of the complete serialized artifact.
            assert_eq!(
                full_stats.total_tokens, exact_doc_tokens,
                "format {format:?} total_tokens mismatch"
            );
            assert!(
                full_stats.total_tokens > full_stats.content_tokens,
                "format {format:?} must count wrapper/diff/prompt overhead"
            );
            assert_eq!(
                full_stats.overhead_tokens,
                full_stats.total_tokens - full_stats.content_tokens
            );
            assert!(full_stats.tokenizer_exact);

            // Fit to a tight budget that forces skeletonization or dropping second.rs.
            let tight_budget = full_stats.total_tokens - 50;
            let (fitted, skels) =
                fit_to_bpe_budget(files.clone(), &root, &opts, tight_budget).unwrap();
            let fitted_opts = WriteOptions {
                skeleton_files: skels.clone(),
                ..opts.clone()
            };
            let mut fit_buf = Vec::new();
            let fit_stats =
                write_output_with_stats(&mut fit_buf, &fitted, &root, &fitted_opts, &|| false)
                    .unwrap();
            let fit_str = String::from_utf8(fit_buf).unwrap();
            let fit_exact = count_tokens_with_model(&fit_str, fitted_opts.tokenizer_model);
            assert_eq!(fit_stats.total_tokens, fit_exact);
            assert!(
                fit_exact <= tight_budget,
                "format {format:?}: emitted {fit_exact} tokens > budget {tight_budget}"
            );

            // Determinism check: repeated fit produces identical file list, skeletons, and bytes.
            let (fitted2, skels2) =
                fit_to_bpe_budget(files.clone(), &root, &opts, tight_budget).unwrap();
            assert_eq!(fitted, fitted2);
            assert_eq!(skels, skels2);
        }
    }

    #[test]
    fn strict_budget_fails_closed_when_single_file_or_overhead_exceeds_budget() {
        let dir = tempdir().unwrap();
        let body: String = (0..80)
            .map(|i| format!("Line {i}: plain text that cannot be AST-skeletonized.\n"))
            .collect();
        fs::write(dir.path().join("notes.txt"), body).unwrap();
        let root = dir.path().canonicalize().unwrap();
        let entries: Vec<DirEntryMeta> = walk(&root)
            .unwrap()
            .into_iter()
            .filter(|e| !e.is_dir)
            .collect();

        let opts = WriteOptions {
            format: OutputFormat::Xml,
            compute_bpe_tokens: true,
            ..Default::default()
        };
        let err = fit_to_bpe_budget(entries, &root, &opts, 25).unwrap_err();
        assert!(
            err.contains("Strict token budget (25 tokens"),
            "unexpected error: {err}"
        );
    }

    fn plain_body(tag: &str, lines: usize) -> String {
        (0..lines)
            .map(|i| format!("{tag} line {i}: plain text that cannot be AST-skeletonized.\n"))
            .collect()
    }

    fn exact_artifact_tokens(entries: &[DirEntryMeta], root: &Path, opts: &WriteOptions) -> usize {
        let mut sink = Vec::new();
        write_output_with_stats(&mut sink, entries, root, opts, &|| false)
            .unwrap()
            .total_tokens
    }

    #[test]
    fn strict_budget_never_drops_pinned_files_and_stays_within_budget() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("pinned.txt"), plain_body("pin", 4)).unwrap();
        fs::write(dir.path().join("other_a.txt"), plain_body("aaa", 80)).unwrap();
        fs::write(dir.path().join("other_b.txt"), plain_body("bbb", 80)).unwrap();
        let root = dir.path().canonicalize().unwrap();
        let entries: Vec<DirEntryMeta> = walk(&root)
            .unwrap()
            .into_iter()
            .filter(|e| !e.is_dir)
            .collect();
        let pinned: HashSet<String> = ["pinned.txt".to_string()].into_iter().collect();
        let opts = WriteOptions {
            format: OutputFormat::Xml,
            compute_bpe_tokens: true,
            ..Default::default()
        };

        let pinned_only: Vec<DirEntryMeta> = entries
            .iter()
            .filter(|e| normalize_rel_path(&e.path) == "pinned.txt")
            .cloned()
            .collect();
        let budget = exact_artifact_tokens(&pinned_only, &root, &opts) + 40;
        let full = exact_artifact_tokens(&entries, &root, &opts);
        assert!(
            full > budget,
            "fixture must force dropping: {full} <= {budget}"
        );

        let (kept, _) =
            fit_to_bpe_budget_with_pins(entries.clone(), &root, &opts, budget, &pinned).unwrap();
        let kept_paths: Vec<String> = kept.iter().map(|e| normalize_rel_path(&e.path)).collect();
        assert!(
            kept_paths.iter().any(|p| p == "pinned.txt"),
            "pinned file was dropped: {kept_paths:?}"
        );
        assert!(kept.len() < entries.len(), "fit should drop unpinned files");
        let final_tokens = exact_artifact_tokens(&kept, &root, &opts);
        assert!(final_tokens <= budget, "{final_tokens} > {budget}");
    }

    #[test]
    fn strict_budget_fails_closed_when_pinned_file_alone_exceeds_budget() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("pinned.txt"), plain_body("pin", 80)).unwrap();
        fs::write(dir.path().join("other.txt"), plain_body("other", 4)).unwrap();
        let root = dir.path().canonicalize().unwrap();
        let entries: Vec<DirEntryMeta> = walk(&root)
            .unwrap()
            .into_iter()
            .filter(|e| !e.is_dir)
            .collect();
        let pinned: HashSet<String> = ["pinned.txt".to_string()].into_iter().collect();
        let opts = WriteOptions {
            format: OutputFormat::Xml,
            compute_bpe_tokens: true,
            ..Default::default()
        };
        let err = fit_to_bpe_budget_with_pins(entries, &root, &opts, 60, &pinned).unwrap_err();
        assert!(err.contains("pinned"), "unexpected error: {err}");
    }

    #[test]
    fn strict_budget_fit_is_deterministic_across_repeated_runs() {
        let dir = tempdir().unwrap();
        for (name, tag) in [("a.txt", "aa"), ("b.txt", "bb"), ("c.txt", "cc")] {
            fs::write(dir.path().join(name), plain_body(tag, 60)).unwrap();
        }
        let root = dir.path().canonicalize().unwrap();
        let opts = WriteOptions {
            format: OutputFormat::Markdown,
            compute_bpe_tokens: true,
            ..Default::default()
        };
        let run = || {
            let entries: Vec<DirEntryMeta> = walk(&root)
                .unwrap()
                .into_iter()
                .filter(|e| !e.is_dir)
                .collect();
            let (kept, skeletons) = fit_to_bpe_budget(entries, &root, &opts, 1500).unwrap();
            let mut paths: Vec<String> = kept.iter().map(|e| normalize_rel_path(&e.path)).collect();
            paths.sort();
            let mut skel: Vec<String> = skeletons.into_iter().collect();
            skel.sort();
            (paths, skel)
        };
        let first = run();
        for _ in 0..3 {
            assert_eq!(run(), first);
        }
    }
}
