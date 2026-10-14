# Engineering review: 0.4.0

**Scope:** local changes on top of v0.3.0, prepared for release 0.4.0 (2026-10-14). Not a published release until tagged.

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
- **MCP server** (`ptt mcp`) with three tools.
- **File watcher**: `notify` events emit `workspace-changed` in the desktop app.
- **Virtualized tree** with memoized sorting for large repositories.

## Measurements

Command, from the repository root:

```bash
cargo run --release --example selection_benchmark
```

Single run on macOS arm64 (`rustc 1.97.1`). Values vary with machine, filesystem, and load:

| Measurement | Result |
| --- | ---: |
| Legacy selection predicate, 10,000 paths | 4899.5 ms |
| New selection matcher, including set construction | 1.0 ms |
| Initial non-Git scan, 1,000 files | 27.1 ms |
| Cached lookup + ignore-rule check + selection | 0.13 ms |
| Pack of 800 files, sequential | 17.1 ms |
| Pack of 800 files, parallel (`rayon`) | 15.2 ms (about 1.1× faster in this run) |
| BPE tokenizer, full source (35 files, 448,618 bytes, `o200k_base`) | 107,932 tokens in 15.2 ms median (≈7.1M tokens/s, ≈28 MiB/s) |
| AST skeleton extraction, same source | 26.4 ms median |
| Skeleton compression, ptt's own source (exact BPE tokens) | 107,932 → 26,537 tokens (75.4% reduction) |

The tokenizer and skeleton timings are measured separately, after an encoder warm-up, with file reads excluded. Each is the median of three repetitions. An earlier run in the same session reported 75.7% for the same measurement; the source changed between runs, so the figure moves slightly.

The parallel speedup on 800 small files is modest and varies between runs: 1.25× in the first run and about 1.1× in the latest. Earlier documentation claimed about 2.4×; that figure was not reproduced and is withdrawn.

Self-pack check on this repository (release CLI, 0.4.0):

| Command | Output | Size | Notes |
| --- | --- | ---: | --- |
| `ptt pack .` | 80 files, ~155k tokens | 628 KB | `<files>` begin with `src/`; no `gen/schemas/`, lockfiles, or screenshots in `<directory_structure>` |
| `ptt pack . --preset source` | 64 files, ~144,104 tokens | 591 KB | Full source |
| `ptt pack . --preset source --skeleton` | 64 files, ~63,374 tokens | 247 KB | Skeleton mode is well under the 700 KB target |

The original 350 KB target was not achievable for full source, because `ui/src/App.tsx` alone is about 144 KB. The target was changed to 700 KB by the project owner. The default full pack (628 KB) meets it; skeleton mode is available for smaller packs.

## Verification

- `cargo fmt --all -- --check` and `cargo clippy --all-targets -- -D warnings`: pass.
- `cargo test --all-targets`: 68 Rust tests pass (42 library, 8 CLI and desktop, 18 integration and regression). The regression suite covers redaction, self-redaction of this repository, parallel determinism, ordering, skeletons, and `<task_instructions>` placement.
- `npm --prefix ui run lint`, `typecheck`, `build`: pass.
- `npm --prefix ui run test:e2e`: 20 Playwright tests pass in Chromium, including a new browser-mode test for `<files>` ordering and the alphabetical directory listing.
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

## Next milestones

1. Native macOS, Windows, and Linux regression runs, with a path-race threat model.
2. Automatic tree refresh from the watcher, with incremental index updates.
3. Secret-scanning evaluation: fixture-based false-positive and false-negative measurements.
4. Symbol-level MCP retrieval (search and fetch a single function or type) so agents can request exact code without packing whole files.
