# Security Policy

## Supported versions

| Version | Supported |
|---------|-----------|
| 0.4.x   | Yes       |
| 0.5.x   | Yes       |
| < 0.4   | No        |

## What this app does with your data

ProjectToText runs **locally**. It reads files you select on disk to build packed text for LLMs. It does not upload project contents to a remote packing service as part of core functionality.

Packed output masks a fixed set of recognizable credential shapes (provider API tokens, PEM private key blocks, `Password=` pairs and `*_PASSWORD=` assignments). This is best-effort: other secret formats are not detected, so still treat packed output as sensitive, since it may include credentials or proprietary code if those files are selected and not ignored.

## Recommendations

- Keep secrets out of the repo (`.gitignore` / `.pttignore` / env files).
- Review selection presets before copying large packs.
- Prefer XML/Markdown packs over pasting unreviewed binary-adjacent dumps (binaries are already omitted).

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
