# Local retrieval skills: Codex comparison

**Work in progress, 15 November 2026.** The first completed workflow experiment
reduced Codex total tokens by 17.0%, but agent time by only 1.4%. Its three
Doktimoi runs averaged 244,629 tokens / 116.6 seconds; their paired controls
averaged 294,694 / 118.2 seconds. QMD's three runs averaged 368,229 / 114.5 seconds.
These are observations, not a quality-equivalence or universal-speed claim.
All three improved answers omitted the same required feature prerequisite:
their searches retrieved API fields without the conceptual source's condition.
[The remaining-answer review](remaining-quality.md), [first improved answer](after1-quality.md)
and [first QMD answer](qmd1-quality.md) document the difference; all three QMD
answers retained that condition. The expanded CPU/GPU/multiformat comparison
and correction of this quality regression are pending.

A subsequent [single-pair pilot](phase2/quality-pilot-review.md) recovered the
missing prerequisite in Doktimoi's answer, at 258,332 tokens / 104.8 seconds
versus its control's 308,486 / 123.0 seconds. A citation-precision defect remained;
the control omitted the prerequisite. This is a diagnostic pilot, not proof of
equal quality. Its [frozen phase inputs](phase2/) precede the later lexical-server
and task-routing changes.

The subsequent 0.14.0 checkpoint also includes [controlled UI screenshot OCR
measurements](../../ocr/2026-11-15/), automatic layout/orientation detection and
preservation of Word superscripts/subscripts. [Caveman research](caveman-research.md)
examines its current instructions and published evidence; no Doktimoi saving is
claimed from Caveman, and its full prompt was not imported.

Checkpoint validation: [141 tests passed, 4 skipped](tests-0140.log) with
`DOKTIMOI_TEST_OCR=1` and an isolated LibreOffice 26.8.3.1 on macOS, including
legacy DOC/XLS conversion; [20/20 lexical retrieval cases](retrieval-0140.json).
The first OCR-enabled attempt lacked LibreOffice and failed those two legacy
cases. macOS sandbox restrictions also blocked a test attempt; the recorded
passing full suite ran outside that sandbox. No Windows execution is claimed.

The [before](before/) and [after](after/) snapshots retain the actual code hashes,
prompts and raw usage. They evaluate the initial 0.13.3/0.13.4 workflow, before the
subsequent DOCX/OCR corrections. [before-quality.md](before-quality.md) reviews
the initial six answers. [library-docs-setup-failure.md](library-docs-setup-failure.md)
records an invalid empty-index pilot. The first doc-search and QMD Search audits
also rejected equivalent relative/absolute source paths; their raw failed audits
are retained, and fresh runs will use the corrected targeted-read protocol.

This study uses the unchanged [production-design task](../../task.md) and
409 pinned Kubernetes v1.32 Markdown sources. It compares complete agent tasks,
not just search response sizes. Model: `gpt-6.1-sol`, medium effort; Codex CLI
0.166.0; Node 26.13.0; macOS arm64. These results must not be pooled with the
older `gpt-6-astra` measurements or Claude/Windows results.

## Selected skills

| Skill | Pinned source | Retrieval tested |
| --- | --- | --- |
| QMD | [tobi/qmd at facd35e](https://github.com/tobi/qmd/tree/facd35e01359e59d938bc9418e93fb9318addee3) | Native skill and QMD 2.8.3 BM25 CLI |
| QMD Search | [glebis/claude-skills at 4d37d3b](https://github.com/glebis/claude-skills/tree/4d37d3b0af1f98cb4ac820d9abbce95e38e909fb/qmd-search) | Its Bash wrapper over the same QMD runtime |
| library-docs | [um1b/library-docs at 4fade60](https://github.com/um1b/library-docs/tree/4fade60d18fcfd8dd166cdd4936a6b6005256292) | Python standard-library SQLite FTS5 and section reads |
| doc-search | [r04943083/doc-search-skill at 92c601a](https://github.com/r04943083/doc-search-skill/tree/92c601ac408923b0a3a47720df616ded9ac0946f) | Python BM25 CLI, replacing its MCP transport |
| fidx | [williamliu-ai/fidx at 1299e30](https://github.com/williamliu-ai/fidx/tree/1299e30dab7d925c905606cd7db329c29a431ab4) | Python/SQLite FTS5 + ONNX CPU; full-corpus preparation in progress |
| GBrain | [garrytan/gbrain at aab958d](https://github.com/garrytan/gbrain/tree/aab958d1a0f8cd0e2cb0cdd98e90308f4c6d18fc) | Bun/PGlite keyword search; local embedding service evaluated separately |
| Meme | [qntx/meme at 1098381](https://github.com/qntx/meme/tree/10983816e0f24781d4ed562331ff48e1362865f5) | Rust 1.0.0; lexical and structured CPU/Metal hybrid preparation |

The first four were cloned separately and their MIT licenses inspected. The selection
targets available local-document search skills with a runnable model-free mode;
it is not an exhaustive survey. QMD was pinned to its published package's exact
commit so the skill and installed runtime match. The wrapper is a separate skill
workflow, not an independent search engine. No embedding model was downloaded or
enabled for these first four lexical arms. The expanded study has explicit user
consent for local models; CPU/Metal semantic results will be reported separately.

The three user-selected additions were also cloned separately into temporary
directories. GBrain is MIT; Meme is MIT OR Apache-2.0. **fidx by William Liu** uses
[MIT AND AI Idea Attribution Addendum v1.0](https://github.com/williamliu-ai/fidx/blob/1299e30dab7d925c905606cd7db329c29a431ab4/LICENSE).
Its collection relocation and explicit token-budgeted retrieval informed the
comparison adapters; no fidx source code was copied into Doktimoi.
[Caveman](https://github.com/juliusbrussee/caveman/tree/b4ee71d557d96e3cbc14f88fa6e953a1362865f5)
is a separately inspected output-style/compression project, not a document
retriever. Its published output-token reductions are not substituted for this
benchmark's measured provider totals. Requested plans and files keep their full
detail; no Caveman writing style is applied.

## Method and reproducibility

Each invocation gets a fresh context and a clean copy containing only the
manifest-listed documents. This matters: doc-search's recursive collector also
indexes hidden generated caches if they are present. No expected answers or
quality rubric enter the model prompt. The actual upstream SKILL.md is read in
each treatment. CLI paths and prebuilt-index locations are supplied equally as
setup information; tool-specific adapters add some prompt overhead, retained in
the measured usage. Plugin hooks and MCP transport are not measured.

Provider input plus output is the total-token measure. Cached input is already
included, and reasoning output is not counted twice. Uncached input, output,
tool-output estimates, commands and errors are reported separately. Setup/index
time is excluded from agent time and must be added for first-use cost. No price
or monetary saving is inferred from token totals.

[configs/](configs/) contains the exact local command adapters; [runtime.json](runtime.json)
records versions, source/runtime hashes and the Python dependency freeze. Replace
the machine-specific executable/clone paths when reproducing. Create the four
clones at the linked commits, install doc-search in an isolated Python environment,
and use QMD 2.8.3. Do not enable embeddings for this experiment.

```sh
node benchmarks/agent-benchmark.mjs --agent codex --model gpt-6.1-sol \
  --competitor /absolute/path/to/config.json --arm competitor \
  --output /tmp/new-competitor-results --pairs 3
node benchmarks/check-answers.mjs /tmp/new-competitor-results
```

The runner preserves prompts, answers, JSONL usage/command events, stderr, setup
logs, timings, configuration and source hashes. Output directories must be new;
`--resume` requires matching task, skill, implementation, runtime and runner
hashes. Its command audit is diagnostic, not a shell security boundary. Traces
and claims also require review against the original source.

The QMD wrapper's [runtime preflight](wrapper-preflight.json) required an explicit
Node PATH inside its Bash invocation: a macOS login shell otherwise selected
Node 20.18.0. The preparation runtime snapshot retains the initial adapter hash;
each run's summary records the effective adapter actually used.

## Limits

This is one task, one corpus, one model and one machine. Repeated runs expose
variation but do not establish general superiority. No OS or provider cache was
flushed. Remote latency varies. Lexical Markdown results do not establish Office,
PDF, OCR, multilingual or semantic-search performance. Improvements informed by
these traces are within-task validation; a held-out task is still needed.
