# Contributing to ProjectToText

Thank you for helping improve `ptt`. This document keeps the project healthy for both first-time contributors and long-term maintainers.

## Ground rules

- Be respectful and constructive.
- Prefer small, focused pull requests over large multi-topic changes.
- Match the existing style (Rust 2021, TypeScript strict, clear names).
- Do not commit secrets, personal paths, or generated `target/` / `node_modules/` artifacts.

## Development setup

1. Install Rust (stable), Node.js 20+, and [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/).
2. Clone the repository and install UI deps:

   ```bash
   git clone https://github.com/krzysztofautomatyk/ProjectToText.git
   cd ProjectToText
   npm --prefix ui install
   ```

3. Run the app:

   ```bash
   cargo install tauri-cli --version "^2"   # once
   cargo tauri dev
   ```

4. Run checks before opening a PR:

   ```bash
   cargo test
   cargo clippy --all-targets -- -D warnings
   npm --prefix ui run build
   npm --prefix ui run lint
   ```

## Project layout

| Path | Responsibility |
|------|----------------|
| `src/core/walker.rs` | Git-aware file discovery |
| `src/core/output.rs` | Packing formats (XML/MD/JSON/plain) |
| `src/main.rs` | Tauri commands + app bootstrap |
| `ui/src/` | React UI |

Keep pure logic in `src/core/` so it stays unit-testable without the GUI.

## Pull request checklist

- [ ] Tests added or updated for core behavior you change
- [ ] `cargo test` passes
- [ ] UI still builds (`npm --prefix ui run build`)
- [ ] User-facing changes mentioned in `CHANGELOG.md` under **Unreleased**
- [ ] No unrelated formatting churn

## Commit messages

Use clear, imperative subjects, for example:

- `fix(output): escape CDATA terminators in XML`
- `feat(walker): honor nested .pttignore patterns`
- `docs: clarify install steps for Linux`

## Reporting bugs

Open a GitHub issue with:

1. OS and app version / commit
2. Steps to reproduce
3. Expected vs actual behavior
4. Sample project structure if relevant (redact secrets)

## Security

Do **not** file public issues for vulnerabilities. See [SECURITY.md](SECURITY.md).

## License

By contributing, you agree that your contributions are dual-licensed under MIT OR Apache-2.0, the same as the project.
