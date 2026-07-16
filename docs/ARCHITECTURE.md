# Architecture

ProjectToText (`ptt`) is a **Tauri v2** desktop application with a thin UI shell and a pure Rust packing engine.

```
┌─────────────────────────────────────────────┐
│  ui/  (React + TypeScript + Vite)           │
│  selection tree · presets · preview · theme │
└───────────────────┬─────────────────────────┘
                    │  Tauri IPC commands
┌───────────────────▼─────────────────────────┐
│  src/main.rs  (binary)                      │
│  scan_folder · generate_output · save/copy  │
└───────────────────┬─────────────────────────┘
                    │
┌───────────────────▼─────────────────────────┐
│  src/lib.rs  →  ptt core crate              │
│  ├── walker  git ls-files / ignore crate    │
│  └── output  XML · Markdown · JSON · plain  │
└─────────────────────────────────────────────┘
```

## Design goals

1. **Git fidelity** — prefer `git ls-files --exclude-standard`; fall back to the `ignore` crate.
2. **LLM-safe packing** — size limits, binary detection, correct escaping (esp. XML CDATA / JSON).
3. **Testable core** — walker and output live in the library crate and ship with unit tests (no GUI required).
4. **Local-only** — no network packing service; user explicitly copies or saves output.

## Key types

| Type | Location | Role |
|------|----------|------|
| `DirEntryMeta` | `core::walker` | Relative path, dir flag, size |
| `WriteOptions` | `core::output` | Format, summary flag, max file size |
| `FileNode` / `PackOptions` | `main` | IPC DTOs for the frontend |

## Extension points

- **`.pttignore`** — extra exclusions on top of Git ignore rules.
- **Output formats** — add a variant in `OutputFormat` + a writer in `output.rs`.
- **Selection presets** — frontend-only heuristics (source / docs / all clean).

## Security notes

- Symlink escapes outside the project root are skipped in the ignore walk.
- Packed content may still include secrets if the user selects those files; encourage `.gitignore` / `.pttignore`.
