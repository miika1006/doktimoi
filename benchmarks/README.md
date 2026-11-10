# Agent benchmark

The benchmark measures the entire assistant task, including repeated model
context, rather than equating a small tool response with a token saving.
The lexical results are in [release-2026-11-10](release-2026-11-10/), with a
separate [semantic CPU comparison](semantic-cpu-2026-11-10/).

## Completed measurements

| Arm, 3 fresh contexts each | Total tokens across runs | Mean tokens | Mean agent seconds | Commands across runs |
| --- | ---: | ---: | ---: | ---: |
| Baseline | 752,574 | 250,858 | 147.8 | 28 |
| Lexical | 907,979 | 302,660 | 167.0 | 31 |
| Hybrid CPU | 823,750 | 274,583 | 197.6 | 32 |

Lexical used 20.6% more total tokens and 13.0% more agent time than baseline;
hybrid used 9.5% more total tokens and 33.8% more agent time. These results do
not establish the intended saving. [comparison.json](comparison.json) contains
per-run values, uncached input, output estimates, error counts and setup costs.
Hybrid's uncached input was 96,434 versus baseline's 104,267 (7.5% lower), while
its total remained higher. No monetary-cost claim is inferred from that subset.

All nine isolation audits passed. The three hybrid runs contain **14 successful
hybrid commands**, with three additional operations reporting absent paths, one
capped output and one empty search. They were not silently replaced by baseline
file tools. All nine completed runs have provider usage events and no recorded
transport reconnections. Earlier failures are listed separately below.

## Task and corpus

[task.md](task.md) asks for a 900–1400-word production-design review covering
ten interacting Kubernetes topics: availability, topology, probes, termination,
resources, autoscaling, networking, Secrets, storage and validation. Every answer
must cite local source ranges and distinguish guarantees from prerequisites and
application-specific unknowns.

The [example corpus](../examples/kubernetes/README.md) contains 409 unchanged
Kubernetes v1.32 Markdown files, 8,513,875 bytes. Every file is at least 8 KiB.
The upstream revision, selection rule, license and individual SHA-256 hashes
are committed. This is a pinned source subset; linked shorter pages and images
are intentionally absent, and Hugo includes are not rendered.

## Measurement

- Each run starts a separate `codex exec` process and fresh thread, with a fresh
  copy containing only manifest-listed source files. `--ignore-user-config`,
  `--ignore-rules` and `--ephemeral` remove personal configuration and history.
  No earlier answer, expected answer or quality rubric is supplied.
- Both arms use Codex CLI 0.166.0, `gpt-6-astra`, medium reasoning, Node 24.15.0
  and the exact same task on macOS arm64. Both receive the same absolute Node
  path because a login shell can replace PATH. Order alternates across three
  pairs: baseline first, Doktimoi first, baseline first.
- Baseline uses ordinary selective file tools (`rg`, `sed`, etc.). Doktimoi
  loads the real SKILL.md and uses its CLI for all document content lookups.
  A lexical index is built before each treatment run and timed separately.
  External web evidence, subagents and source edits are excluded.
  Plugin hooks are not activated: this isolates skill/CLI retrieval behavior.
- **Total model tokens = provider `input_tokens + output_tokens`.** Cached input
  is already part of input; reasoning output is already part of output. Neither
  is added again. Uncached input is reported separately. These are actual CLI
  usage events, not a document-size estimate or a monetary cost calculation.
  Tool-output token counts use `o200k_base` and are only estimates.
- Agent duration spans process startup through final answer. Cold indexing is
  reported separately and must be added for first-use cost. Existing-index use
  can amortize construction, but that is not assumed in the cold comparison.
- Prompts, answers, JSONL events, stderr, build logs, timings, thread IDs and
  source hashes remain in each result directory. `implementation.patch` records
  the evaluated retrieval changes relative to repository commit
  `e9a805514aaabeba269486d6cd5df4a308091ffd`.

The command audit flags unexpected tools, baseline index use, failed commands,
partial read errors, output caps and empty searches. It requires actual Doktimoi
content calls in the treatment arm. This is a conservative trace check, not a
shell security boundary; recorded commands and answers also need human review.
Reading SKILL.md or a skill reference is setup overhead, not a content bypass.

### Semantic comparison

After explicit user consent, the same corpus was embedded with the pinned
[EmbeddingGemma 300M Q8 model](embedding-model.json). The [setup measurement](semantic-setup.json)
records 11.155 seconds for indexing and 470.850 seconds for embedding, with zero
embedding errors. Downloading the 333,590,944-byte model took 12.56 seconds.
The prepared index is copied into each fresh treatment workspace and checked
against every pinned source hash. Copy/preflight time is reported separately;
the shared build and embedding cost must not disappear from first-use comparisons.

The three treatment contexts use **all three** baseline runs from the completed
lexical comparison as preselected controls. They were collected in separate
phases, not as alternating contemporaneous pairs. No baseline was selected based
on its score. Corpus, task, model, reasoning effort, Node and Codex versions are
unchanged. Semantic instructions and CPU execution differ; OS/model caches and
cloud conditions can differ too. This is an exploratory comparison.

The first [semantic attempt](semantic-2026-11-10/README.md) failed inside the
macOS sandbox: the packaged Metal backend could not initialize, and its CPU
fallback still tried Metal. That interrupted attempt remains archived and is
excluded from completed-run aggregates. Building node-llama-cpp 3.20.0's bundled
llama.cpp b10361 with `--gpu false` resolved this environment issue; see the
[build log](semantic-cpu-build.log) and [sandbox preflight](semantic-cpu-preflight.log).
The measured semantic agents run with `QMD_FORCE_CPU=1`; sandbox restrictions
remain enabled. A native-inference preflight now runs before each macOS semantic
agent, and the trace audit requires successful hybrid calls, not just attempts.

Semantic ranking is not infallible: the [recorded natural-language smoke query](semantic-smoke.json)
missed the base64 confidentiality warning in its top three results on the full
corpus, although all returned text/ranges matched their originals. Agent answers
therefore still need separate evidence and qualification review.

## Correctness

[validation-queries.json](validation-queries.json) defines 20 expected passages
derived from the task. [retrieval-validation.json](retrieval-validation.json)
records their results. The validator checks the expected source and text in
the top ten lexical hits within a 6000-token budget, compares exact-mode line
numbers with direct scans of the originals, and checks returned reads against
original source slices. The final ranker retrieves **20/20** on the first query.

Running the identical keyword queries through hybrid ranking scored
**18/20**, including the recorded refinement: [semantic results](semantic-retrieval-validation.json).
The additive-NetworkPolicy and Pod-creation/Secret warnings were ranked outside
the ten-hit selection; their original lines still appeared in exact mode, and
larger candidate reads located them. Semantic fusion can demote precise lexical
evidence, so use lexical/exact mode for distinctive terms. This relevance
limitation remains; passing text-integrity tests does not resolve it.

[The earlier check](retrieval-before-optimization.json) scored 19/20 before a
recorded query refinement recovered the Secret/Pod-creation passage. That miss
has not been removed from the dataset. After the retrieval changes the same
original query succeeds; no refinement is needed. This small, curated set is
a regression check, not a general recall or accuracy estimate.

Generated memos require a separate review against the original documents.
The baseline is not ground truth. Raw answer paths are relative to each run's
temporary `docs/` folder; resolve them against
[`examples/kubernetes/docs`](../examples/kubernetes/docs/) when reviewing saved
answers. A valid citation range alone does not prove a claim is supported.

## Reproduce

Install the skill's locked dependencies and put a supported Node and authenticated
Codex CLI on PATH, then run from the repository root:

```sh
npm ci --prefix skills/doktimoi
node benchmarks/validate-retrieval.mjs
node benchmarks/agent-benchmark.mjs --output /tmp/doktimoi-new-results --pairs 3
node benchmarks/check-answers.mjs /tmp/doktimoi-new-results
```

After consent to local model use, add `--retrieval hybrid` for a full fresh
baseline/semantic comparison. For the exact model, set `QMD_EMBED_MODEL` to the
verified model file from `embedding-model.json`; `XDG_CACHE_HOME` can isolate its
cache. On the tested Mac, the CPU backend build in the setup guide and
`QMD_FORCE_CPU=1` were required. The default harness builds/embeds each treatment
copy; `--prepared PATH` reuses a complete matching semantic index and records its
copy cost. `--arm doktimoi` runs only treatments when reusing explicitly named
controls; report that different study design and the original setup cost.

Validate the same evidence queries against that prepared semantic index with:

```sh
QMD_FORCE_CPU=1 QMD_EMBED_MODEL=/path/to/verified-model.gguf node benchmarks/validate-retrieval.mjs --mode hybrid --prepared /path/to/indexed-docs
```

The validator intentionally exits nonzero when expected evidence is absent;
the archived 18/20 semantic run is a recorded failure, not a passing check.

The output directory must be new. `--resume` continues completed runs only when
the model, effort, runtime, task, skill and implementation hashes match; it refuses
to overwrite incomplete raw evidence. Use `--model` and `--effort` to test another
configuration, and report it separately. Runs consume normal Codex model usage.
On macOS the runner prevents idle sleep for its own lifetime. Manual sleep or
closing the lid still invalidates elapsed-time comparisons.

## Limits and diagnostic history

One task, one corpus, one model and three pairs do not establish a universal
speedup. OS caches are not flushed, prefix caching remains enabled and reported,
cloud latency varies, and the Mac was not a dedicated performance-test host.
Prompt wording and model choices affect both output volume and the number of
turns. This is a demanding Markdown baseline already using selective reads;
it does not measure Office/PDF conversion or OCR. The semantic comparison uses
one small local model and CPU inference; it does not establish GPU performance.

Earlier experiments are retained rather than hidden:

1. [Pilot](pilot-2026-11-10/README.md): more tokens, an unsupported Node selected
   by a login shell, and one intentionally interrupted run.
2. [First three pairs](results-2026-11-10/README.md): 58.1% more total tokens,
   unnecessary setup reading, missing-path retries and one recovered connection
   failure whose precise elapsed time was lost.
3. [Intermediate optimization](optimized-2026-11-10/README.md): no retrieval
   errors, but more tokens; host sleep invalidated the baseline duration. A
   checker falsely rejected the skill-file read, and its corrected audit is saved.
4. [Candidate comparison](final-2026-11-10/README.md): filename ranking fixed,
   but 5.8% more tokens and two batches aborting on an absent linked page. Those
   batches motivated the final per-question error isolation.

## Why a bounded response did not guarantee token savings

The traces exposed several avoidable costs: unsupported Node selected by a login
shell, setup reading for ready indexes, brief-search-then-read round trips,
filename-only matches outranking source content, large lists hiding conditions,
and an absent linked page aborting a whole batch. Runtime preflight, shorter
instructions, full passages, corrected ranking/chunks and per-question recovery
address those problems. Scoped retrieval also no longer stops at 500 candidates,
negative lexical queries no longer lose exclusions in OR fallback, and CSV
references no longer mistake normalized rows for source-aligned text lines.

The remaining cost is visible in the successful traces: the agent still searches
again for missing conditions, sometimes guesses absent linked files, reads skill
instructions and sends longer retrieval commands. Each model round processes
accumulated context again. The baseline already uses selective `rg`/`sed` reads
on familiar, structured Markdown. Smaller tool output or lower uncached input
alone cannot substantiate a reduction in total model tokens, elapsed time or cost.

## Local release checks

Node 24.15.0 and the user's nvm-installed Node 26.13.0 each completed
127 tests: **121 passed, 0 failed, 6 skipped** with OCR disabled. The captured
[Node 24 log](local-tests-node24.log) and [Node 26 log](local-tests-node26.log)
include the actual final totals. Skips cover platform-specific Windows checks
and integrations requiring enabled OCR/LibreOffice. These passing unit/integration
tests do not turn the 18/20 semantic relevance check into a pass.

The skill validator passed, and [Codex plugin discovery](codex-plugin-discovery.json)
recognized `doktimoi@doktimoi` version 0.12.0. Hook behavior is covered by process
and integration tests; interactive hook trust was not enabled in the user's app.
CI now adds macOS Node 24 while retaining Linux/Windows and their OCR checks.
