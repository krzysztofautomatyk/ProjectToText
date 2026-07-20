# Architecture

ProjectToText (`ptt`) is a **Tauri v2** desktop application with a thin UI shell and a pure Rust packing engine. A browser fallback (Vite-only) reimplements scan/pack in TypeScript for environments without the native shell.

```
┌──────────────────────────────────────────────────────────┐
│  ui/  (React + TypeScript + Vite)                        │
│  tree · presets · preview · theme · browser pack path    │
└────────────────────────────┬─────────────────────────────┘
                             │  Tauri IPC  (desktop)
                             │  or in-browser FS APIs
┌────────────────────────────▼─────────────────────────────┐
│  src/main.rs  (binary)                                   │
│  scan_folder · generate_output · preview · save/copy     │
│  open_with (system / editor)                             │
└────────────────────────────┬─────────────────────────────┘
                             │
┌────────────────────────────▼─────────────────────────────┐
│  src/lib.rs  →  ptt core crate                           │
│  ├── walker   git ls-files / ignore crate + .pttignore   │
│  ├── output   XML · Markdown · JSON · plain              │
│  └── preview  safe path resolve + text load              │
└──────────────────────────────────────────────────────────┘
```

## Design goals

1. **Git fidelity** — prefer `git ls-files --exclude-standard`; fall back to the `ignore` crate.
2. **LLM-safe packing** — size limits, binary detection, correct escaping (XML CDATA / JSON).
3. **Testable core** — walker, output, and preview live in the library crate (unit tests, no GUI).
4. **Local-only** — no network packing service; user explicitly copies or saves output.
5. **Progressive enhancement** — browser mode for pack/preview; desktop for dialogs and open-with.

## Key types

| Type | Location | Role |
|------|----------|------|
| `DirEntryMeta` | `core::walker` | Relative path, dir flag, size |
| `WriteOptions` | `core::output` | Format, summary flag, max file size |
| `FileNode` / `PackOptions` | `main` | IPC DTOs for the frontend |
| `BrowserProject` | `ui/browserFs.ts` | In-memory scan result for web mode |

## Data flow (desktop pack)

1. User picks a directory (dialog or drag-and-drop).
2. `scan_folder` walks via Git or `ignore`, merges directory nodes, returns `FileNode[]`.
3. UI applies presets / manual selection → selected relative paths.
4. `generate_output` reads allowed files and writes the chosen format.
5. User copies to clipboard or saves via dialog.

## Extension points

- **`.pttignore`** — extra exclusions on top of Git ignore rules.
- **Output formats** — add a variant in `OutputFormat` + a writer in `output.rs`.
- **Selection presets** — frontend-only heuristics (source / docs / all clean).
- **Syntax languages** — extend `ui/src/syntax.ts` + highlight.js registration.

## Security notes

- Symlink escapes outside the project root are skipped in the ignore walk.
- Preview resolves paths under the project root only.
- Packed content may still include secrets if the user selects those files; encourage `.gitignore` / `.pttignore`.

## Related docs

- [Screenshots](screenshots/) — marketing and SVG mockups for README
- [Expert review](EXPERT_REVIEW.md) — publish readiness scorecard
