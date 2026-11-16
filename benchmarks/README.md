# Agent benchmark

The benchmark measures a whole assistant task, including the context each model round
re-sends, rather than the size of one tool response. Only the latest run per agent, OS and
retrieval mode is kept; older runs are in git history.

## Claude Code, Windows: 16 November 2026

`claude-opus-5-5`, medium effort, Claude Code 2.1.325, Windows 11. **Real-time antivirus
scanning was on**; it slows indexing and process start-up, so times compare within these
runs. Means of three runs; total tokens are provider input plus output with cached input
counted once.

| Task | Arm | Total tokens | vs control | Agent time | Cost |
| --- | --- | ---: | ---: | ---: | ---: |
| [Production design](claude/lexical-2026-11-16-windows/README.md) | Read/Grep/Glob control | 1,092,232 | — | 140.7 s | $0.85 |
| | [Doktimoi 0.14.2](claude/lexical-0142-2026-11-16-windows/README.md) | 385,461 | −64.7% | 93.6 s | $0.69 |
| | [Doktimoi 0.14.2 hybrid (GPU)](claude/hybrid-2026-11-16-windows/README.md) | 476,179 | −56.4% | 108.8 s | $0.61 |
| [Held-out batch platform](claude/heldout-2026-11-16-windows/README.md) | Read/Grep/Glob control | 1,247,728 | — | 118.8 s | $0.99 |
| | Doktimoi 0.14.2 | 642,117 | −48.5% | 93.8 s | $0.70 |
| [Meeting question (fi)](claude/meeting-2026-11-16-windows/README.md) | Read/Grep/Glob control | 347,239 | — | 52.4 s | $0.38 |
| | Doktimoi 0.14.1 | 171,786 | −50.5% | 52.5 s | $0.28 |

The [competitor comparison](claude/competitors-2026-11-16/README.md) ran QMD, Meme (QMD's
Rust port), QMD Search, library-docs, GBrain and doc-search on the production task; it is
paused with QMD Search and the hybrid competitor arms incomplete. Doktimoi used the fewest
tokens and tool calls. Current checks on this machine:
[148 tests passed, 5 skipped](claude/tests-0143-windows.log) (OCR tests off) and
[20/20 retrieval cases](claude/retrieval-0143-windows.json).

## Codex, macOS

- **Lexical, 15 November** (`gpt-6.1-sol`, Codex CLI 0.166.0, Apple M1): a one-pair
  [accuracy pilot](codex/skill-comparison-2026-11-15/phase2/quality-pilot-review.md) used
  258,332 tokens / 104.8 s against its control's 308,486 / 123.0 s and kept the
  `StatefulSetAutoDeletePVC` prerequisite; three QMD runs averaged 368,229 / 114.5 s.
  Three-pair runs of 0.14.x remain to be done: see the
  [study README](codex/skill-comparison-2026-11-15/README.md) and its HANDOFF.
- **Hybrid CPU, 10 November** (`gpt-6-astra`): [three runs](codex/semantic-cpu-2026-11-10/README.md)
  averaged 274,583 tokens, 9.5% more than that day's `rg`/`sed` controls (250,858).
  Codex's own shell already batches lookups, so Doktimoi saved no rounds there.

OCR converter measurements are in [ocr/2026-11-15](ocr/2026-11-15/).

## Tasks and corpus

[task.md](task.md) asks for a 900–1400-word production-design review of ten interacting
Kubernetes topics with cited source ranges, separating guarantees, configuration,
prerequisites and unknowns. [heldout-task.md](heldout-task.md) is a second ten-question
review (a multi-team batch platform) written after all workflow changes.
[meeting-question.fi.md](meeting-question.fi.md) is one Finnish meeting question; the
ten-section checker does not apply to it. Select a task with `--task PATH`; the runner
records its hash.

The [example corpus](../examples/kubernetes/README.md) holds 409 unchanged Kubernetes
v1.32 Markdown files (8,513,875 bytes) with pinned revision, license and SHA-256 hashes.
Linked shorter pages and images are intentionally absent.

## Measurement

- Each run is a fresh process and context on a fresh copy of only the pinned sources.
  Codex runs ignore user config and rules; Claude runs load only project settings and
  allow-list tools. No expected answer or rubric is in the prompt. Pair order alternates.
- The control uses the agent's own file tools; the Doktimoi arm loads the real SKILL.md
  and uses its CLI. Competitor arms read the competitor's own SKILL.md and may run only
  its configured commands plus targeted reads; adapters are in each study's `configs/`.
- **Total tokens = provider input + output.** Cached input is part of input and counted
  once; reasoning is part of output. Index building is timed separately, never in agent time.
- Every run keeps its prompt, answer, raw events, stderr, timings and hashes. The trace
  audit flags tools outside the arm, content searches that bypass it, failed or denied
  calls and empty searches; it is a check, not a security boundary.

## Correctness

[validation-queries.json](validation-queries.json) defines 20 expected passages;
[validate-retrieval.mjs](validate-retrieval.mjs) checks they are in the top ten lexical hits
and that exact-mode lines and reads match the originals (latest: 20/20). Hybrid ranking last
scored [18/20](codex/semantic-cpu-2026-11-10/retrieval-validation.json): semantic fusion
can demote precise lexical evidence. [check-answers.mjs](check-answers.mjs) checks answer
structure and that every cited range exists, which is not proof that a claim is supported;
answers were also screened for the decision-relevant qualifications
([qualifier-check.mjs](claude/qualifier-check.mjs), [rubric](codex/quality-review.md)).

## Reproduce

```sh
npm ci --prefix skills/doktimoi
node benchmarks/validate-retrieval.mjs
node benchmarks/agent-benchmark.mjs --agent claude --output benchmarks/claude/NEW_DIR --pairs 3
node benchmarks/check-answers.mjs benchmarks/claude/NEW_DIR
node benchmarks/claude/summarize-runs.mjs benchmarks/claude/NEW_DIR
```

Use `--agent codex` for Codex, `--task PATH` for another task, `--competitor CONFIG --arm
competitor` for a competitor and, with consent to a local model, `--retrieval hybrid
--prepared DIR` for a prepared semantic index. Output folders must be new; `--resume`
continues only when every recorded hash matches. After a new run in the same environment,
delete the older run and update these documents.

## Limits

Two tasks on one corpus and three runs per arm do not establish general superiority.
Caches are not flushed, cloud latency varies and neither machine was a dedicated test
host. The tasks are English Markdown; they do not measure Office/PDF conversion, OCR or
cross-language search.
