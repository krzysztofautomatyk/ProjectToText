# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Multi-shot product screenshots (JPG + SVG) for README gallery
- Expert panel publish review (`docs/EXPERT_REVIEW.md`)
- Expanded architecture notes (desktop + browser paths)

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
