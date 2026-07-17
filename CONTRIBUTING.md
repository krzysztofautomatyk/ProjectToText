# Contributing to ProjectToText

Thank you for helping improve `ptt`. This document keeps the project healthy for both first-time contributors and long-term maintainers.

## Ground rules

- Be respectful and constructive.
- Prefer small, focused pull requests over large multi-topic changes.
- Match the existing style (Rust 2021, TypeScript strict, clear names).
- Do not commit secrets, personal paths, or generated `target/` / `node_modules/` artifacts.

## Prerequisites (install these first)

`cargo` is **not** a Windows built-in. It comes with the **Rust** toolchain.  
If PowerShell or CMD says `cargo` is not recognized, Rust is missing or the terminal was not restarted after install.

### 1. Git

- Download: https://git-scm.com/download/win  
- During setup, keep “Git from the command line” enabled.

### 2. Node.js 20+ (includes `npm`)

- Download LTS: https://nodejs.org/  
- Verify in a **new** terminal:

  ```powershell
  node -v
  npm -v
  ```

### 3. Rust + Cargo (required for `cargo …`)

**Windows (recommended):**

1. Open https://rustup.rs/ and run `rustup-init.exe`, **or** in PowerShell:

   ```powershell
   winget install Rustlang.Rustup
   ```

2. When the installer asks about the toolchain, choose the default (**stable**).
3. Install the **MSVC** build tools if prompted (Visual Studio Build Tools / “Desktop development with C++”).  
   Tauri on Windows needs the MSVC linker; pure MinGW often fails later.
4. **Close and reopen** the terminal (PATH is updated only for new sessions).
5. Verify:

   ```powershell
   rustc -V
   cargo -V
   ```

You should see version numbers. If not:

```powershell
# Ensure cargo is on PATH (typical location)
$env:Path += ";$env:USERPROFILE\.cargo\bin"
cargo -V
```

Permanent fix: add `%USERPROFILE%\.cargo\bin` to your user PATH in Windows Settings → Environment variables, then open a new terminal.

### 4. Tauri system dependencies (Windows)

Follow the official list:  
https://v2.tauri.app/start/prerequisites/#windows

In practice you need:

- **WebView2** (usually already on Windows 10/11; install the Evergreen runtime if missing)
- **Visual Studio Build Tools 2022** with workload **“Desktop development with C++”**  
  (or full Visual Studio with that workload)

### 5. Optional but recommended

- **Git** on `PATH` (best ignore fidelity while scanning projects)

### Quick health check

```powershell
git --version
node -v
npm -v
rustc -V
cargo -V
```

All five should print versions before you continue.

---

## Development setup

### Clone and install UI deps

```powershell
git clone https://github.com/krzysztofautomatyk/ProjectToText.git
cd ProjectToText
npm --prefix ui install
```

### Install Tauri CLI (once per machine)

```powershell
cargo install tauri-cli --version "^2"
```

This takes a few minutes the first time. After it finishes:

```powershell
cargo tauri --version
```

### Run the app

From the **repository root** (`ProjectToText`, not `ui/`):

```powershell
cargo tauri dev
```

What should happen:

1. Vite starts the UI (`http://localhost:5173`)
2. Rust compiles the desktop shell
3. The `ptt` window opens

First compile can take several minutes; later runs are faster.

### Run checks before opening a PR

```powershell
cargo test
cargo clippy --all-targets -- -D warnings
npm --prefix ui run build
npm --prefix ui run lint
```

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|--------|----------------|-----|
| `'cargo' is not recognized` | Rust not installed or old terminal | Install [rustup](https://rustup.rs/), **restart terminal**, check `%USERPROFILE%\.cargo\bin` is on PATH |
| `'npm' is not recognized` | Node not installed | Install Node LTS from nodejs.org, restart terminal |
| `link.exe` / MSVC errors | Missing C++ build tools | Install VS Build Tools → “Desktop development with C++” |
| WebView2 errors | Runtime missing | Install [WebView2 Evergreen](https://developer.microsoft.com/microsoft-edge/webview2/) |
| `ui/ui/package.json` ENOENT | Wrong npm prefix / cwd | Pull latest `main`; use `cargo tauri dev` from repo root only |
| Slow first `cargo tauri dev` | Cold compile | Normal; wait for `Finished` |

### Still stuck?

Open a GitHub issue with:

1. Windows version  
2. Output of `rustc -V`, `cargo -V`, `node -v`, `npm -v`  
3. Full error text from the terminal  

---

## Project layout

| Path | Responsibility |
|------|----------------|
| `src/core/walker.rs` | Git-aware file discovery |
| `src/core/output.rs` | Packing formats (XML/MD/JSON/plain) |
| `src/lib.rs` | Pure core library |
| `src/main.rs` | Tauri commands + app bootstrap |
| `ui/src/` | React UI |

Keep pure logic in `src/core/` so it stays unit-testable without the GUI.

## Pull request checklist

- [ ] Tests added or updated for core behavior you change
- [ ] `cargo test` passes
- [ ] UI builds (`npm --prefix ui run build`)
- [ ] User-facing changes mentioned in `CHANGELOG.md` under **Unreleased**
- [ ] No unrelated formatting churn

## Commit messages

Use clear, imperative subjects, for example:

- `fix(output): escape CDATA terminators in XML`
- `feat(walker): honor nested .pttignore patterns`
- `docs: clarify Windows install steps for cargo`

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
