# Engineering review: 0.4.0 and 0.5.0 hardening

**Scope:** local changes on top of v0.3.0. The 0.4.0 section describes the release prepared on 2026-10-14. The 0.5.0 section describes unreleased hardening work on top of it.

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

## 0.5.0 hardening (unreleased)

- **XML validity**: `<task_instructions>` is wrapped in CDATA in the Rust and browser writers, so prompts containing `<`, `>`, or `&` no longer break the document. A regression test covers this.
- **MCP sandbox**: every tool's `directory` must stay inside the server's project root. Symlinks and reparse points are rejected. `ptt_get_project_map` checks file size before reading and picks skeleton candidates by architectural tier.
- **New MCP tools**: `ptt_get_related_files` (1-hop imports, importers, and tests) and `ptt_search_symbols` (named functions, methods, types, classes, and interfaces with exact source and line ranges, via tree-sitter).
- **Dependency graph**: grouped Rust imports (`use crate::core::{deps::X, git::Y}`) resolve every module. TypeScript `./foo.js` imports resolve to `foo.ts` or `foo.tsx`, and `@/` maps to `src/`. The graph is built in parallel.
- **Packing**: one parallel pass replaces the 64-file chunks, so uneven files no longer wait on chunk barriers. Tree-sitter parsers are cached per worker thread instead of being created per file. Arrow-function bodies in class fields are elided.
- **CLI `--max-tokens`**: the heuristic pre-pass upgrades files to skeletons above the budget and drops files only above twice the budget. The final fit uses exact per-file BPE counts: skeleton upgrades first, then drops in priority order, verified by a re-pack. Measured: a 20,000-token budget now gives 19,657 tokens (previously 11,337).
- **Symbol extraction**: `find_symbols` names C/C++ functions through their declarator, TypeScript/JavaScript functions bound to a variable (reporting the whole declaration, including `export`), and Rust `impl`, `const`, `static`, and `macro_rules!` items.
- **MCP search and pack**: `ptt_search_symbols` orders files by architectural tier so `src/` results come first, and reads and parses in parallel. `ptt_pack_files` accepts `preset`, `max_tokens`, and `git_diff`, using the same selection code as `ptt pack`.
- **Desktop tree**: token badges for skeleton-marked files count about 30% of their size, matching the packer.

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

Parallel speedup varies between runs: 1.1–1.25× in earlier runs, about 1.8× in the latest. The “sequential” baseline is the same code on a one-thread pool. It is not a measurement of the 0.4.0 chunked implementation, so the effect of removing the chunk barriers has not been measured separately. The earlier 2.4× figure is withdrawn.

Self-pack checks on this repository (release CLI, 0.5.0 working tree):

| Command | Output | Size | Notes |
| --- | --- | ---: | --- |
| `ptt pack .` | 80 files, ~165k tokens | 671 KB | Under the 700 KB target. `<files>` begin with `src/`. |
| `ptt pack . --preset source --skeleton` | 64 files, ~65k tokens | 254 KB | Skeleton mode for smaller packs. |
| `ptt pack . --max-tokens 20000` | 49 files, ~19.7k tokens (98% of budget) | — | Exact BPE count stays within the budget. |
| `ptt pack . --max-tokens 50000` | 62 files, ~48.5k tokens (97% of budget) | — | Exact BPE count stays within the budget. |

The 0.4.0 table reported 155k tokens and 628 KB for the default pack. That was measured before the source changed, so those figures are superseded.

The original 350 KB target was not achievable for full source, because `ui/src/App.tsx` alone is about 144 KB. The project owner changed the target to 700 KB.

## Verification

- `cargo fmt --all -- --check` and `cargo clippy --all-targets -- -D warnings`: pass.
- `cargo test --all-targets`: 77 Rust tests pass (46 library, 12 binary, 19 integration and regression). New tests cover MCP sandboxing, symbol search, related files, grouped Rust imports, `.js` to `.ts` resolution, skeleton element elision, `<task_instructions>` CDATA, and the exact BPE budget.
- `cargo build --release --bin ptt`: pass.
- MCP smoke test through the release binary over stdio: `tools/list` returns five tools. `ptt_search_symbols` returns the exact span. `ptt_get_related_files` returns the expected import. A `directory` of `/etc` is rejected.
- `npm --prefix ui run lint`, `typecheck`, `build`: pass.
- `npm --prefix ui run test:e2e`: 20 Playwright tests pass in Chromium.
- Not run: native desktop tests on macOS, Windows, or Linux; updater and installer flows; the Windows-only junction regression test.

## Limits

1. **Watcher is notification-only.** `workspace-changed` prompts a Refresh; membership is not updated automatically.
2. **No race-proof filesystem sandbox.** Checks mitigate static link and junction escapes. A concurrent process can change paths between check and open.
3. **Secret masking is pattern-based.** It has no entropy or context detection, no measured false-positive or false-negative rate, and it does not catch credentials in unrecognized shapes.
4. **Claude and Gemini counts are scaled approximations** of `o200k_base`. Exact counts apply only to `o200k_base` and `cl100k_base`.
5. **Skeletons are lossy.** Function bodies are removed by design. Languages without a grammar use a fallback that is less precise.
6. **Browser mode is a separate implementation.** It does not run Git, does not implement `.gitignore` or `.pttignore`, and has a 400-file cap.
7. **Native release QA is outstanding.** Installer, signing, notarization, and WebView behavior are not covered by browser tests.
8. **MSRV is declared, not tested.** `rust-version = "1.90"` comes from the resolved dependency graph. CI builds with `stable`.
9. **No legacy charset detection.** BOM-less Windows-1252 and similar files must be converted to UTF-8 first.
10. **MCP symbol search matches name substrings only.** It does not resolve re-exports or aliases.

## Next milestones

1. Native macOS, Windows, and Linux regression runs, with a path-race threat model.
2. Automatic tree refresh from the watcher, with incremental index updates.
3. Secret-scanning evaluation: fixture-based false-positive and false-negative measurements.
4. Before-and-after measurement of the chunk-barrier removal against the 0.4.0 build.
