# Architecture

ProjectToText (`ptt`) is a **Tauri v2** desktop application, a headless CLI, and an MCP server, all sharing one Rust core crate. A browser fallback (Vite-only) reimplements scan, selection, and pack in TypeScript for environments without the native shell.

```
┌──────────────────────────────────────────────────────────┐
│  ui/  (React 19 + TypeScript + Vite)                     │
│  virtualized tree · presets · budget bar · prompt bar    │
│  preview · theme · browser pack path (File System API)   │
└────────────────────────────┬─────────────────────────────┘
                             │  Tauri IPC (desktop)
                             │  or in-browser FS APIs
┌────────────────────────────▼─────────────────────────────┐
│  src/main.rs  (desktop binary)                           │
│  scan_folder · generate_output · copy/save_packed_output │
│  resolve_related_files · preview · workspace watcher     │
├──────────────────────────────────────────────────────────┤
│  src/cli.rs   `ptt pack`  (headless, no webview)         │
│  src/mcp.rs   `ptt mcp`   (JSON-RPC 2.0 over stdio)      │
└────────────────────────────┬─────────────────────────────┘
                             │
┌────────────────────────────▼─────────────────────────────┐
│  src/lib.rs  →  ptt core crate (src/core/)               │
│  ├── walker     git ls-files / ignore crate + .pttignore │
│  ├── workspace  revisioned scan snapshot + ignore cache  │
│  ├── output     XML · Markdown · JSON · plain (rayon)    │
│  ├── secrets    best-effort credential masking           │
│  ├── tokenizer  tiktoken BPE counts + model profiles     │
│  ├── skeleton   tree-sitter AST skeletons                │
│  ├── deps       import / importer / test graph           │
│  ├── git        status, branch changes, diff             │
│  ├── text       strict UTF-8 / UTF-16 BOM decoding       │
│  └── preview    root-constrained path resolve + load     │
└──────────────────────────────────────────────────────────┘
```

## Modules

| Module | Responsibility |
| --- | --- |
| `core::walker` | Git-first discovery, `ignore` fallback, `.pttignore`, junk directories, default exclusions for lockfiles and `gen/schemas/`. `SelectionMatcher` checks each candidate's ancestors against a normalized set. |
| `core::workspace` | A revisioned `Arc<WorkspaceSnapshot>`. Ignore-rule freshness uses cached `(mtime, len)` metadata. Also holds the dependency graph. |
| `core::output` | Writers for the four formats. Reads, decodes, skeletonizes, redacts, and counts tokens per file in parallel. `architectural_tier` orders `<files>` content; `<directory_structure>` stays alphabetical. |
| `core::secrets` | Regex rules for provider tokens, PEM blocks, URL passwords, `Password=` pairs, and `.env` secrets. Placeholders are skipped. `redact_secrets_with_report` returns per-kind counts. |
| `core::tokenizer` | `tiktoken-rs` encodings (`o200k_base`, `cl100k_base`). Claude and Gemini profiles scale the `o200k_base` count by fixed factors. |
| `core::skeleton` | tree-sitter grammars for Rust, TypeScript/TSX, JavaScript, Python, Go, C#, Java, C, and C++; brace/indentation fallback for other text. |
| `core::deps` | One-hop import, importer, and test relationships used by the desktop context menu. |
| `core::git` | `git status --porcelain`, branch-changed files versus the base branch, and unified diff. Uses `git_command()`, which suppresses console windows on Windows. |
| `core::text` | Strict UTF-8 and BOM-declared UTF-16 decoding; Markdown fences longer than any backtick run. |
| `core::preview` | Canonical-root containment, symlink and reparse-point rejection, bounded text previews. |
| `core::budget` | `--max-tokens` fitting in two stages: `prefit_by_estimate` (heuristic skeleton upgrades and pre-drops), then `fit_to_bpe_budget_with_pins` (exact BPE fit on the full artifact). Pinned paths are never dropped. |
| `cli` | Argument parsing (`PackArgs`) and filters. `PackArgs::pinned_rel_paths()` is the only place `--pin` paths are normalized. `ptt pack` and `ptt_pack_files` both call into `core::budget`. |
| `mcp` | JSON-RPC 2.0 envelope only: protocol negotiation, the stdio loop, `tools/call` routing, cancellations, and the output cap. |
| `mcp::tools` | Tool schemas and argument validation (`tool_definitions`, `validate_tool_arguments`), the project-root sandbox (`resolve_root`), and dispatch for the five tools: `ptt_get_project_map`, `ptt_pack_files`, `ptt_get_git_context`, `ptt_get_related_files`, `ptt_search_symbols`. |
| `mcp::tests`, `mcp::fuzz_tests` | Protocol and tool unit tests. Seeded fuzzing and hostile-directory tests live apart in `fuzz_tests`. |
| `mcp::workers` | Runs each `tools/call` on a worker thread with a 30 s limit. At most four workers run at once, and timed-out workers keep their slot until they finish. |

## Data flow (desktop pack)

1. The user picks a directory (dialog, drag-and-drop, or `ptt [DIR]` at startup).
2. `scan_folder` walks the project through Git or the `ignore` crate, stores a single `Arc<WorkspaceSnapshot>` with its revision, and returns the tree to the UI.
3. The UI applies a preset or manual selection. The budget bar counts exact tokens per selected file. Auto-Fit deselects low-priority files until the selection is at most 90% of the budget.
4. `generate_output` validates the snapshot revision and indexed ignore files, filters through `SelectionMatcher`, re-validates paths, and runs the writer on `rayon`. The complete output is stored in Rust as a `PackedArtifact` behind an `Arc<String>`.
5. Only a **bounded preview** crosses IPC. `copy_packed_output` and `save_packed_output` read the full artifact from Rust memory, so multi-megabyte output is not serialized back to JavaScript.
6. A `notify` watcher emits `workspace-changed` so the UI can prompt for Refresh. Refresh rebuilds membership; generation rereads indexed file contents and rejects stale revisions.

## Other entry points

- **CLI** (`ptt pack`) uses the same `walk`, filters (`--preset`, `--include`, `--exclude`, `--skeleton`, Git flags), auto-fit (`--max-tokens`), and `write_output` path. It writes through a buffered writer and refuses to overwrite an input file.
- **MCP** (`ptt mcp [DIR]`) answers JSON-RPC 2.0 requests on stdio. A tool call may name a directory; results go through the same ignore and redaction rules as `ptt pack`.

## Desktop UI hooks

`ui/src/App.tsx` is a thin shell around `useWorkspace()` in `ui/src/useWorkspace.tsx`. That hook composes two focused hooks by area:

- `ui/src/useThemeAndLayout.ts`: theme preference and persistence, sidebar resize, and virtualized tree scroll and viewport state.
- `ui/src/useFilePreviewAndMenu.ts`: in-app file preview, native editor launchers, the tree context menu, and 1-hop dependency selection.

`useWorkspace.tsx` keeps folder scanning, selection, budget auto-fit, packing, and project history and preferences. The views are `AppChrome.tsx` (header, toolbar, status bar), `BudgetAndPromptBar.tsx`, `MainPanel.tsx`, and `Panels.tsx` (tree rows, dialogs, toasts). `treeModel.ts` holds the pure tree and preset helpers.

On the Rust side, `WorkspaceIndex::refresh_paths` updates the current snapshot in place when watcher events only modify indexed files. It falls back to a full `scan` when files are created or removed, or when ignore files change.

## Browser mode

`ui/src/browserFs.ts` reimplements scan and pack in TypeScript. It emits `<files>` in the same architectural tier order, keeps `<directory_structure>` alphabetical, and caps the pack at 400 files **after** tier ordering so the cap drops docs before source. Secret rules live in `ui/src/secrets.ts`, which mirrors `src/core/secrets.rs`. Browser mode does not run Git and does not implement `.gitignore` or `.pttignore`.

## Security notes

- Symlinks and reparse points are rejected. Relative paths are validated component by component, and canonical containment is checked before each read.
- Preview and pack resolve paths under the project root only. These checks are not a race-proof sandbox against concurrent filesystem changes.
- Secret masking is best-effort. Selected files that contain credentials in an unrecognized shape are not masked.
- Tauri commands are not a sandbox against a compromised frontend.

## Extension points

- **`.pttignore`** adds exclusions on top of Git ignore rules.
- **Output formats**: add a variant to `OutputFormat` and a writer in `output.rs`, then mirror it in `browserFs.ts`.
- **Presets and default exclusions**: `applyPreset` in `ui/src/treeModel.ts` and `matches_preset` in `src/cli.rs` share the same rules.
- **Secret rules**: change `src/core/secrets.rs` and `ui/src/secrets.ts` together and add matching cases to both test suites.
- **Skeleton languages**: add a grammar and a case in `core::skeleton::language_for_path`.

## Related docs

- [Screenshots](screenshots/): README assets
- [Engineering review](EXPERT_REVIEW.md): measurements and known limits
