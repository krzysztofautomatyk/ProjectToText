# ProjectToText: Security Contract, Threat Model & Invariants

**Version:** 1.0  
**Baseline Release:** ProjectToText 0.8.1  
**Auditors & Roles:** Staff Rust Engineer, AppSec / Privacy Reviewer, OT Safety Engineer, Red Team Skeptic  
**Date:** 2026-10-17  
**Status:** Verified technical contract with automated regression test evidence.

---

## 1. Core Threat Model and Boundaries

ProjectToText operates as a local context workbench. Its primary job is reading files from a local filesystem, transforming them (token estimation, AST skeletons, secret redaction, git diffs), and packaging them into LLM-ready context artifacts.

### Trust Zones

```
+-------------------------------------------------------------------------+
| UNTRUSTED EXTERNAL ZONE                                                 |
| - Target repository files, comments, markdown, documentation            |
| - Git commit logs, issue references, diff contents                      |
| - External project directories, symlinks, junctions                     |
| - MCP client inputs and arbitrary prompt texts                          |
+-------------------------------------------------------------------------+
                                    |
                                    v (Strict Validation & Sanitization Boundary)
+-------------------------------------------------------------------------+
| TRUSTED EXECUTION ENGINE (ProjectToText Core)                           |
| - Path Containment: `resolve_under_canonical_root`                      |
| - Atomic Handle Open: `open_verified_regular_file` (O_NOFOLLOW)         |
| - Structural Framing: CDATA, Dynamic Backtick Fences, JSON Escaping     |
| - Redaction Engine: 21 Rules + Shannon Entropy (H > 4.5)                |
| - Resource Limiters: 4 MiB stdin, 8 MiB response, 30s worker timeout    |
+-------------------------------------------------------------------------+
                                    |
                                    v (Output Artifact)
+-------------------------------------------------------------------------+
| LLM INGESTION / AGENT CONSUMPTION ZONE                                  |
| - Deterministic XML / Markdown / JSON / Plain Text                      |
| - Pure Data Context (Zero Executable Hooks)                             |
+-------------------------------------------------------------------------+
```

---

## 2. Invariant 1: Files as Untrusted Data (Prompt Injection Resistance)

### Policy
All contents read from the local repository—including code, comments, config files, documentation, and commit messages—are treated strictly as **untrusted data**, never as instructions for the LLM or host agent.

### Structural Framing Mechanisms

1. **XML Format:**
   - File contents and `<task_instructions>` are enclosed in XML `<![CDATA[...]]>` blocks.
   - Any literal `]]>` sequence occurring inside user code is dynamically split into `]]]]><![CDATA[>`, preventing XML CDATA escape vulnerabilities.
   - All XML attribute values (`name`, `path`, `size`, `tokens`, `mode`) undergo strict entity escaping (`&` $\to$ `&amp;`, `<` $\to$ `&lt;`, `>` $\to$ `&gt;`, `"` $\to$ `&quot;`, `'` $\to$ `&apos;`).
2. **Markdown Format:**
   - Code blocks use dynamic backtick fences whose length strictly exceeds the longest sequence of consecutive backticks or tildes found within the file content (`max(3, longest_run + 1)`).
3. **JSON Format:**
   - Full standard JSON string escaping ensures control characters (ASCII 0x00–0x1F), quotes (`"`), and backslashes (`\`) cannot break the envelope.
4. **Plain Text:**
   - Unambiguous line headers and path separators delineate files without interpreting escape sequences.

### Test Evidence
- `tests/phase1_regressions.rs`: `task_instructions_are_cdata_wrapped_so_markup_characters_stay_well_formed`
- `tests/phase1_regressions.rs`: `markdown_fence_is_longer_than_every_content_run`
- `tests/phase1_regressions.rs`: `security_contract_untrusted_file_prompt_injection_is_strictly_framed_in_all_formats`

---

## 3. Invariant 2: Path Confinement, Symlink/Reparse Point Rejection & TOCTOU Mitigations

### Policy
ProjectToText must never read or disclose any file residing outside the user-selected project root, regardless of path traversal attempts, absolute paths, or symlink chains.

### Mitigations

1. **Path Resolution (`resolve_under_canonical_root` in `src/core/preview.rs`):**
   - Rejects empty paths and `.` as relative arguments.
   - Rejects absolute paths (`/etc/passwd`, `C:\Windows\System32`).
   - Rejects parent component traversal (`..`).
   - Inspects `std::fs::symlink_metadata` for every intermediate path component; rejects immediately if `is_link()` is true (Unix symlink or Windows reparse point/junction).
   - Validates that the fully canonicalized path begins with the canonical project root (`starts_with`).
2. **Atomic Final-Component File Open (`open_verified_regular_file`):**
   - Opens the file with operating system flags that instruct the kernel **not** to follow symlinks:
     - Unix (Darwin/BSD/Linux): `O_NOFOLLOW` (Darwin `0x0100`, Linux x86_64 `0o400000`, Linux aarch64 `0o100000`).
     - Windows: `FILE_FLAG_OPEN_REPARSE_POINT` (`0x0020_0000`).
   - Calls `file.metadata()` (`fstat` directly on the open file descriptor) and verifies that `is_file()` is true and `is_link()` is false.
   - On Unix, verifies that `(dev, ino)` of the open file descriptor matches the `(dev, ino)` retrieved during `symlink_metadata` before open. If a concurrent attacker swapped the regular file for a symlink in the window between check and open, the open fails closed with `PermissionDenied`.

### Residual Risk Statement
While final-component opens and single-path lookups are race-safe, standard library Rust on portable OS platforms does not provide recursive `openat2(RESOLVE_BENEATH)` across arbitrary deep directories. A local adversary with write access to an intermediate ancestor directory could theoretically race intermediate directory resolution. Therefore, ProjectToText does not claim kernel container isolation against concurrent local processes running as the same user.

### Test Evidence
- `src/core/preview.rs`: `tests::sandbox_rejects_symlinked_directory_components_and_escapes_before_open`
- `src/core/preview.rs`: `tests::open_verified_regular_file_rejects_final_symlink_via_nofollow_and_load_preview_fails_closed`
- `src/core/preview.rs`: `tests::concurrent_swap_between_regular_file_and_symlink_never_yields_outside_content`
- `tests/phase1_regressions.rs`: `pack_rejects_parent_escape`
- `tests/phase1_regressions.rs`: `pack_rejects_intermediate_symlink`
- `tests/phase1_regressions.rs`: `security_contract_path_traversal_and_escapes_fail_closed`

---

## 4. Invariant 3: Best-Effort Secret Redaction and Shannon Entropy

### Policy
ProjectToText scans file contents, git diffs, and task prompts for credentials using high-performance regex matching and Shannon entropy gating.

### Redaction Rules (21 Rules)
1. `AWS_ACCESS_KEY` (`AKIA[0-9A-Z]{16}`)
2. `ANTHROPIC_API_KEY` (`sk-ant-api03-[A-Za-z0-9_-]{20,}`)
3. `OPENAI_API_KEY` (`sk-[A-Za-z0-9_-]{20,}`)
4. `GOOGLE_API_KEY` (`AIza[0-9A-Za-z_-]{35}`)
5. `STRIPE_KEY` (`(sk_live_|pk_live_|rk_live_)[0-9a-zA-Z]{24,}`)
6. `GITHUB_TOKEN` (`(ghp_|gho_|ghu_|ghs_|ghr_|github_pat_)[0-9a-zA-Z_]{36,}`)
7. `SLACK_TOKEN` (`xox[baprs]-[0-9]{10,13}-[0-9]{10,13}[a-zA-Z0-9-]*`)
8. `GITLAB_TOKEN` (`glpat-[0-9a-zA-Z_-]{20,}`)
9. `HUGGINGFACE_TOKEN` (`hf_[0-9a-zA-Z]{34,}`)
10. `NPM_TOKEN` (`npm_[0-9a-zA-Z]{36,}`)
11. `AZURE_KEY` (`AccountKey=[A-Za-z0-9+/=]{40,}`)
12. `SENDGRID_KEY` (`SG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}`)
13. `DISCORD_TOKEN` (Bot / webhook token pattern)
14. `JWT_TOKEN` (Three base64 segments `eyJ...`)
15. `PRIVATE_KEY` (`-----BEGIN [A-Z ]*PRIVATE KEY-----`)
16. `URL_PASSWORD` (`scheme://user:password@host`)
17. `PASSWORD` (`Password=...` assignments)
18. `PASSWORD` (`*_PASSWORD=...` assignments)
19. `ENV_SECRET` (`*_SECRET=...` assignments)
20. `ENV_SECRET` (`*_TOKEN=...`, `*_API_KEY=...`, `*_PRIVATE_KEY=...` assignments)
21. `HIGH_ENTROPY_SECRET` (Generic secret assignments where captured value has length $\ge 32$ chars and Shannon entropy $H > 4.5$ bits/char)

### Shannon Entropy Metric
Entropy is computed as:
$$H(S) = -\sum_{i=1}^{k} p_i \log_2(p_i)$$
where $p_i$ is the frequency of character $c_i$ in string $S$.
- Threshold: $H > 4.5$ bits/char.
- Minimum length: 32 characters.
- Placeholder avoidance: common documentation patterns (`...`, `dummy`, `example`, `changeme`, `your_key_here`) are excluded.

### Explicit Security Boundary
Secret redaction is **best-effort heuristic scanning**. It is not a cryptographic data-loss prevention (DLP) system. Non-standard key shapes, encrypted blobs, or novel formats may not trigger detection. Secret redaction does not replace `.gitignore`, `.pttignore`, or deliberate selection by the user.

### Test Evidence
- `tests/phase1_regressions.rs`: `secret_scanner_fp_fn_corpus_evaluation` (21/21 true positives, 0/20 false positives).
- `tests/phase1_regressions.rs`: `packing_own_repository_never_triggers_self_redaction_in_source_or_docs`.
- `tests/phase1_regressions.rs`: `security_contract_high_entropy_secret_threshold_verification`.

---

## 5. Invariant 4: Resource Bounds & Denial-of-Service Defense

### Policy
The engine enforces hard limits to prevent memory exhaustion, CPU starvation, and process hangs.

| Resource Surface | Hard Limit | Enforcement Point |
|---|---|---|
| **MCP Stdin Line** | 4 MiB (4,194,304 bytes) | `src/mcp.rs`: line reading loop with drain-and-discard |
| **MCP Tool Output** | 8 MiB (8,388,608 bytes) | `src/mcp.rs`: output size guard returning `-32603` on overflow |
| **MCP Worker Pool** | Max 16 concurrent workers | `src/mcp/workers.rs`: semaphore slots |
| **MCP Execution Timeout** | 30 seconds per request | `src/mcp/workers.rs`: worker timeout thread |
| **MCP Cancellation Queue** | Max 1024 pending IDs | `src/mcp.rs`: bounded HashSet preventing untrusted memory bloat |
| **Map Skeletons Max Files** | Max 15 key files | `src/mcp/tools.rs`: tier-ranked selection |
| **Map Skeletons Max Size** | Max 128 KiB per file | `src/mcp/tools.rs`: file size filter before AST read |
| **Symbol Search Max Size** | Max 512 KiB per file | `src/mcp/tools.rs`: skips oversized source files |
| **Symbol Search Max Results** | Max 100 matches | `src/mcp/tools.rs`: truncates match collection |
| **File Preview Max Size** | 512 KiB | `src/core/preview.rs`: `DEFAULT_PREVIEW_MAX` |
| **Default Pack Max File Size**| 10 MiB | `src/core/output.rs`: `DEFAULT_MAX_FILE_SIZE` |

---

## 6. Invariant 5: Local-First Privacy & Zero Telemetry

1. **Zero Outbound Telemetry:**
   ProjectToText contains zero tracking pixels, telemetry events, usage metrics, or crash-reporting network calls.
2. **Zero Remote Model Invocations:**
   Token counting is performed locally via compiled Rust BPE tables (`tiktoken-rs`). AST parsing is executed locally via tree-sitter C parsers.
3. **No External Network Storage:**
   All presets, workspace snapshots, cache entries, and settings remain on the local machine.
