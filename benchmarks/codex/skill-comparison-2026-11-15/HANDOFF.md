# Handoff: benchmark work that remains

State on 16 November 2026, version 0.14.2 on `main`. Give this file to Codex on the Mac,
or to Claude Code on Windows, as the starting point. Never edit recorded runs; start a
new output folder or `--resume` an unchanged one, and report negative results plainly.

## Done and verified

- 0.14.1: lexical folders use the per-folder background server; SKILL.md routes one
  question, several questions and planning differently; `--task PATH` in the runner.
- 0.14.2 (Windows, Claude Code):
  - First index build of the 409-file corpus fell from about 146 s to 22 s: chunk files
    are written concurrently and a complete build indexes them from memory instead of
    QMD reading every file back (`writeChunks`, `updateIndex` in `doktimoi.mjs`).
  - SKILL.md says expansions go into one doktimoi `read` call, not file-read tools;
    Claude had tried the Read tool on the corpus.
  - A batch request whose `--path` is absent (agents guess linked pages) now searches
    all sources with a label instead of costing another round.
  - The runner supports Claude competitors, Windows paths, sparse competitor checkouts
    (identified by Git tree and clean status) and records host-denied tool attempts.
  - `check-answers.mjs` resolves abbreviated citations (`file.md:N-M`, `:N-M`).
- Claude Code results: [competitors](../../claude/competitors-2026-11-16/README.md), [hybrid](../../claude/hybrid-2026-11-16-windows/README.md),
  [held-out task](../../claude/heldout-2026-11-16-windows/README.md).

## Not done

On Windows with Claude Code (`--agent claude`; adapters in
`benchmarks/claude/competitors-2026-11-16/configs/`, regenerate with `make-configs.mjs`):

1. **QMD Search**: 1 of 3 runs (`--competitor .../configs/qmd-search.json --arm competitor`).
   `--resume` refuses because the recorded Doktimoi implementation hash changed after
   run 1; start a new folder and keep run 1 as earlier evidence.
2. **Competitor hybrid arms**: `meme-hybrid.json` and `fidx-hybrid.json`
   (`--retrieval hybrid`; models are cached and hash-pinned; their setup embeds the corpus
   in every run). Doktimoi hybrid is done; its prepared index is in `C:\TEMP\doktimoi-prepared`.
   Local models have the user's consent for this study only.
3. **QMD on the held-out task** (`--task benchmarks/heldout-task.md`).
4. **Rust versus Node retrieval measurement** on an otherwise idle machine:
   `node benchmarks/qmd-rust-latency.mjs benchmarks/rust-port C:\TEMP\doktimoi-competitors\meme\target\release\meme.exe`.
   It compares QMD, Meme and Doktimoi (direct and through its server). The first attempt
   failed when antivirus briefly locked `meme.exe` (`EPERM`); spawns now retry and are counted.
   Run it only when the user asks.
5. **Meeting question on 0.14.2** (`--task benchmarks/meeting-question.fi.md`); the
   ten-section checker does not apply to it.

On macOS with Codex:

6. **OCR/legacy tests for 0.14.2**: `DOKTIMOI_TEST_OCR=1 node --test` with LibreOffice,
   as for [tests-0140.log](tests-0140.log).
7. **Three frozen Codex pairs of 0.14.2** on the production and held-out tasks:
   `node benchmarks/agent-benchmark.mjs --agent codex --model gpt-6.1-sol --output benchmarks/codex/<new-name> --pairs 3`.
   Check the `StatefulSetAutoDeletePVC` prerequisite (section 9) and the grace-period
   countdown citation (section 4) with [the rubric](../../quality-review.md).
8. **Codex competitor runs** for fidx, GBrain and Meme with macOS paths (copy the
   Windows adapters and change executables and clone paths), and Metal hybrid runs.

When a step completes, update this folder's README, `benchmarks/README.md`, the
Claude comparison README and the top-level README.
