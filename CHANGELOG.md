# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.9.0] - 2026-10-17

### Added

- **Prompt Caching (KV-Cache) optimization:** Output serialization splits files into a stable prefix of unmodified base files and places Git-modified files (`status="modified"` in XML/JSON, `*(modified)*` in Markdown) at the end of `<files>`. This stable ordering maximizes prompt prefix cache hits in Anthropic Claude, OpenAI, and Google Gemini.
- **Intelligent `--max-tokens` budgeting engine:**
  - Single-pass in-memory `PreparedWorkspace` with `CachedRender` eliminates redundant disk I/O and re-tokenization across budget iterations.
  - Dependency graph centrality (`DependencyGraph` with an $O(1)$ lookup index covering Rust, TypeScript/JavaScript, Python, Go, and C#) prevents core modules with high incoming import centrality from premature dropping.
  - Two-stage degradation algorithm: Round A converts candidate files to Tree-sitter AST skeletons before Round B drops remaining files starting from lowest priority.
  - File pinning (`--pin <PATH>` in CLI and `pinned_paths` in MCP `ptt_pack_files`) guarantees critical files are never dropped by budget fitting.
- **Self-packing protection across all 4 formats:** Automatic detection and omission of previously generated `ptt` context artifacts across XML, Markdown, JSON, and Plain Text (both native and browser mode), preventing recursive file expansion.
- **Complete MCP Server capabilities (`ptt mcp` MCP 2025-11-25):**
  - Read-only tool annotations: `readOnlyHint: true`, `destructiveHint: false`, `idempotentHint: true`, `openWorldHint: false`.
  - Tools: `ptt_get_project_map`, `ptt_pack_files` (supporting `paths`, `pinned_paths`, `include`, `exclude`, `git_modified`, `git_branch`, `skeleton`, `format`, `preset`, `max_tokens`, `git_diff`, `tokenizer`, `prompt`), `ptt_get_git_context`, `ptt_get_related_files`, `ptt_search_symbols`.
  - Resources: `ptt://project/map` and `ptt://project/git-diff`.
  - Prompts: `architecture_review`, `security_audit`, `git_diff_review`.
- **Advanced security scanner:**
  - High-performance DFA `RegexSet` automaton with 21 rules covering cloud provider tokens (AWS, Anthropic, OpenAI, Google, Stripe, GitHub, GitLab, Slack, Hugging Face, npm, Azure Storage Account Keys, SendGrid, Discord) and PEM private keys.
  - Generic secret detection based on Shannon entropy ($H > 4.5$ bits/char for literals $\ge 32$ chars with placeholder avoidance).
  - TOCTOU protection (`O_NOFOLLOW` and inode verification via `dev/ino` before reading regular files).
- **UI and browser parity:**
  - Full secret masking parity in `ui/src/secrets.ts` including `shannonEntropy`, `AZURE_KEY`, `SENDGRID_KEY`, `DISCORD_TOKEN`, and `HIGH_ENTROPY_SECRET`.
  - Directory structure summary support (`## Directory Structure` in Markdown and `"directory_structure"` in JSON) when `includeSummary` is enabled in browser mode.
  - Token breakdown in UI: exact presentation of `contentTokens`, `overheadTokens`, and `tokenizerExact` with `~` prefix for approximate profiles (`claude`, `gemini`, and browser mode).
  - Default preset exclusions: selection presets in UI and backend exclude `benchmarks/` and lockfiles (`package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`, `Cargo.lock`, `composer.lock`, `Gemfile.lock`, `poetry.lock`, `uv.lock`).

## [0.8.1] - 2026-10-15

### Fixed

- The MCP concurrency limiter uses `compare_exchange_weak` instead of the `fetch_update` helper, which newer stable toolchains flag as deprecated. CI runs with `-D warnings`, so v0.8.0 failed to build there. Behavior is unchanged: a tool slot is taken only while fewer than 16 are in use.

### Changed

- `--max-tokens` (CLI and MCP `ptt_pack_files`) is enforced on the exact token count of the complete serialized artifact, including wrappers, directory structure, paths, escaping, Git diff, and task prompt. The fit re-renders and recounts the whole document each round.
- When no file can be dropped and the artifact still exceeds the budget, the pack fails with an explicit error instead of returning an over-budget artifact.
- Approximate tokenizer profiles (`claude`, `gemini`) are scaled estimates; the CLI prints them with a `~` prefix.
- The task prompt (`<task_instructions>`) is masked with the same rules as file contents and the Git diff when redaction is on, in all formats, in both the CLI and the browser. Before, the prompt was written unmasked.
- `ptt pack` writes a one-line redaction report to stderr on every output path. It gives the masked count by kind, files scanned and skipped, and says that pattern matching is not a guarantee. With `--no-redact` it states that credentials are included unmasked. Stdout is unchanged.

### Changed

- The MCP server no longer advertises protocol revision `2026-07-28`. That revision removes the `initialize` handshake and requires `server/discover`, per-request `_meta`, and `resultType`, none of which this server implements. Supported revisions are now `2025-11-25`, `2025-06-18`, and `2024-11-05`; unknown or unimplemented versions get `2025-11-25`. The CI MCP smoke test and the integration test were updated to match.

### Security

- MCP `notifications/cancelled` no longer grows an unbounded set. An untrusted client could send unlimited cancellations for ids that never arrive. The set is now capped at 1024 pending ids; further cancellations are dropped, which only means that request runs to completion. Found by the new fuzz test.
- Added deterministic fuzz tests for malformed JSON-RPC messages (4,000 mutated messages, each must get a well-formed reply) and hostile `directory` arguments (traversal, absolute, symlink, NUL, very long) that must be refused without leaking outside content.
- `rustls` 0.23.45 → 0.23.46 (lockfile only) fixes RUSTSEC-2026-0346, 0347, 0348, and 0349.

### Added

- Regression tests for file-path attacks on Unix: symlinked directory components, `..` and absolute paths are rejected before any open. A concurrency test swaps a file between real content and a symlink to outside content while the verified open runs, and checks that outside content is never returned (10/10 repeated runs passed). Windows reparse-point tests have not been run.
- Each MCP tool call, `resources/read`, and `prompts/get` has a 30-second time limit and cooperative cancellation (`AtomicBool`) triggered both on timeout and when the client sends `notifications/cancelled` for an in-flight request. At most 16 tool workers run at once, timed-out ones included. A call that arrives while all 16 are busy returns a tool error right away, and a worker's slot is freed when its work ends. A worker that cannot be started returns a tool error instead of crashing the server.
- MCP server now advertises and serves `resources/list` and `resources/read` (`ptt://project/map`, `ptt://project/git-diff`) as well as `prompts/list` and `prompts/get` (`architecture_review`, `security_audit`, `git_diff_review`), plus read-only tool annotations (`readOnlyHint: true`, `destructiveHint: false`, `idempotentHint: true`, `openWorldHint: false`).
- Secret masking expanded from 17 to 21 rules in both Rust (`src/core/secrets.rs`) and browser TypeScript (`ui/src/secrets.ts`), adding Azure Storage Account keys (`AZURE_KEY`), SendGrid keys (`SENDGRID_KEY`), Discord bot/webhook tokens (`DISCORD_TOKEN`), and Shannon-entropy-gated generic credential assignments (`HIGH_ENTROPY_SECRET`, $H > 4.5$ bits/char for literals $\ge 32$ chars). Corpus evaluation covers 21/21 true positives and 0/20 false positives across Rust and Playwright.
- Single-pass in-memory budget fitting (`PreparedWorkspace`) avoids re-reading and re-tokenizing unchanged files across `--max-tokens` iterations, and uses dependency-graph importer centrality (`drop_priority_order_with_graph`) so heavily imported core modules survive ahead of isolated files.
- Desktop UI improvements: tree badges display exact BPE token counts (`exact BPE` vs `heuristic`) once a pack has been generated; the Context Budget bar breaks down full content, AST skeletons, and wrapper/diff/prompt overhead; and the File Viewer offers a Full / AST Skeleton toggle with savings percentage and related-file chips.
- Integration test `tests/mcp_stdio_client.rs` drives the built `ptt mcp` binary over stdio: handshake, `tools/list`, one call to each of the five tools, `resources/list`, `resources/read`, `prompts/list`, and `prompts/get`. It checks that stdout carries only protocol JSON and stderr stays empty. It passes in debug and release builds. CI runs it on Linux, macOS, and Windows.
- CI runs `cargo audit` (RustSec) and `cargo deny` (`deny.toml`) and fails on any vulnerability or license violation. Two informational warnings are triaged in `SECURITY.md`.
- The release workflow fails if any of the four platform installers, or its `.sig`, is missing from the release.
- `ptt pack --pin <PATH>` marks a project file that budget fitting never drops. If the pinned files alone exceed `--max-tokens`, the pack fails with an error that names them.
- Regression tests: pinned files survive a fit that drops others; a pinned file that alone exceeds the budget fails closed; repeated fits are deterministic.
- Regression tests: a secret in the task prompt is masked in XML, Markdown, JSON, and plain output and counted in the report (Rust); the same holds in the browser (Playwright).

## [0.8.0] - 2026-10-15

### Added

- Symbol search reads grouped Rust re-exports (`pub use core::output::{ a, b as c };`), each name under its exported alias. It also reads TypeScript `import { a as b }` aliases and `export * as ns from './m'` namespace re-exports. `ptt`'s own `src/lib.rs` now lists its re-exports.
- `WorkspaceIndex::refresh_paths` updates the current snapshot in place when watcher events only modify indexed files. It falls back to a full scan when files are created or removed, or when ignore files change.
- The MCP server keeps one process-local workspace index, so repeated `ptt_get_related_files` calls reuse the dependency graph.

### Changed

- The dependency graph keeps each file's source in memory. A file-set change (a file added or removed) re-resolves unchanged files from that cache instead of reading them from disk again.
- The desktop watcher queues changed paths. A refresh after in-place edits uses `refresh_paths`, not a full directory walk.
- `ui/src/useWorkspace.tsx` is split into `useThemeAndLayout.ts` (theme, sidebar resize, tree viewport) and `useFilePreviewAndMenu.ts` (file preview, editor launchers, context menu, dependency selection). Each UI source file is under 38 KB.
- `SECURITY.md` lists 0.8.x as supported.

## [0.7.0] - 2026-10-15

### Added

- Secret corpus covers all 17 masking rules: 17/17 synthetic credentials masked and 0/20 benign snippets changed, in Rust and Playwright. The GitHub fine-grained token and `DB_PASSWORD=` rules now have cases.
- Symbol search finds Rust `pub use` re-exports (under their alias when present), `pub mod name;` declarations, TypeScript and JavaScript `export { ... }` specifiers (under their exported name), and Go `const` and `var` specs.
- `examples/selection_benchmark.rs` compares chunked (64-file) and single-pass packing on 800 uneven files.

### Changed

- `ui/src/App.tsx` is a 1.2 KB shell. The state, effects and handlers moved to `ui/src/useWorkspace.tsx`. The header, toolbar and status bar are in `ui/src/AppChrome.tsx`, the budget and prompt studio in `ui/src/BudgetAndPromptBar.tsx`, and the main panel in `ui/src/MainPanel.tsx`.
- Copy, Save and the full preview validate the workspace ignore rules before reusing a pack. A changed `.pttignore` or `.gitignore` fails closed with "Ignore rules changed; refresh the project before packing". A pack that includes git diff is rebuilt, because file stamps do not cover diff content.
- A rescan reuses the import resolutions of files whose modification time and length are unchanged. The cache is ignored when the file set changes, because a new file can satisfy an old import.
- `pub mod name { ... }` inline modules are not reported as symbols, so their bodies are not returned.
- `SECURITY.md` supports 0.5 and later.

## [0.6.0] - 2026-10-14

### Added

- Secret masking for GitLab personal access tokens, Hugging Face tokens, npm tokens, and JWTs, in the Rust and browser implementations.
- Fixture corpus for secret scanning: 15 positive cases (15/15 masked) and 20 benign snippets (0/20 changed), in Rust and Playwright.
- Desktop auto-refresh: a `workspace-changed` event re-scans the open folder after 800 ms and keeps the current selection and skeleton marks.

### Changed

- `ui/src/App.tsx` is split: tree model and helpers in `ui/src/treeModel.ts`, and panels, dialogs, and tree rows in `ui/src/Panels.tsx`.
- Copy, Save, and the full preview check the packed files on disk. If a selected file changed since packing, the output is rebuilt from the current contents.

## [0.5.0] - 2026-10-14

### Added

- **MCP pack options**: `ptt_pack_files` accepts `preset`, `max_tokens`, and `git_diff`, with the same selection rules as `ptt pack`.
- **MCP symbol and dependency tools**: `ptt_search_symbols` returns named functions, methods, types, classes, and interfaces with their exact source and line range. `ptt_get_related_files` returns a file's 1-hop imports, importers, and tests.

### Fixed

- `<task_instructions>` is wrapped in CDATA in the CLI, desktop, and browser output, so prompts containing `<`, `>`, or `&` produce valid XML.
- The MCP `directory` argument is confined to the server's project root. Symlinks and reparse points are rejected, and a project-map file is size-checked before it is read.
- `ptt_get_project_map` picks skeleton candidates by architectural tier instead of alphabetical order.
- Dependency graph: grouped Rust imports (`use crate::core::{deps::X, git::Y}`) resolve every module, and TypeScript `./foo.js` imports resolve to `foo.ts`/`foo.tsx` with `@/` aliases mapped to `src/`.
- `--max-tokens` fits the pack with exact per-file BPE counts. Full files are upgraded to skeletons first, then the lowest-priority files are dropped, so a 20,000-token budget now yields about 19.7k tokens instead of 11.3k.
- `ptt_search_symbols` finds C/C++ functions, TypeScript/JavaScript functions bound to a variable, and Rust `impl`, `const`, `static`, and `macro_rules!` items. Results are ordered by architectural tier, so `src/` is returned first.
- The desktop tree's token badges count skeleton-marked files at about 30% of their size, matching the packer's estimate.

### Changed

- Parallel packing runs in a single pass instead of 64-file chunks, so uneven files no longer wait on chunk barriers.
- Tree-sitter parsers are cached per worker thread instead of being created for every file.
- The benchmark reports BPE throughput and skeleton extraction separately. Packing is measured with one thread against the default pool.

## [0.4.0] - 2026-10-14

### Added

- **Exact token counts**: `tiktoken` BPE counts (`o200k_base` by default, `cl100k_base` available) per file and per pack. Claude and Gemini profiles scale the `o200k_base` count and are approximations.
- **Context budget**: a target-window selector (32k to 1M, or custom), a progress bar, a Top Token Consumers list with Skeleton and Exclude actions, and **Auto-Fit** to 90% of the budget. CLI: `--max-tokens`.
- **AST skeletons**: tree-sitter bodies removal for Rust, TypeScript/TSX, JavaScript, Python, Go, C#, Java, C, and C++, with a brace or indentation fallback. Per-file and per-folder `[S]` toggles and a `Core Full + Rest Skeleton` preset.
- **Git context**: status badges (modified, added, untracked, deleted), **Select Git Modified**, **Select Branch Changes**, and an **Include `<git_diff>`** option. CLI: `--git-modified`, `--git-branch`, `--git-diff`.
- **Dependency neighbors** (desktop): select a file's imports, importers, or related tests from its context menu.
- **Prompt templates**: a collapsible prompt bar (architecture review, bug investigation, security audit, test writing, custom). The task is emitted as `<task_instructions>` at the end of the pack.
- **CLI parity**: `--preset`, `--include`, `--exclude`, `--skeleton [GLOB]`, `-c/--copy` (system clipboard), `--prompt`, and `--no-redact`.
- **MCP server**: `ptt mcp [DIR]` speaks JSON-RPC 2.0 over stdio with `ptt_get_project_map`, `ptt_pack_files`, and `ptt_get_git_context`.
- **Secret masking** extended to Anthropic, Google, and Stripe keys, URL basic-auth passwords, and `.env` `*_SECRET`/`*_TOKEN`/`*_API_KEY`/`*_PRIVATE_KEY` assignments. Documentation placeholders (`...`, `***`) are not masked. The desktop app shows a masked-count badge.
- **Default exclusions**: presets leave lockfiles and `gen/schemas/` unchecked. A root `.pttignore` covers this repository's generated files and packed outputs.
- **Architectural ordering**: `<files>` content is emitted source first, then manifests, tests, and docs/CI. `<directory_structure>` stays alphabetical.
- **File watcher**: the desktop app emits `workspace-changed` when the project changes.

### Changed

- Zero-copy IPC: packed output stays in Rust memory and only a bounded preview crosses to the UI. Copy and Save use the complete output.
- Parallel reading, decoding, skeletonization, redaction, and token counting with `rayon`. Output is byte-identical to sequential packing.
- Ignore-rule freshness checks use cached directory and file metadata. Selection matching uses a normalized path set.
- The file tree is built in O(N log B) with memoized sorting and viewport virtualization for large repositories.
- Minimum supported Rust version is 1.90, the highest minimum among resolved dependencies.

## [0.3.0] - 2026-10-14

### Added

- **Secret masking in packed output**: recognizable credentials (AWS, OpenAI, GitHub and Slack tokens, PEM private key blocks, `Password=` connection-string pairs and `*_PASSWORD=` assignments) are replaced with `[REDACTED: <KIND>]` in every format, in the desktop app, the CLI and browser mode. This is best-effort, not a guarantee.

### Fixed

- Generation superseded by a newer request stops before reading the next file, so stale output is not produced.
- Git scanning on Windows no longer flashes console windows.
- A malformed entry in a project's own `.gitignore` no longer aborts the scan, matching Git; a malformed `.pttignore` still fails closed.
- `<file_summary>` in XML output no longer counts files skipped by `max_file_size` toward `Total size`.
- Deselect all cancels an in-flight generation so its late result cannot repopulate the output.
- Preset buttons keep files excluded in the Custom replay list unchecked.

## [0.2.6] - 2026-10-13

### Added

- **Token estimates in the file tree**: every folder and file shows an approximate token count (`~N tok`, bytes ÷ 3.8, the same heuristic as the badge). A Sort name/tokens toggle orders each folder's children by token weight. Nothing is read from disk for this, so the scan cost does not change.

### Fixed

- Git scanning now honors directory and nested `.pttignore` rules with scoped overrides and parent-directory pruning; fallback scanning no longer accidentally re-enables hidden-file filtering or `.ignore` rules.
- Packing and preview reject unsafe relative paths, intermediate symlinks/reparse points, and failed canonicalization. Editor paths are safely simplified on Windows; concurrent filesystem races remain outside these checks.
- UTF-8 / BOM-declared UTF-16 decoding works in native and browser pack/preview, with strict malformed-encoding reporting and safe truncated Unicode previews.
- Markdown fences are longer than any backtick run in the file, including mixed backtick/tilde content.
- Custom projects responds to Escape; invalid CLI commands no longer silently launch the GUI.

### Changed

- Desktop generation reuses a revisioned workspace scan; Refresh rebuilds membership and changed indexed ignore files require refresh. Blocking command I/O runs in the blocking pool.
- Selection uses ancestor HashSet lookups and tree statistics are computed once per update. Large packed previews are bounded by default without truncating copied/saved output.
- `ptt [DIR]` opens the desktop workspace on startup. CLI writes through a buffered writer and refuses to overwrite an existing input file; JSON still builds a document in memory.
- Removed unused frontend Tailwind/autoprefixer/direct PostCSS dependencies and configuration.
- Replaced the unsupported perfect-score expert review with regression evidence, a reproducible benchmark, and explicit limitations.

## [0.2.5] - 2026-10-13

### Fixed

- macOS app bundles are now signed (ad-hoc), so Apple Silicon Macs no longer report the app as "damaged" after install. The app is still not notarized, so Gatekeeper asks users to confirm opening it.

## [0.2.4] - 2026-10-13

### Changed

- Release files now have readable names that state the platform: `ptt-<version>-macos-apple-silicon.dmg` (M1 and newer), `ptt-<version>-macos-intel.dmg`, `ptt-<version>-windows-x64.msi`, `ptt-<version>-windows-x64-setup.exe`, `ptt-<version>-linux-x64.AppImage`, `.deb` and `.rpm`.

## [0.2.2] - 2026-10-13

### Fixed

- Packing no longer follows symlinks: a tracked link pointing outside the project is skipped, so its target's contents never end up in the output.
- Packed output no longer contains the absolute project path; only the folder name is written.
- Removed the `// [ptt read info]` line that was prepended to every packed file.
- "Open with" only launches the known editors (VS Code, Cursor, Notepad++); other programs go through "Choose program".
- "Open with default app" refuses executables and scripts (for example `.exe`, `.bat`, `.ps1`, `.sh`).

### Removed

- The unused `relative_paths` pack option.

## [0.2.1] - 2026-10-13

### Added

- **Automatic updates**: the app checks for a new release on startup. When one is available, an "Update to vX" button appears in the header; clicking it downloads, installs and restarts the app. Updates are signed and verified before installation.
- **About dialog** (About button in the footer): shows the app version, author, link to the GitHub repository and the list of frontend and Rust libraries.

### Changed

- Release workflow signs updater artifacts and publishes `latest.json`, and verifies that the manifest contains all four platforms.

## [0.2.0] - 2026-10-12

### Added

- **Custom projects panel** (Custom button next to History): per-project list with saved file/folder selection exclusions, manage entries, open project straight from the panel.
- **Favorites**: star a project and it always appears at the top of the Custom list; favorite state persists across restarts.
- **Project notes**: free-form per-project comment (e.g. why files were excluded), editable in place, stored permanently.
- **Selection-exclusion replay**: files you uncheck are remembered per project and automatically deselected again the next time you open that project; re-checking a file removes it from the exclusion list.
- **Preferences export/import**: one-click JSON snapshot export of all custom projects + folder history (`ptt-prefs-YYYYMMDD.json`) and defensive merge-on-import from any machine, with clear validation errors and skip counts.
- **Version chip in the header** showing the running app version (`v0.2.0`).

### Fixed

- **Windows**: app no longer opens an empty terminal/console window alongside the GUI (release builds are now GUI-subsystem binaries).
- Windows terminal-launched `ptt pack ...` output works: the release binary attaches to the parent console on start, so CLI output is visible while GUI launches (Explorer/Start Menu) still open no console.

### Changed

- Dependency refresh: Tauri 2.12, React 19.3, Vite 8.3, TypeScript 6.0 toolchain and all Cargo/npm dependencies to latest compatible versions.

## [0.1.3] - 2026-08-07

### Added

- Repository-managed macOS (`.app` / `.dmg`) and Windows (`.msi` / NSIS `.exe`) installer scripts and platform-specific Tauri bundle settings.
- Persistent desktop folder history with pinned projects and quick reopen.
- Clear current project action for quickly opening another folder.

## [0.1.2] - 2026-07-20

### Added

- Headless CLI: `ptt pack [DIR]` (formats, `-o`, `--no-summary`, `--max-size`)
- Multi-platform GitHub Release builds (macOS arm64/x64, Linux, Windows) via Tauri action
- Playwright browser smoke E2E tests (`npm run test:e2e`) + CI job
- Install-from-Releases section in README; explicit approx token estimate docs
- Expert panel scorecard updated to **10/10** (`docs/EXPERT_REVIEW.md`)

### Changed

- Release workflow attaches desktop installers (not notes-only)
- Token badge labels “approx” and documents `chars ÷ 3.8` heuristic
- Version bump to 0.1.2 across Cargo, Tauri, UI

## [0.1.1] - 2026-07-20

### Added

- Browser mode: folder picker via File System Access API / `webkitdirectory` when not under Tauri
- In-app file preview with syntax highlighting (click a file in the tree)
- Open file with system default app, VS Code / common editors, or choose program
- Context menu on files: preview, open with, toggle pack selection
- Source preset includes .NET / XAML / Blazor / project files (`.xaml`, `.csproj`, `.razor`, …)
- Library crate layout (`src/lib.rs`) so walker/output/preview are reusable without the UI
- Architecture doc + polished UI assets for README
- Tag-driven GitHub Release workflow (`v*.*.*`)
- Comprehensive unit tests for walker, output, and preview modules
- Dual license files (`LICENSE-MIT`, `LICENSE-APACHE`) and project docs
- GitHub Actions CI (Rust tests + UI build across macOS/Linux/Windows)
- Real system clipboard fallback via `arboard`
- Save dialog default filename support
- CSP configuration for Tauri webview
- Bundle metadata and multi-size app icons (PNG / ICO / ICNS)
- Multi-shot product screenshots (JPG + SVG) for README gallery

### Fixed

- Loading state stuck after folder dialog cancel/error (`generating` flag always cleared)
- Browser scan robustness and clearer success/cancel toasts
- JSON export uses `serde_json` (correct escaping of newlines and control chars)
- XML CDATA correctly handles `]]>` inside file contents
- XML attribute escaping for special characters in paths
- `max_file_size` packing option is honored
- Path comparisons normalized to forward slashes (cross-platform selection)
- Git walk path only used inside actual git work trees
- `.gitignore` no longer drops `Cargo.lock` for this binary app
- `tauri.conf.json` frontend npm commands point at `ui/` (`cwd`)
- Empty/corrupt app icons that broke Windows Tauri builds
- Linux CI package conflict (`libappindicator` vs Ayatana)
- Windows unit test that attempted to create filenames with illegal `<>` characters

### Changed

- Output API accepts structured `WriteOptions`
- Clearer errors when scan/generate targets a missing path
- Cargo package metadata points at `krzysztofautomatyk/ProjectToText`
- CONTRIBUTING/README: explicit Windows setup for Rust/`cargo`, MSVC, WebView2
- README rewritten for public launch (gallery, quick start, security, architecture)

## [0.1.0] - 2026-07-12

### Added

- Initial Tauri v2 desktop app
- Git-aware folder scan with `.pttignore`
- XML / Markdown / JSON / plain packing
- React UI: tree selection, presets, themes, shortcuts, drag-and-drop
