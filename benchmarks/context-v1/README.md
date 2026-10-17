# Phase 0 context-quality baseline — executed pilot

**Run date:** 2026-10-16 (CEST); verification rerun 2026-10-17. **Status:** local pilot executed; Phase 0 acceptance incomplete, no market/product winner claim. No remote model call was made; no hosted-model API received repository code. Repomix was invoked on local paths only; one repeat was performed on the isolated reconstructed checkout, also without a remote URL. Competitor output is not assumed equivalent without matching behavior.

## Frozen snapshot and environment

The shared worktree had many pre-existing tracked edits. To avoid altering or misattributing them, the benchmark ran in a separate clean temp checkout. Base HEAD: `fff6120ab82c533374a1869677edd59f4c834f2b`; tracked-worktree patch SHA-256: `9e5a880fba9240c6672830c86ba588234c663a3ea2570785eb4bafd6463c911b` (227,867 bytes); reconstructed frozen input tree: `46bd9734d03df2d13d1bc1a5569cda34127a2bf4`. A temporary commit around this tree had ID `6501fdb4161faafd287226a346c559057e134abd` during the run, but the repository object is no longer retained in that scratch directory; use the documented tree ID to verify reconstructed content. The untracked `deny.toml` and strategy brief were excluded from the input. Machine-readable environment and unavailable-tool reasons are recorded in [tools.lock.json](tools.lock.json); per-condition descriptive counts and guard outcomes are in [results.jsonl](results.jsonl). The patch contains unrelated local changes and is not included in the delivered report.

To reconstruct exactly: create an archive from the base, apply the tracked-worktree patch from a secure local copy, then verify the resulting tree ID and clean status before building. **The patch itself is intentionally not delivered** because it contains unrelated private/local work; the `git apply` path below is a placeholder. Thus the snapshot can only be reconstructed by someone who still has the matching patch bytes (SHA-256 and size above). The benchmark directory alone is not a complete, portable reproduction bundle.

```sh
mkdir -p /tmp/ptt-phase0-snapshot
git archive fff6120ab82c533374a1869677edd59f4c834f2b | tar -x -C /tmp/ptt-phase0-snapshot
cd /tmp/ptt-phase0-snapshot
git init -q
git -c core.autocrlf=false apply /path/to/tracked-worktree.patch
git add -A
test "$(git write-tree)" = 46bd9734d03df2d13d1bc1a5569cda34127a2bf4
git -c user.name='Phase 0 Benchmark' -c user.email=phase0@invalid commit -qm 'Phase 0 frozen tracked working tree'
test -z "$(git status --porcelain)"
```

- macOS 27.0.0 on the original run (the resumed environment reported 27.0.1), Apple M4 Pro (arm64), 14 logical processors.
- `rustc 1.97.1 (8bab26f4f 2026-07-14)`, Cargo 1.97.1 (`c980f4866 2026-06-30`), ProjectToText `ptt 0.8.1`, `tiktoken-rs 0.11.0` (from `Cargo.lock`), release build.
- Repomix `1.18.1`, invoked by pinned `npx --yes repomix@1.18.1`.
- Aider could not run: installed launcher points to a missing Python; `aider-chat==0.86.2` requires Python >=3.10,<3.13 while system Python is 3.9.6; a Python 3.13.11 attempt failed importing `audioop`/`pyaudioop`. Ollama 0.30.11 had no installed models. No remote model was downloaded or called.

## Reproduction

From the exact clean frozen input tree:

```sh
CARGO_TARGET_DIR=/tmp/ptt-phase0-target cargo build --release --locked --bin ptt --example selection_benchmark
/tmp/ptt-phase0-target/release/examples/selection_benchmark

/tmp/ptt-phase0-target/release/ptt pack . --preset source --max-tokens 8000 --tokenizer o200k_base -o /tmp/source-8k.xml
/tmp/ptt-phase0-target/release/ptt pack . --preset source --max-tokens 32000 --tokenizer o200k_base -o /tmp/source-32k.xml
/tmp/ptt-phase0-target/release/ptt pack . --max-tokens 8000 --tokenizer o200k_base -o /tmp/all-8k.xml
/tmp/ptt-phase0-target/release/ptt pack . --max-tokens 32000 --tokenizer o200k_base -o /tmp/all-32k.xml

# Fixed PTT task packs (brace glob = the exact three curated paths).
/tmp/ptt-phase0-target/release/ptt pack . --include '{src/mcp/tools.rs,src/core/preview.rs,src/mcp/tests.rs}' \
  --max-tokens 32000 --tokenizer o200k_base -o /tmp/path-safety-32k.xml
/tmp/ptt-phase0-target/release/ptt pack . --include '{src/core/budget.rs,src/core/output.rs,src/cli.rs}' \
  --max-tokens 32000 --tokenizer o200k_base -o /tmp/budget-regression-32k.xml
/tmp/ptt-phase0-target/release/ptt pack . --include '{ui/src/browserFs.ts,src/core/walker.rs,ui/e2e/smoke.spec.ts}' \
  --max-tokens 32000 --tokenizer o200k_base -o /tmp/ignore-parity-32k.xml
```

The task prompts, proposed fixture candidate paths, tree ID, and explicit span-label limitations are machine-readable in [tasks.jsonl](tasks.jsonl). Each task fixture specifies three focused files: (1) path safety: `src/mcp/tools.rs`, `src/core/preview.rs`, `src/mcp/tests.rs`; (2) budget: `src/core/budget.rs`, `src/core/output.rs`, `src/cli.rs`; (3) browser/native ignore parity: `ui/src/browserFs.ts`, `src/core/walker.rs`, `ui/e2e/smoke.spec.ts`. The list is a human-curated fixed context, not an independently reviewed exhaustive gold set; therefore file-level precision/recall/F1 are not measured. **Phase 0 acceptance is partial, not complete:** the results ledger records observed counts/exit statuses and literal preset/fixture path intersections, but independent gold adjudication, comparative per-task relevance scores, common-tokenizer normalization of Repomix output, and Aider map comparison remain unavailable. PTT runs pinned all three requested files. The captured 32k artifacts each contain exactly the three files requested by the respective fixture. The current CLI replay confirms this; see the one-token metadata difference above. Fixed-pack comparisons here assess the same curated inputs; they do not test relevance ranking or recall. At 8k each correctly returned exit 1 because the pinned artifact exceeded the budget. Captured diagnostics: path safety 15,065 total tokens (14,778 content + 287 wrapper); budget 27,275 (26,955 + 320); ignore parity 17,366 (17,043 + 323). Replay against the documented reconstructed tree returned 15,066 (14,778 + 288), 27,276 (26,955 + 321), and 17,367 (17,043 + 324), respectively. This one-token difference is the workspace-name metadata changing; token content and requested file set matched. These outputs are fixed task contexts, not retrieval rankings or gold-labeled retrieval results.

### Exact Repomix rerun commands

Run these at the frozen snapshot root. Repomix writes plain text despite `--style xml`; its console token count includes different wrapper accounting. Each fixed input is the same three-file fixture as the PTT pack. The 8k `--token-budget` commands return exit 1 because the option guards rather than fitting; 32k returns 0. Capture each command's status separately when scripting the expected nonzero cases.

```sh
npx --yes repomix@1.18.1 --style xml --token-count-encoding o200k_base --include 'src/mcp/tools.rs,src/core/preview.rs,src/mcp/tests.rs' . -o /tmp/repomix-path-safety.txt
npx --yes repomix@1.18.1 --style xml --token-count-encoding o200k_base --token-budget 8000 --include 'src/mcp/tools.rs,src/core/preview.rs,src/mcp/tests.rs' . -o /tmp/repomix-path-safety-8k.txt
npx --yes repomix@1.18.1 --style xml --token-count-encoding o200k_base --token-budget 32000 --include 'src/mcp/tools.rs,src/core/preview.rs,src/mcp/tests.rs' . -o /tmp/repomix-path-safety-32k.txt
npx --yes repomix@1.18.1 --style xml --token-count-encoding o200k_base --include 'src/core/budget.rs,src/core/output.rs,src/cli.rs' . -o /tmp/repomix-budget.txt
npx --yes repomix@1.18.1 --style xml --token-count-encoding o200k_base --token-budget 8000 --include 'src/core/budget.rs,src/core/output.rs,src/cli.rs' . -o /tmp/repomix-budget-8k.txt
npx --yes repomix@1.18.1 --style xml --token-count-encoding o200k_base --token-budget 32000 --include 'src/core/budget.rs,src/core/output.rs,src/cli.rs' . -o /tmp/repomix-budget-32k.txt
npx --yes repomix@1.18.1 --style xml --token-count-encoding o200k_base --include 'ui/src/browserFs.ts,src/core/walker.rs,ui/e2e/smoke.spec.ts' . -o /tmp/repomix-ignore.txt
npx --yes repomix@1.18.1 --style xml --token-count-encoding o200k_base --token-budget 8000 --include 'ui/src/browserFs.ts,src/core/walker.rs,ui/e2e/smoke.spec.ts' . -o /tmp/repomix-ignore-8k.txt
npx --yes repomix@1.18.1 --style xml --token-count-encoding o200k_base --token-budget 32000 --include 'ui/src/browserFs.ts,src/core/walker.rs,ui/e2e/smoke.spec.ts' . -o /tmp/repomix-ignore-32k.txt
```

## Results actually observed

The existing `selection_benchmark` generated all artificial corpora in temporary directories, leaving no fixture files in the repository, and also measured source files in the frozen tree. The graph fixture builds synthetic auth/sandbox/engine modules, three importers, three isolated files, one test and one guide; its three labels are security review, architecture review, and auth-flow bug fix, with 3,200/3,400-token budgets. The printed results are averages, not per-task judgments. On this M4 Pro, the original run produced:

- Selection: 10,000 paths / 8,000 selections, legacy predicate 5,393.152 ms vs matcher including construction 0.972 ms; 3 repetitions.
- Non-Git scan of synthetic 1,000 files: 26.260 ms; cached revision/rule validation plus 800 selections: median 0.130 ms, p95 0.143 ms over 5 repetitions.
- Pack 800 synthetic files: one-thread median 25.123 ms; Rayon (14 threads) 19.014 ms. Uneven 800-file fixture: one-thread 152.579 ms, chunked-64 simulation 123.340 ms, single-pass Rayon 111.237 ms.
- Repository-source corpus: 51 source files, 732,042 bytes, 175,470 exact `o200k_base` tokens; tokenizer median 30.130 ms. AST skeleton text: 41,585 tokens (76.3% smaller); extraction median 39.520 ms.
- Harness synthetic “context quality” fixture: 3 hand-authored tasks; graph-aware required-file recall 83.3% vs 33.3% without graph; noise ratio 16.7% vs 50.0%. These labels and algorithm are both from the same harness. This is a tiny synthetic sanity check, not independent evidence of user/task quality.

Captured PTT CLI run results (original temporary-root name `ptt-phase0-final`):

| Condition | Budget | Files | Reported exact tokens |
|---|---:|---:|---:|
| `--preset source` | 8k | 8 | 7,743 |
| `--preset source` | 32k | 20 | 28,423 |
| unqualified clean pack | 8k | 8 | 7,743 |
| unqualified clean pack | 32k | 21 | 30,281 |

Replay from the frozen content tree under root name `ptt-phase0-reconstruct` selected the same ordered paths and produced 7,744 / 28,424 / 7,744 / 30,282 tokens (one more from root-name metadata); all four parsed XML inventories match the captured ordered paths.

Re-running the harness reproduced all correctness-sensitive figures (file/byte/token counts, 76.3% skeleton reduction, and synthetic recall/noise) but wall-clock times varied, as expected; both captured runs are preserved in [harness-results.txt](harness-results.txt). On the replay run, exact correctness metrics reproduced: 51 files, 732,042 bytes, 175,470 source tokens; 41,585 skeleton tokens; and graph/naive fixture values of 83.3%/33.3% required recall and 16.7%/50.0% noise ratio. Wall-clock numbers are single-run samples per command, not stable comparisons. The harness itself checks output equivalence/determinism and asserts the graph condition does not regress recall on its fixture. It does not emit per-task metrics or a code-span gold set.

## Competitor execution and comparability

Repomix was run locally at `1.18.1` on each of the three pinned inputs. It reported 15,232 / 27,401 / 17,513 tokens for path safety / budget / ignore parity; PTT captured 15,065 / 27,275 / 17,366. Both requested `o200k_base`, but wrappers/count scopes differ. These are displayed counts only; saved Repomix output was not re-tokenized with one common implementation. The generated files were plain text rather than parseable XML despite `--style xml`. Repomix’s `--token-budget` is a fail-if-over-limit check, not an automatic fitter: all three 8k guards exited 1 and all three 32k guards exited 0, with counts unchanged. The earlier captured Repomix full-source observation was 44 files / 163,073 tokens versus PTT’s 20-file source-preset result; the resumed replay on the reconstructed snapshot reported 100 files / 340,985 tokens. This drift demonstrates that Repomix’s default file selection/configuration or runtime environment was not fully frozen; the full-source figures are not reproducible under the current invocation and should not be compared. Included files, ignore/config behavior, wrappers, and guard-versus-fitting behavior differ. These are descriptive observations, not a win/loss.

Aider map is unverified in this environment (Python/runtime dependency blockers and no local model). Code2Prompt, Gitingest and RepoPrompt CE were not executed; they remain documented product-scope references only. No comparative precision, recall, F1, code-span, latency, task success or security claim is made for these products.

## Interpretation, omissions, and decision

- The CLI selected deterministic 8k/32k source/all packs. On replay against the reconstructed tree, the three pinned task fixtures at 32k had 15,066 / 27,276 / 17,367 tokens; each failed closed at 8k (exit 1). The captured task-pack XMLs include exactly the three fixture paths. A prior manifest inventory incorrectly counted nested `<file>` examples embedded in the budget test code as top-level artifacts; this has been corrected to the parsed direct children. `results.jsonl` also reports literal file overlap against the proposed fixture lists, explicitly labeled as unadjudicated overlap rather than recall.
- The built-in graph-aware selection experiment has a positive synthetic signal, but not independent labels, representative tasks, or users. It cannot establish a market differentiator.
- The three real-worktree task prompts were only packed as manually pinned reference contexts, not independently reviewed gold labels across every tool condition; comparative file-level precision/recall/F1 are therefore **not available**. No LLM completion or remote task outcome was measured. The `tasks.jsonl` entries are fixtures and explicit proposed relevant paths, not completed annotations.
- The stale comment above the harness says five task categories and 1,800 tokens; implementation actually runs three tasks at 3,200/3,400 tokens. This report follows the executed implementation.
- Timing is a single-host local measurement; no CPU isolation, controlled cold/warm protocol, cross-platform replication or confidence interval. Do not treat the microbenchmark ratios as product speed claims.
- **Feature decision remains open.** The data does not show that a CLI Context Profile is the best first feature. Owner should approve that slice only after user interviews or a second benchmark with independent reviewed labels and genuinely comparable budget-fitting conditions.

Only the benchmark deliverables under this directory are new in the shared worktree; no pre-existing tracked edits were changed for the benchmark. The full tracked patch used to reconstruct the isolated tree is retained only in `/tmp/phase0-tracked-worktree.patch` for this local session and is not part of the artifact; it may disappear with temporary storage. A future reader without those exact bytes can verify recorded artifact hashes and repeat the harness only from a separately reconstructed matching tree.