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

The [22 November M1 study](codex/mac-2026-11-22/README.md) ran three fresh Codex sessions per arm and task on `gpt-6.1-sol`. Means below use provider input plus output. The Doktimoi arm used lexical retrieval and the same batching instruction as the batched file control.

| Task | Ordinary files | Batched files | Batched Doktimoi | Doktimoi vs batched files |
| --- | ---: | ---: | ---: | ---: |
| Kubernetes production review | 353,923 | 274,694 | 238,710 | −13.1% |
| Kubernetes batch platform | 313,040 | 247,890 | 234,650 | −5.3% |
| Finnish archive decision | 126,907 | 111,329 | 139,467 | +25.3% |
| English receipt comparison of Finnish sources | 88,252 | 105,266 | 151,115 | +43.6% |

All nine lexical/control answers to the Finnish shipment question matched the reference values and sources. In the English receipt comparison ordinary file tools got 1/3 exactly right, batched files and Doktimoi each got 3/3. The two Kubernetes reviews are open-ended. The [answer review](codex/mac-2026-11-22/quality.md) records omitted prerequisites and imprecise citations. The study includes hybrid measurements, agent times, actual model rounds, setup costs and competitor traces. The [native QMD comparison](codex/skill-comparison-2026-11-15/README.md) used an earlier workflow.

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
Linked shorter pages and images are intentionally absent. The [second corpus](finnish-dispatch/README.md) contains 441 Finnish sources including Word, Excel and scan images. It has an exact answer key and a separate bilingual passage lookup test.

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
scored [18/20](codex/mac-2026-11-22/retrieval-current-hybrid.json): semantic fusion
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

Use `--agent codex --arm batch-study` for the three-arm batching comparison, `--task PATH` for another task, `--competitor CONFIG --arm
competitor` for a competitor and, with consent to a local model, `--retrieval hybrid
--prepared DIR` for a prepared semantic index. Output folders must be new; `--resume`
continues only when every recorded hash matches. After a new run in the same environment,
delete the older run and update these documents.

## Limits

Three repetitions per arm and two corpora limit generalization. Caches are not flushed, cloud latency varies and neither machine was a dedicated test host. The Finnish task tests a synthetic workflow with a searchable shipment name, small Office files and legible scans. Other layouts, ambiguous requests, real-world OCR noise and tasks without shared identifiers can give different results.
