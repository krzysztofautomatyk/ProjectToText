# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Library crate layout (`src/lib.rs`) so walker/output are reusable without the UI
- Architecture doc + polished UI screenshot asset for README
- Tag-driven GitHub Release workflow (`v*.*.*`)
- Comprehensive unit tests for walker and output modules
- Dual license files (`LICENSE-MIT`, `LICENSE-APACHE`) and project docs
- GitHub Actions CI (Rust tests + UI build across macOS/Linux/Windows)
- Real system clipboard fallback via `arboard`
- Save dialog default filename support
- CSP configuration for Tauri webview
- Bundle metadata and multi-size app icons (PNG / ICO / ICNS)

### Fixed

- JSON export now uses `serde_json` (correct escaping of newlines and control chars)
- XML CDATA correctly handles `]]>` inside file contents
- XML attribute escaping for special characters in paths
- `max_file_size` packing option is honored
- Path comparisons normalized to forward slashes (cross-platform selection)
- Git walk path only used inside actual git work trees
- `.gitignore` no longer drops `Cargo.lock` for this binary app
- `tauri.conf.json` frontend npm commands point at `ui/`
- Empty/corrupt app icons that broke Windows Tauri builds
- Linux CI package conflict (`libappindicator` vs Ayatana)
- Windows unit test that attempted to create filenames with illegal `<>` characters

### Changed

- Output API accepts structured `WriteOptions`
- Clearer errors when scan/generate targets a missing path
- Cargo package metadata points at `krzysztofautomatyk/ProjectToText`

## [0.1.0] - 2026-07-12

### Added

- Initial Tauri v2 desktop app
- Git-aware folder scan with `.pttignore`
- XML / Markdown / JSON / plain packing
- React UI: tree selection, presets, themes, shortcuts, drag-and-drop
