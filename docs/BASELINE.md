# Engineering Baseline (Stage 0 Reconnaissance)

**Date:** 2026-10-15  
**Repository:** `ProjectToText` (`ptt`) v0.8.0  
**Environment:**
- OS: macOS 27.0.0 (`Darwin Kernel Version 27.0.0: RELEASE_ARM64_T6041 arm64`)
- Rust: `rustc 1.97.1 (8bab26f4f 2026-07-14)`, `cargo 1.97.1 (c980f4866 2026-06-30)`, declared MSRV `1.90`
- Node / npm: `v24.3.0` / `11.16.0`
- Frontend stack: React 19.2.7, TypeScript ~6.0.2, Vite 8.3.4, Oxlint 1.71.0, Playwright 1.51.0

---

## 1. Architecture Inventory

### Rust Core (`src/core/`)
- `src/lib.rs`: `#![forbid(unsafe_code)]`; re-exports core modules.
- `src/core/walker.rs`: Git-aware directory scanner (`git ls-files -z --cached --others --exclude-standard` with top-down `.pttignore` pruning, fallback to `ignore::WalkBuilder`), `SelectionMatcher`, `JUNK_DIRS`, and default exclusions (`DEFAULT_EXCLUDED_FILE_NAMES`, `DEFAULT_EXCLUDED_DIR_PREFIXES`).
- `src/core/workspace.rs`: Revisioned `WorkspaceIndex` and `WorkspaceSnapshot`, incremental `refresh_paths` for in-place watcher edits, and cached `DependencyGraph`.
- `src/core/output.rs`: Parallel file preparation (`rayon`), UTF-8/UTF-16 decoding, AST skeletonizing, secret redaction, and serialization to XML, Markdown, JSON, and Plain text (`write_output`, `write_output_cancellable`, `write_output_with_stats`).
- `src/core/tokenizer.rs`: Exact BPE counting via `tiktoken-rs` (`o200k_base` and `cl100k_base`) plus approximate scaled profiles (`claude` = `1.04 * o200k_base`, `gemini` = `0.96 * o200k_base`).
- `src/core/skeleton.rs`: Tree-sitter AST compression and `find_symbols` across Rust, TypeScript, JavaScript, Python, Go, C#, Java, C, and C++.
- `src/core/deps.rs`: Parallel intra-repo import/importers/test resolver (`DependencyGraph::build_incremental`) with in-memory content caching (`Arc<str>`).
- `src/core/secrets.rs`: 17 regex credential rules with placeholder filtering and `RedactionSummary`.
- `src/core/preview.rs`: Path sandboxing (`resolve_under_root`, `resolve_under_canonical_root`, `is_link`) and bounded file preview (`load_preview`).
- `src/core/git.rs`: Working-tree status (`git status --porcelain=v1 -z -uall`), branch diff detection (`base...HEAD`), recent commits, and bounded `compute_git_diff`.
- `src/core/text.rs`: Strict UTF-8 and BOM-declared UTF-16LE/BE decoding (`decode_text`) and backtick-safe `markdown_fence`.

### Binary Entry Points (`src/`)
- `src/main.rs`: Tauri v2 desktop app (`select_folder`, `startup_folder`, `scan_folder`, `generate_output`, `get_full_packed_preview`, `copy_packed_output`, `save_packed_output`, `resolve_related_files`, `read_file_preview`, `open_in_default_app`, `open_with_app`, `open_url`, `pick_app_and_open`, `copy_to_clipboard`, `save_to_file`), `notify` watcher with `pending_watcher_paths`, and `ensure_fresh_artifact` stale-pack guard.
- `src/cli.rs`: Headless CLI (`ptt pack [DIR] [OPTIONS]` and `ptt mcp [DIR]`), glob/preset filtering (`filter_entries_for_cli`), and BPE budget fitting (`fit_to_bpe_budget`).
- `src/mcp.rs`: JSON-RPC 2.0 MCP stdio server exposing 5 tools (`ptt_get_project_map`, `ptt_pack_files`, `ptt_get_git_context`, `ptt_get_related_files`, `ptt_search_symbols`).

### Frontend (`ui/src/`)
- `App.tsx`, `useWorkspace.tsx`, `useThemeAndLayout.ts`, `useFilePreviewAndMenu.ts`, `useSelection.ts`, `useGeneration.ts`, `AppChrome.tsx`, `BudgetAndPromptBar.tsx`, `MainPanel.tsx`, `Panels.tsx`, `FileViewer.tsx`, `treeModel.ts`, `browserFs.ts`, `secrets.ts`, `projectPrefs.ts`, `prefTransfer.ts`, `folderHistory.ts`, `platform.ts`, `syntax.ts`, `tauriEnv.ts`, `version.ts`.

---

## 2. Baseline Command Verification

| Command | Result | Details |
| --- | --- | --- |
| `cargo fmt --all -- --check` | **PASS** (exit 0) | 0 formatting diffs |
| `cargo test --all-targets` | **PASS** (exit 0) | 89 tests passed (55 unit in `lib`, 14 unit in `bin`, 20 integration in `tests/phase1_regressions.rs`) |
| `cargo clippy --all-targets -- -D warnings` | **PASS** (exit 0) | 0 warnings |
| `npm --prefix ui ci` | **PASS** (exit 0) | 38 packages audited, 0 vulnerabilities |
| `npm --prefix ui run lint` | **PASS** (exit 0) | `oxlint src`: 0 warnings, 0 errors across 22 files (7 ms) |
| `npm --prefix ui run build` | **PASS** (exit 0) | `tsc -b && vite build` succeeded in 204 ms |
| `npm --prefix ui run test:e2e` | **PASS** (exit 0) | 21 Playwright tests passed in 2.4 s |
| `cargo run --release --example selection_benchmark` | **PASS** (exit 0) | See performance baseline below |

---

## 3. Performance Baseline (`selection_benchmark`, Release, 14 Rayon Threads)

- Selection matcher (10,000 paths / 8,000 exact selections): `1.017 ms` (legacy predicate: `5367.808 ms`)
- Initial non-Git scan (1,000 files): `28.024 ms`
- Cached workspace snapshot lookup + mtime rules check + selection: `0.142 ms`
- Pack 800 synthetic files: `23.113 ms` (1 thread) vs `11.406 ms` (14 threads)
- Pack 800 uneven files: `98.537 ms` (1 thread), `46.736 ms` (chunked-64), `30.230 ms` (single-pass rayon)
- Exact BPE (`o200k_base`) across 45 repository source files (548,425 bytes): `132,210 tokens` in `24.474 ms` (`5.40M tokens/s`, `21.37 MiB/s`)
- AST skeleton extraction across repository source: `32.971 ms` (`132,210 -> 32,869 tokens`, `75.1%` reduction)

---

## 4. Identified P0 Correctness & Security Gaps (Verified in Working Tree)

1. **P0-A (Token Budget)** — *status update after Stage 1 work*:
   - Original finding (Stage 0): token totals excluded wrappers and the fit could silently keep one over-budget file. **Now fixed:** `write_output_with_stats` counts the complete rendered artifact (`count_tokens_with_model` on the full document), and `fit_to_bpe_budget_with_pins` (`src/cli.rs`) re-renders and recounts each round, returning an explicit error when no file can be dropped.
   - Original finding: MCP `ptt_pack_files` computed `git_diff` after the fit. **Already correct in the working tree:** the diff is computed before `fit_to_bpe_budget`.
   - Approximate profiles (`claude`, `gemini`) are scaled estimates and are labeled with `~` in the CLI.
2. **P0-B (Browser-Mode Ignore Discrepancy)**:
   - `ui/src/browserFs.ts` (`scanDirectoryHandle`, `scanFileList`) only filters `CANONICAL_JUNK_DIRS`. It ignores `.gitignore` and `.pttignore` files completely, does not report skipped files/reasons, and does not enforce `.pttignore` fail-closed semantics.
3. **P0-C (MCP Compatibility & Validation)**:
   - `src/mcp.rs` hardcodes `"2024-11-05"` without version negotiation (`2025-11-25` / `2025-06-18` / `2024-11-05`), does not validate argument types/unknown properties strictly (returning JSON-RPC `-32602` or tool errors), does not bound input line lengths on `stdin`, and does not support `notifications/cancelled`.
4. **P0-D (Secret Detection & Visible Redaction Report)**:
   - *Status update (P0-D):* `RedactionSummary` already carried `redaction_enabled`, `files_scanned`, and `files_skipped`, and an adversarial performance test exists. Two gaps were real and are now fixed: the task prompt was never masked (now masked in Rust and the browser), and the CLI printed no redaction report (now a stderr line on every pack path). The report still does not prove the absence of secrets; that limit is stated in the output.
5. **P0-E (Filesystem Attack Surface / TOCTOU)**:
   - `read_and_redact_file` (`src/core/output.rs`) and `load_preview` (`src/core/preview.rs`) check `symlink_metadata` on the path and then call `std::fs::File::open(&path)` without `O_NOFOLLOW` / `FILE_FLAG_OPEN_REPARSE_POINT` or post-open `fstat` verification (inode/device/file-type comparison).
6. **P0-F (Release Workflow & Supply Chain)**:
   - `.github/workflows/ci.yml` and `.github/workflows/release.yml` use mutable tags (`@v7`, `@v2`, `@stable`, `@v1`), lack an explicit MSRV (`1.90`) check job, and lack automated release binary smoke tests in CI.
