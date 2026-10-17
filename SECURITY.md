# Security Policy

## Supported versions

| Version | Supported |
|---------|-----------|
| 0.9.x   | Yes       |
| 0.8.x   | Yes       |
| 0.7.x   | Yes       |
| 0.6.x   | Yes       |
| 0.5.x   | Yes       |
| < 0.5   | No        |

## What this app does with your data

ProjectToText runs **locally**. It reads files you select on disk to build packed text for LLMs. It does not upload project contents to a remote packing service as part of core functionality.

Packed output masks a fixed set of recognizable credential shapes across 21 rules (provider API tokens including AWS, Anthropic, OpenAI, Google, Stripe, GitHub, GitLab, Slack, Hugging Face, npm, Azure Storage, SendGrid and Discord tokens, JWTs, PEM private key blocks, URL passwords, `Password=` pairs, `*_PASSWORD=` assignments, `.env`-style `*_SECRET`/`*_TOKEN`/`*_API_KEY`/`*_PRIVATE_KEY` assignments, and high-entropy credential assignments with Shannon entropy $H > 4.5$ bits/char for literals $\ge 32$ chars). This is best-effort: other secret formats are not detected, so still treat packed output as sensitive, since it may include credentials or proprietary code if those files are selected and not ignored.

## Recommendations

- Keep secrets out of the repo (`.gitignore` / `.pttignore` / env files).
- Review selection presets before copying large packs.
- Prefer XML/Markdown packs over pasting unreviewed binary-adjacent dumps (binaries are already omitted).

## Threat model and residual filesystem risk

Detailed security invariants, boundary classifications, and threat analysis are documented in [docs/SECURITY_CONTRACT.md](docs/SECURITY_CONTRACT.md).

1. **Untrusted codebase content and prompt injection**:
   - All source code, comments, documentation, issue texts, and commit messages are treated as **untrusted data**, never as executable instructions for the assistant or host.
   - Output serializes file contents using safe structural boundaries:
     - **XML**: `<task_instructions>` and file contents are enclosed in `<![CDATA[...]]>` with automatic splitting of nested `]]>` terminators (`]]]]><![CDATA[>`); attributes use strict XML entity escaping (`&`, `<`, `>`, `"`, `'`).
     - **Markdown**: file blocks use dynamic backtick fence lengths strictly exceeding the longest backtick or tilde run inside the file content.
     - **JSON**: standard JSON string escaping prevents control-character or delimiter breakout.
   - Masking of secrets does not substitute for `.gitignore`, `.pttignore`, or user selection review.
2. **Malicious project trees**:
   - All path resolution (`resolve_under_root`, `resolve_under_canonical_root`) rejects `..`, absolute paths, Unix symlinks, and Windows reparse points/junctions component by component, and verifies `canonicalize().starts_with(canonical_root)`.
   - File reads (`open_verified_regular_file`) open the final component with `O_NOFOLLOW` on Unix and `FILE_FLAG_OPEN_REPARSE_POINT` on Windows, then inspect `file.metadata()` (`fstat` on the open descriptor) and verify `(dev, ino)` equality on Unix so a final-component swap between `symlink_metadata` and `open` is rejected before any byte is read.
   - Default-app launch (`open_in_default_app`) blocks executable and script extensions (`.exe`, `.bat`, `.cmd`, `.ps1`, `.sh`, `.app`, `.dmg`, etc.), and `open_with_app` allows only an explicit allowlist of editors.
3. **Untrusted MCP callers (`ptt mcp`)**:
   - Every MCP tool validates its JSON-RPC 2.0 envelope and input schema, bounds request/response sizes (`4 MiB` stdin line cap, `8 MiB` response cap), enforces a 30-second timeout with cooperative cancellation (`AtomicBool`), and confines any `directory` or `path` argument to the server's canonical startup root.
4. **Concurrent local filesystem mutation (Residual Risk)**:
   - While final-component opens use `O_NOFOLLOW` + descriptor `(dev, ino)` verification and cached desktop artifacts verify `(mtime, len)` and ignore-rule freshness before Copy/Save, portable standard-library Rust does not use `openat2(..., RESOLVE_BENEATH / RESOLVE_NO_SYMLINKS)` across every intermediate directory component. A local attacker with concurrent write access to an ancestor directory during an active scan/pack could still race intermediate directory resolution. Do not treat `ptt` as a kernel-enforced container sandbox against a concurrent local process running as the same OS user.

## Supply chain

- **CI actions are pinned to commit SHAs** (with the version as a comment). Releases run only on version tags or manual dispatch; untrusted pull requests get `contents: read` and no secrets.
- **Rust dependencies:** `cargo audit` runs in CI and fails on any RustSec vulnerability. At this release, `rustls` is 0.23.46 (fixes RUSTSEC-2026-0346 to 0349, found in 0.23.45).
- **Triaged exceptions (informational warnings, no fixed upgrade available in our dependency tree):**
  - `RUSTSEC-2024-0370` (`proc-macro-error` unmaintained) and `RUSTSEC-2024-0429` (`glib` unsound iterator impl). Both come from the Linux GTK 3 stack that Tauri uses. They do not affect the macOS or Windows builds. Removing them requires a Tauri GTK-4 migration, which is not planned yet.
- **License and dependency policy:** `deny.toml` configures `cargo-deny` to enforce open-source license allowlists, ban wildcard dependencies, and audit RustSec advisories in CI.
- **Release gate & SBOM:** the release fails if any of the four platform installers, or its `.sig`, is missing from the release, or if `latest.json` lacks a platform entry. Release builds also attach a CycloneDX SBOM (`ptt-sbom.cdx.json`) generated from `Cargo.lock`.
- **Not yet in place:** macOS notarization (Apple Developer ID certificate) or Windows Authenticode signing. The release notes say that macOS builds are not notarized. Updater artifacts are signed with the Tauri minisign key.

## Reporting a vulnerability

Please report security issues **privately**:

1. Email the maintainer via GitHub: [krzysztofautomatyk](https://github.com/krzysztofautomatyk) (use the contact method listed on the profile), **or**
2. Open a [GitHub Security Advisory](https://github.com/krzysztofautomatyk/ProjectToText/security/advisories/new) if available on the repository.

Include:

- Description and impact
- Reproduction steps / proof of concept
- Affected commit or release

You should receive an acknowledgement within **7 days**. Please allow reasonable time for a fix before public disclosure.

## Scope examples

In scope:

- Path traversal / reading files outside the chosen project root
- Command injection via project paths or filenames
- Broken ignore rules that force-include sensitive ignored files incorrectly
- Unsafe deserialization or clipboard/file write issues

Out of scope:

- Issues solely in third-party dependencies with no realistic exploit path in ptt
- Social engineering users into selecting and pasting secrets into an LLM
