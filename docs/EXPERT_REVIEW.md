# Engineering review: 0.4.0 through 0.8.0

**Scope:** changes on top of v0.3.0. The 0.4.0 section describes the release prepared on 2026-10-14. The 0.5.0 section covers hardening on top of it. The 0.6.0 section covers the UI split, auto-refresh, and the stale-artifact guard. The 0.7.0 section covers the desktop state hook, the incremental dependency graph, and re-export symbol search. The 0.8.0 section covers grouped Rust re-exports, the file-set-independent graph cache, incremental watcher updates, and the UI hook split. The secret-scanning evaluation is below.

**Status:** regression-driven hardening with measured behavior. No independent certification or competitive ranking.

An earlier self-assessment claiming a “10.0 / 10 panel consensus” was withdrawn: no independent panel, scoring method, or evidence supported it. Passing tests shows that particular behaviors hold; it does not prove complete security or market position.

## Findings from phase one (0.2.x) and their status

| Area | Finding | Status |
| --- | --- | --- |
| Directory `.pttignore` rules | `secrets/` did not exclude descendants on the Git path. | Fixed: parents are evaluated top-down and pruned; a negation cannot resurrect a child of an ignored directory. |
| Nested `.pttignore` | Git path loaded only the root file. | Fixed: rules load for each traversable indexed directory. Invalid rule files fail closed. |
| Output path containment | A synthetic `../` entry and an intermediate symlink exposed outside contents. | Fixed: components are validated, links and reparse points rejected, canonical containment checked before each read. |
| Text encoding | BOM-declared UTF-16 was classified as binary. | Fixed: strict UTF-8 and BOM-declared UTF-16LE/BE decoding in both packers. Legacy charsets are reported, not guessed. |
| Markdown boundaries | Mixed backtick and tilde runs ended fences early. | Fixed: fence length exceeds the longest backtick run. |
| Selection lookup | Repeated path normalization in a nested scan. | Fixed: selections normalized once into a set; each candidate checks its ancestors. |
| Repeated workspace scan | Each generation ran Git and walked the project again. | Fixed: revisioned snapshot built on Open/Refresh and reused. |
| Blocking I/O | Synchronous disk and process calls in async commands. | Fixed: scan, generation, preview, clipboard, and save run on Tauri's blocking pool. |
| Startup / CLI | Unknown commands opened the GUI; folder argument ignored. | Fixed: `ptt [DIR]` validates its folder; invalid commands exit 2. |

## 0.4.0 changes

- **Zero-copy output**: the full pack stays in Rust as an `Arc<String>`; only a bounded preview is sent to the UI. Copy and Save read from Rust.
- **Parallel packing** with `rayon`: reading, decoding, skeletonization, redaction, and token counting. Parallel output matches sequential output byte for byte (covered by a regression test).
- **Exact BPE token counts** via `tiktoken-rs`: `o200k_base` (default) and `cl100k_base`. The Claude and Gemini profiles scale the `o200k_base` count by 1.04 and 0.96; they are approximations.
- **AST skeletons** via tree-sitter, with a fallback for other text.
- **Git context**: status and branch-change selection, unified diff inclusion.
- **Dependency neighbors** (desktop): imports, importers, and related tests.
- **Secret masking** extended (Anthropic, Google, Stripe, URL passwords, `.env` secrets); documentation placeholders such as `Password=...` are no longer masked.
- **Default exclusions**: presets leave lockfiles and `gen/schemas/` unchecked. The repository's root `.pttignore` covers its own generated files.
- **Architectural ordering** of `<files>` content (source, manifests, tests, docs/CI). `<directory_structure>` stays alphabetical.
- **MCP server** (`ptt mcp`).
- **File watcher**: `notify` events emit `workspace-changed` in the desktop app.
- **Virtualized tree** with memoized sorting for large repositories.

## 0.5.0 hardening

- **XML validity**: `<task_instructions>` is wrapped in CDATA in the Rust and browser writers, so prompts containing `<`, `>`, or `&` no longer break the document. A regression test covers this.
- **MCP sandbox**: every tool's `directory` must stay inside the server's project root. Symlinks and reparse points are rejected. `ptt_get_project_map` checks file size before reading and picks skeleton candidates by architectural tier.
- **New MCP tools**: `ptt_get_related_files` (1-hop imports, importers, and tests) and `ptt_search_symbols` (named functions, methods, types, classes, and interfaces with exact source and line ranges, via tree-sitter).
- **Dependency graph**: grouped Rust imports (`use crate::core::{deps::X, git::Y}`) resolve every module. TypeScript `./foo.js` imports resolve to `foo.ts` or `foo.tsx`, and `@/` maps to `src/`. The graph is built in parallel.
- **Packing**: one parallel pass replaces the 64-file chunks, so uneven files no longer wait on chunk barriers. Tree-sitter parsers are cached per worker thread instead of being created per file. Arrow-function bodies in class fields are elided.
- **CLI `--max-tokens`**: the heuristic pre-pass upgrades files to skeletons above the budget and drops files only above twice the budget. The final fit uses exact per-file BPE counts: skeleton upgrades first, then drops in priority order, verified by a re-pack. Measured: a 20,000-token budget now gives 19,657 tokens (previously 11,337).
- **Symbol extraction**: `find_symbols` names C/C++ functions through their declarator, TypeScript/JavaScript functions bound to a variable (reporting the whole declaration, including `export`), and Rust `impl`, `const`, `static`, and `macro_rules!` items.
- **MCP search and pack**: `ptt_search_symbols` orders files by architectural tier so `src/` results come first, and reads and parses in parallel. `ptt_pack_files` accepts `preset`, `max_tokens`, and `git_diff`, using the same selection code as `ptt pack`.
- **Desktop tree**: token badges for skeleton-marked files count about 30% of their size, matching the packer.

## 0.6.0 changes

- **Modular desktop UI**: the tree model and pure helpers moved to `ui/src/treeModel.ts`. `TreeRow`, the dialogs, and the toasts moved to `ui/src/Panels.tsx`. `ui/src/App.tsx` went from about 144 KB to about 108 KB.
- **Auto-refresh**: a `workspace-changed` event re-scans the open folder after an 800 ms debounce. The re-scan keeps the current file selection and skeleton marks.
- **Stale-artifact guard**: the packed output records its selected paths, options, and each file's `(mtime, length)`. Copy, Save, and the full preview check those values and re-pack from disk if a file changed.
- **Secret rules**: GitLab personal access tokens (`glpat-`), Hugging Face tokens (`hf_`), npm tokens (`npm_`), and JWTs. The Rust and browser implementations use the same rules.

## 0.7.0 changes

- **Desktop state in a hook**: `ui/src/useWorkspace.tsx` holds the App state, effects and handlers. `ui/src/App.tsx` is a 1.2 KB shell. The header, toolbar and status bar are in `ui/src/AppChrome.tsx`, the budget and prompt studio in `ui/src/BudgetAndPromptBar.tsx`, and the main panel in `ui/src/MainPanel.tsx`. `useWorkspace.tsx` is about 65 KB and is now the largest UI module.
- **Stale-artifact guard fails closed**: when the workspace index holds a snapshot, copy, save and preview validate the ignore rules with `WorkspaceIndex::get` before reusing a pack. A changed `.pttignore` or `.gitignore` returns "Ignore rules changed; refresh the project before packing". A pack that includes git diff is rebuilt, because file stamps do not cover diff content.
- **Incremental dependency graph**: a rescan reuses the import resolutions of files whose `(mtime, length)` is unchanged, without reading them again. The cache is ignored when the file set changes, because a new file can satisfy an old import.
- **Symbol search for re-exports**: Rust `pub use` (under the alias when present) and `pub mod name;` declarations, TypeScript and JavaScript `export { ... }` specifiers (under the exported name), and Go `const` and `var` specs. Inline modules are not reported.
- **Secret corpus**: 17 rules, one fixture each. Result: 17/17 masked, 0/20 benign snippets changed.
- **Chunked vs single-pass packing**: `examples/selection_benchmark.rs` packs 800 files, every 32nd about 32 KB and the rest about 1 KB. Median of three repetitions in one run (`cargo run --release --example selection_benchmark`, 14 rayon threads): single pass on the default rayon pool 30.1 ms, chunked 64 47.8 ms, single pass on one thread 102.4 ms. Single-pass parallel packing is about 1.6× faster than the chunked simulation in this run. The chunked case simulates the 0.4.0 chunk structure (each 64-file chunk packed on its own); it is not the 0.4.0 build.

## 0.8.0 changes

- **Grouped Rust re-exports and TypeScript aliases in symbol search**: `pub use core::output::{ a, b as c };` reports every exported name, under its alias when present. `find_symbols` reads TypeScript `import { a as b }` aliases and `export * as ns from './m'` namespace re-exports. `ptt`'s own `src/lib.rs` re-exports are now found.
- **Dependency graph across file-set changes**: the graph keeps each file's source in memory. When a file is added or removed, unchanged files resolve their imports from that cache without a disk read. Before, any file-set change discarded the whole cache.
- **MCP graph caching**: `ptt mcp` keeps one process-local workspace index, so repeated `ptt_get_related_files` calls reuse the dependency graph instead of walking the project each time.
- **Incremental watcher updates**: `WorkspaceIndex::refresh_paths` updates the snapshot in place when watcher events only modify indexed files. The desktop app queues the changed paths. Creating or removing a file, or changing an ignore file, still triggers a full scan.
- **UI split**: `ui/src/useWorkspace.tsx` is composed from `ui/src/useThemeAndLayout.ts` (theme, sidebar resize, tree viewport) and `ui/src/useFilePreviewAndMenu.ts` (preview, editor launchers, context menu, dependency selection). Each file in `ui/src/` is under 38 KB.

## Secret-scanning evaluation

Method: a fixture corpus in `tests/phase1_regressions.rs` (`secret_scanner_fp_fn_corpus_evaluation`), mirrored in `ui/e2e/secrets.spec.ts`.

- **True positives**: 17 synthetic credentials, one for each of the 17 rules. Each is built with `concat!()` or `.join('')`, so packing this repository never masks the fixtures. Result: 17/17 masked (false negatives = 0).
- **True negatives**: 20 benign snippets. They cover UUIDs, SHA-256 hashes, base64 data URIs, CSS classes, TypeScript generics, SQL, comparison operators, documentation placeholders, Markdown links, localhost URLs, commit SHAs, package scopes, and identifiers that contain `TOKEN` or `SECRET`. Result: 0/20 changed (false positives = 0).
- **Limits of this measurement**: the corpus is small, and its authors wrote the rules too. It covers one shape per rule, and the corpus is not a measurement on real code.

## Measurements

Commands, from the repository root:

```bash
cargo run --release --example selection_benchmark
cargo build --release --bin ptt
./target/release/ptt pack . -o out.xml
./target/release/ptt pack . --preset source --skeleton -o skel.xml
./target/release/ptt pack . --max-tokens 20000 -o budget.xml
```

Single benchmark run on macOS arm64 (`rustc 1.97.1`, 14 rayon threads). Values vary with machine, filesystem, and load:

| Measurement | Result |
| --- | ---: |
| Legacy selection predicate, 10,000 paths | 4859.8 ms |
| New selection matcher, including set construction | 1.0 ms |
| Initial non-Git scan, 1,000 files | 27.4 ms |
| Cached lookup + ignore-rule check + selection | 0.13 ms |
| Pack of 800 files, one thread (same code) | 21.0 ms |
| Pack of 800 files, default rayon pool | 11.8 ms (about 1.8× faster in this run) |
| BPE tokenizer, full source (35 files, 477,070 bytes, `o200k_base`) | 114,604 tokens in 20.6 ms median (≈5.6M tokens/s, ≈22 MiB/s) |
| AST skeleton extraction, same source | 26.9 ms median |
| Skeleton compression, ptt's own source (exact BPE tokens) | 114,604 → 27,879 tokens (75.7% reduction) |

The tokenizer and skeleton timings are measured separately, after an encoder warm-up, with file reads excluded. Packing is measured with BPE counting and secret redaction on. Each figure is the median of three repetitions.

Parallel speedup varies between runs: 1.1–1.25× in earlier runs, about 2.0× in the latest (22.4 ms on one thread, 11.1 ms on the rayon pool). The “sequential” baseline is the same code on a one-thread pool. It is not a measurement of the 0.4.0 chunked implementation, so the effect of removing the chunk barriers has not been measured separately. The earlier 2.4× figure is withdrawn.

Self-pack checks on this repository (release CLI, 0.8.0 working tree, sizes in KiB = bytes / 1024):

| Command | Output | Size | Notes |
| --- | --- | ---: | --- |
| `ptt pack . --preset source` | 74 files, ~173k tokens | 694 KiB | Full source, no skeletons. |
| `ptt pack .` | 90 files, ~183k tokens | 727 KiB | Default pack. Above the 700 KB target: the 0.7.0 and 0.8.0 additions raised it. |
| `ptt pack . --preset source --skeleton` | 74 files, ~74k tokens | 282 KiB | Skeleton mode for smaller packs. |
| `ptt pack . --max-tokens 20000` | 52 files, ~20.0k tokens | 72 KiB | Exact BPE count stays within the budget. |
| `ptt pack . --max-tokens 50000` | 72 files, ~41.1k tokens | 156 KiB | Exact BPE count stays within the budget. |

The 0.4.0 table reported 155k tokens and 628 KB for the default pack. That was measured before the source changed, so those figures are superseded.

The 700 KB target was set for the default pack. The 0.8.0 default pack is 727 KiB, so it misses the target; the source preset (694 KiB) is under it.

The original 350 KB target was not achievable for full source, because `ui/src/App.tsx` alone is about 144 KB. The project owner changed the target to 700 KB.

## Verification

- `cargo fmt --all -- --check` and `cargo clippy --all-targets -- -D warnings`: pass.
- `cargo test --all-targets`: 89 Rust tests pass (55 library, 14 binary, 20 integration and regression). The 0.7.0 additions are the fail-closed artifact test, the incremental dependency test, the re-export symbol tests, and the 17-rule secret corpus. The 0.8.0 additions are grouped `pub use` and TypeScript alias symbol tests, the file-set-independent dependency cache test, and the `refresh_paths` test. Earlier tests cover MCP sandboxing, symbol search, related files, grouped Rust imports, `.js` to `.ts` resolution, skeleton element elision, `<task_instructions>` CDATA, and the exact BPE budget.
- `cargo build --release --bin ptt`: pass.
- MCP smoke test through the release binary over stdio: `tools/list` returns five tools. `ptt_search_symbols` returns the exact span. `ptt_get_related_files` returns the expected import. A `directory` of `/etc` is rejected.
- `npm --prefix ui run lint`, `typecheck`, `build`: pass.
- `npm --prefix ui run test:e2e`: 21 Playwright tests pass in Chromium.
- Largest file in `ui/src/`: 30,826 bytes (`useWorkspace.tsx` is under the 38 KB limit after the split).
- Not run: native desktop tests on macOS, Windows, or Linux; updater and installer flows; the Windows-only junction regression test.

## Limits

1. **Watcher falls back to a full re-scan on structural changes.** Edits to indexed files are applied in place with `WorkspaceIndex::refresh_paths`. Creating or removing a file, or changing an ignore file, triggers a full re-scan after 800 ms, keeping the selection. The dependency graph reuses unchanged files, and file-set changes re-resolve them from cached source.
2. **No race-proof filesystem sandbox.** Checks mitigate static link and junction escapes. A concurrent process can change paths between check and open.
3. **Secret masking is pattern-based.** The fixture corpus (17 positives, 20 negatives) gives 17/17 recall and 0/20 false positives for the listed shapes. That is not a measured rate on real code. The masking has no entropy or context detection and misses credentials in unrecognized shapes.
4. **Claude and Gemini counts are scaled approximations** of `o200k_base`. Exact counts apply only to `o200k_base` and `cl100k_base`.
5. **Skeletons are lossy.** Function bodies are removed by design. Languages without a grammar use a fallback that is less precise.
6. **Browser mode is a separate implementation.** It does not run Git, does not implement `.gitignore` or `.pttignore`, and has a 400-file cap.
7. **Native release QA is outstanding.** Installer, signing, notarization, and WebView behavior are not covered by browser tests.
8. **MSRV is declared, not tested.** `rust-version = "1.90"` comes from the resolved dependency graph. CI builds with `stable`.
9. **No legacy charset detection.** BOM-less Windows-1252 and similar files must be converted to UTF-8 first.
10. **MCP symbol search matches name substrings only, under the exported name.** It finds `pub use` re-exports, including grouped lists, `pub mod name;` declarations, TypeScript export and import aliases, and `export * as ns` namespaces. It does not follow glob re-exports (`pub use x::*`).

## Next milestones

1. Native macOS, Windows, and Linux regression runs, with a path-race threat model.
