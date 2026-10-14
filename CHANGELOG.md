# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
