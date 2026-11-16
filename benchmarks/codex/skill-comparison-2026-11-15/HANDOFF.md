# Handoff: what remains for macOS + Codex

State on 16 November 2026, version 0.14.1 on `main`. The `work` branch (started on
macOS with Codex) was merged after its code was finished and checked on Windows.
Give this file to Codex on the Mac as the starting point.

## Done and verified

- Lexical folders now use the per-folder background server too; it never creates an
  index or enables a model (`skills/doktimoi/scripts/server.mjs` `viaServer`,
  `hooks/sync.mjs` `warmServer`). The server child's spawn `error` falls back promptly.
- SKILL.md task routing: one question → direct search; planning → `references/retrieve.md`;
  several questions → batches. Citation and prerequisite rules added.
- Benchmark runner: `--task PATH` with content hash, hybrid competitor configs with
  pinned artifacts, native hybrid evidence (`fidx-v2`, `meme-structured`) and preflight.
- `check-answers.mjs` accepts `[label](docs/path.md), lines 99–136`.
- Windows 11, Node 26.13.0: [146 tests passed, 5 skipped](tests-0141-windows.log)
  (no `DOKTIMOI_TEST_OCR`), [20/20 lexical retrieval cases](retrieval-0141-windows.json).

## Not done (needs macOS and Codex)

1. **OCR/legacy tests for 0.14.1 on macOS:** `DOKTIMOI_TEST_OCR=1 node --test` with
   LibreOffice, as for [tests-0140.log](tests-0140.log). Save as `tests-0141.log`.
2. **Three frozen pairs of the current workflow.** The [phase2 pilot](phase2/quality-pilot-review.md)
   was one pair and predates the lexical server and task routing. Run the unchanged
   production task, new output folder:
   `node benchmarks/agent-benchmark.mjs --agent codex --model gpt-6.1-sol --output benchmarks/codex/<new-name> --pairs 3`.
   Review quality with [the rubric](../../quality-review.md); check especially the
   `StatefulSetAutoDeletePVC` prerequisite (section 9) and the `pod-v1.md` countdown
   citation (section 4, line 1008), which the pilot cited imprecisely.
3. **Meeting question, separate from long-task results:**
   `--task benchmarks/meeting-question.fi.md`. The ten-section checker does not apply.
4. **New competitors:** fidx (full-corpus preparation unfinished), GBrain and Meme.
   No configs exist yet under [configs/](configs/); write them with pinned `commit`,
   `artifacts` SHA-256 and `preflight`, `retrieval: "hybrid"` and `hybridEvidence`
   for the hybrid arms (see `validateCompetitor` and `hybridEvidence` in
   `benchmarks/agent-benchmark.mjs`, tests in `tests/benchmark.test.mjs`).
5. **CPU/Metal semantic comparison**, reported separately from lexical arms. Local
   models have user consent for this study only.
6. **A held-out task**: all improvements so far were validated on the same task.

When a step completes, update the numbers and "in progress" wording in this
folder's README, `benchmarks/README.md` and the top-level README. Never edit
recorded runs; report negative results as plainly as positive ones.
