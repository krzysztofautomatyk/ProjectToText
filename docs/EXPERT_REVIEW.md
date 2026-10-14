# Engineering review: phase 1

**Scope:** local changes based on v0.2.5, not a published release.

**Date:** 2026-10-13.

**Status:** regression-driven hardening; no independent certification or competitive ranking.

This document replaces an earlier self-assessment claiming a “10.0 / 10 panel consensus.” No independent panel, scoring methodology, or evidence supporting that score was recorded. That assessment is withdrawn. Passing tests is evidence for particular behaviors, not proof of complete security or market leadership.

## Findings and changes

| Area | Reproduced or inspected | Phase-one result |
| --- | --- | --- |
| Directory `.pttignore` rules | `secrets/` failed to exclude descendants on the Git path. | Evaluate parent directories top-down, prune excluded parents, load nested matchers with their own roots and precedence. Negation cannot resurrect a child of an ignored directory. |
| Nested `.pttignore` | Git path loaded only the root file. | Load rules for each traversable indexed directory, including rule files omitted by Git's listing. Invalid/unreadable rules fail closed on that path. |
| Output path containment | A synthetic `../secret.txt` entry and a file under an intermediate symlink exposed outside contents. | Validate relative components, reject link/reparse components, require canonicalization and root containment before each read; reject non-regular files. |
| Preview canonicalization | Missing files were accepted by the resolver. | Propagate canonicalization errors; no unchecked fallback path. Use `dunce::simplified` only when presenting paths or launching editors. |
| Text encoding | BOM-declared UTF-16 was classified as binary. | Shared strict UTF-8 / UTF-16LE/BE BOM decoder, including truncated Unicode previews. Browser mode follows the same declared-encoding policy. Unsupported or malformed encodings are reported, not guessed as Windows-1252. |
| Markdown boundaries | Mixed backtick and tilde runs prematurely ended the old fences. | Use backticks longer than the longest content run in both packers. |
| Selection lookup | Nested list scan repeatedly normalized/allocated paths. | Normalize selections once into a HashSet and check candidate ancestors. Candidate work scales with path depth, not selection count; this is not global O(1). |
| Repeated workspace scan | Each generation ran Git and walked the project again. | A single-workspace, revisioned Arc snapshot is built on Open/Refresh. Generation selects from that index. Existing indexed directory ignore-file contents are checked before use; changes require Refresh. |
| Blocking I/O | Synchronous disk/process calls ran in async commands. | Scan, generation, preview, external-app launch, clipboard, and save I/O run through Tauri's blocking pool. |
| Frontend work | Recursive subtree totals repeated across tree items; full output always rendered. | Compute subtree statistics once per selection/filter. Above 150,000 characters, default output preview shows 100,000 characters; explicit full preview is available. Copy/Save retain the full output. |
| Startup / CLI | Unknown commands fell through to GUI; folder argument was discarded. | `ptt [DIR]` validates a directory and requests its initial scan. Invalid commands exit 2. CLI uses buffered writes rather than a complete extra byte buffer; JSON still builds its document in memory. Existing input files cannot be used as the output destination. |
| UX / dependencies | Escape omitted the Custom panel; Tailwind was not wired into the build. | Escape closes Custom; remove unused Tailwind/autoprefixer/direct PostCSS dependencies and Tailwind configuration. Vite still supplies its own transitive PostCSS dependency. |

Seven initial regression tests failed before repairs and passed afterward. Additional tests cover Git/fallback parity, ancestor selection, workspace revision/freshness, browser encoding/fences, and the frontend IPC contract.

## Reproducible performance measurement

Run from the repository root:

```bash
cargo run --release --locked --example selection_benchmark
```

Fixture: 10,000 synthetic paths at shallow package/src depth, first 8,000 selected exactly. The benchmark asserts identical old/new selected paths. It compares the retained legacy predicate with the new matcher in one optimized binary, and separately creates a 10,000-file non-Git workspace. Medians use three selection repetitions and five cached-index repetitions. This is a warm, local microbenchmark, not a cross-platform responsiveness SLA.

Final local result on macOS arm64:

| Operation | Median / duration |
| --- | ---: |
| Legacy selection filter | 5396.207 ms |
| New selection matcher, including set construction | 1.049 ms |
| Initial non-Git scan, 10,000 small files | 200.037 ms |
| Cached lookup + ignore-rule validation + selection/cloning | 3.840 ms |

Numbers vary with machine, filesystem, path depth, directory count, and background load. Ignore-rule validation still performs filesystem reads; file contents are reread when generating a pack. These results **exclude** content reads, format generation, IPC, the 180 ms selection debounce, and WebView rendering. They do not establish “checkbox below 5 ms,” Chromium/Linux-kernel scale, or end-to-end speedup.

## Verification

- Rust formatting, `cargo test --all-targets --locked` (39 tests on macOS), Clippy with warnings denied, and local compilation.
- Rust regression tests for ignores, UTF-16, malformed/truncated text, Markdown, parent escape, intermediate symlink, cached selection, and stale revisions.
- Actual CLI subprocesses: all four formats, JSON on stdout, invalid-command status, and input-overwrite rejection.
- Frontend lint, typecheck/production build, eight Playwright tests; the shared browser Preview also exercised Custom → Escape without console errors.
- The desktop frontend's startup/revision/no-rescan/copy-completeness/error behavior is exercised with an **IPC fixture**, not a real native WebView. Browser fallback decoding is tested in Chromium.
- A Windows-only junction regression is included, but **not run on this macOS host**. Windows editor path interoperability also requires native testing.

## Limits and unresolved work

1. **No filesystem watcher yet.** Open/Refresh rebuilds the membership index. New files and directories require Refresh; content changes to indexed files are read on generation. Current indexed ignore files are checked, not all external/global Git configuration changes. No claim of automatic incremental consistency.
2. **No race-proof filesystem sandbox.** Component and canonical checks mitigate static link/junction escapes, but another process can change paths between checking and opening (TOCTOU). Handle-relative, no-follow I/O across platforms is a further security milestone. Tauri commands are not a sandbox against an already-compromised frontend.
3. **No full UI virtualization.** The tree still mounts expanded rows; the full output remains in JavaScript and crosses IPC. Preview bounding and one-pass statistics reduce work but do not fix every large-repository bottleneck. Concurrent background generation is not cancelled/coalesced in Rust.
4. **No automatic legacy charset detection.** Convert Windows-1250/1252 and other BOM-less legacy encodings to UTF-8; UTF-16 without a BOM is not inferred. Mixed-encoding files are not supported.
5. **No native release QA in this pass.** Native startup via the actual macOS WebView, Windows/Linux installation, managed-machine policies, code-signing, and notarization are not certified by browser tests.
6. **No full DLP.** Packed output masks a fixed set of recognizable credential shapes (`src/core/secrets.rs`, mirrored in `ui/src/secrets.ts`). There is no entropy-based or context-aware detection, no measured false-positive/false-negative rate, and no user control to disable redaction. AST compression, Git diff context, MCP, CLI presets, and clipboard CLI flag are also not implemented.
7. **No exact model token counts.** A tokenizer is exact only for its actual encoding/model. `tiktoken` is not an exact generic tokenizer for Claude and Gemini; do not label approximation as precision.
8. **No measured 70–85% compression or Top-3 ranking.** Compression requires language-specific correctness tests and representative measurements; competitive claims require current evidence and a stated methodology.

## Next milestones

1. Native macOS/Windows/Linux regression runs, path-race threat model, watcher/index invalidation design, full frontend virtualization and generation backpressure.
2. Token-budget UI with clearly named supported tokenizer encodings and measured overhead.
3. Secret scanning with fixture-driven false-positive/false-negative evaluation, explicit redaction controls, and transparent limits.
4. Language-specific AST skeletons, then Git context, prompt templates, and scoped MCP integration.

## References

- [Git ignore precedence and directory pruning](https://git-scm.com/docs/gitignore)
- [ignore Gitignore API](https://docs.rs/ignore/0.4/ignore/gitignore/struct.Gitignore.html)
- [encoding_rs decoder semantics](https://docs.rs/encoding_rs/latest/encoding_rs/struct.Decoder.html)
- [dunce path simplification](https://docs.rs/dunce/latest/dunce/fn.simplified.html)
