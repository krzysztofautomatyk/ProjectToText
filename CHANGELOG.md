# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
