# Security Policy

## Supported versions

| Version | Supported |
|---------|-----------|
| 0.8.x   | Yes       |
| 0.7.x   | Yes       |
| 0.6.x   | Yes       |
| 0.5.x   | Yes       |
| < 0.5   | No        |

## What this app does with your data

ProjectToText runs **locally**. It reads files you select on disk to build packed text for LLMs. It does not upload project contents to a remote packing service as part of core functionality.

Packed output masks a fixed set of recognizable credential shapes (provider API tokens including GitHub, GitLab, Hugging Face and npm tokens, JWTs, PEM private key blocks, URL passwords, `Password=` pairs and `*_PASSWORD=` assignments). This is best-effort: other secret formats are not detected, so still treat packed output as sensitive, since it may include credentials or proprietary code if those files are selected and not ignored.

## Recommendations

- Keep secrets out of the repo (`.gitignore` / `.pttignore` / env files).
- Review selection presets before copying large packs.
- Prefer XML/Markdown packs over pasting unreviewed binary-adjacent dumps (binaries are already omitted).

## Threat model and residual filesystem risk

1. **Malicious project trees**:
   - All path resolution (`resolve_under_root`, `resolve_under_canonical_root`) rejects `..`, absolute paths, Unix symlinks, and Windows reparse points/junctions component by component, and verifies `canonicalize().starts_with(canonical_root)`.
   - File reads (`open_verified_regular_file`) open the final component with `O_NOFOLLOW` on Unix and `FILE_FLAG_OPEN_REPARSE_POINT` on Windows, then inspect `file.metadata()` (`fstat` on the open descriptor) and verify `(dev, ino)` equality on Unix so a final-component swap between `symlink_metadata` and `open` is rejected before any byte is read.
   - Default-app launch (`open_in_default_app`) blocks executable and script extensions (`.exe`, `.bat`, `.cmd`, `.ps1`, `.sh`, `.app`, `.dmg`, etc.), and `open_with_app` allows only an explicit allowlist of editors.
2. **Untrusted MCP callers (`ptt mcp`)**:
   - Every MCP tool validates its JSON-RPC 2.0 envelope and input schema, bounds request/response sizes (`4 MiB` stdin line cap, `8 MiB` response cap), and confines any `directory` or `path` argument to the server's canonical startup root.
3. **Concurrent local filesystem mutation (Residual Risk)**:
   - While final-component opens use `O_NOFOLLOW` + descriptor `(dev, ino)` verification and cached desktop artifacts verify `(mtime, len)` and ignore-rule freshness before Copy/Save, portable standard-library Rust does not use `openat2(..., RESOLVE_BENEATH / RESOLVE_NO_SYMLINKS)` across every intermediate directory component. A local attacker with concurrent write access to an ancestor directory during an active scan/pack could still race intermediate directory resolution. Do not treat `ptt` as a kernel-enforced container sandbox against a concurrent local process running as the same OS user.

## Supply chain

- **CI actions are pinned to commit SHAs** (with the version as a comment). Releases run only on version tags or manual dispatch; untrusted pull requests get `contents: read` and no secrets.
- **Rust dependencies:** `cargo audit` runs in CI and fails on any RustSec vulnerability. At this release, `rustls` is 0.23.46 (fixes RUSTSEC-2026-0346 to 0349, found in 0.23.45).
- **Triaged exceptions (informational warnings, no fixed upgrade available in our dependency tree):**
  - `RUSTSEC-2024-0370` (`proc-macro-error` unmaintained) and `RUSTSEC-2024-0429` (`glib` unsound iterator impl). Both come from the Linux GTK 3 stack that Tauri uses. They do not affect the macOS or Windows builds. Removing them requires a Tauri GTK-4 migration, which is not planned yet.
- **Release gate:** the release fails if any of the four platform installers, or its `.sig`, is missing from the release, or if `latest.json` lacks a platform entry.
- **Not yet in place:** license policy checks (`cargo-deny`), SBOM and build provenance attestations, and macOS notarization or Windows Authenticode signing. The release notes say that macOS builds are not notarized. Updater artifacts are signed with the Tauri minisign key.

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
