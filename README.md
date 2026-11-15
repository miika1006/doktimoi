# Doktimoi

**Token savings depend on the agent and answer quality.** Earlier Claude Code
runs used **64–66% fewer total tokens**. A completed three-pair Codex workflow
experiment used **17.0% fewer tokens and 1.4% less agent time**, but all three
answers omitted a required prerequisite: this is **not an equal-quality saving**.
[Results, competitor comparisons and raw evidence](#measured-results) distinguish
these experiments and their limits. New accuracy and CPU/GPU comparisons are in progress.

Doktimoi is a Claude Code and Codex skill that gives a documentation folder a local
search engine. It indexes the files and returns relevant passages with source citations
and a bounded output size, so the assistant finds evidence in fewer steps instead of
repeatedly grepping and reading whole files.

Supports Markdown, plain text, Word (`.docx`/`.doc`), Excel (`.xlsx`/`.xls`),
PowerPoint (`.pptx`), PDF, HTML, RST, AsciiDoc, draw.io, Mermaid, SVG, CSV/TSV, YAML,
JSON and PNG/JPEG/WebP images. Built on **[QMD](https://github.com/tobi/qmd)** (BM25
keyword and optional semantic search); QMD retrieves, your assistant writes the answer.

## What Doktimoi adds

- **Document ingestion and local OCR**, including images inside Word, Excel, PowerPoint
  and PDF. Citations keep files, Markdown lines, PDF pages or Excel sheets and cells.
- **Automatic refresh** before searching when documents change.
- **Token-budgeted output**: selected passages (1600 tokens by default), several
  questions per call, exact-phrase listing in place of `grep -rn`.
- **Product-analysis guidance**: separate shipped features, roadmap items, customer
  requirements and unknowns.

For Markdown-only collections, QMD's own skill may be enough.

## Measured results

The same production-design task uses 409 pinned Kubernetes v1.32 files (8.5 MB).
Numbers below are per-run means over three fresh contexts per row. Total tokens
are provider input plus output, including cached input once. Indexing is excluded
from agent time and reported separately. Models, dates and phases are not pooled.

### Latest completed Codex and competitor runs — 15 November

Codex `gpt-6.1-sol`, medium effort, macOS Apple M1. The two workflow experiments
each have their own three paired controls. QMD is a separate three-run arm.

| Workflow | Total tokens | vs paired control | Agent time | Quality finding |
| --- | ---: | ---: | ---: | --- |
| Initial control (`rg`/`sed`) | 296,498 | — | 115.0 s | See per-answer review |
| Doktimoi initial workflow | 333,688 | +12.5% | 125.7 s | One citation defect; one omitted default |
| Revised-workflow control | 294,694 | — | 118.2 s | One omitted default |
| Doktimoi revised workflow | 244,629 | **−17.0%** | 116.6 s | **All three omitted a prerequisite** |
| QMD native skill / lexical CLI | 368,229 | Separate arm | 114.5 s | Required qualifiers retained in all three |

The revised Doktimoi workflow groups independent batches into the same tool
round and reuses unused passage budgets. It reduces repeated input context,
but its API-only evidence missed a condition in the conceptual documentation.
QMD was slightly faster in this sample and retained that condition, while using
more tokens. The evidence does not establish Doktimoi as the fastest or an
equal-quality token-saving winner. A subsequent single-pair
[accuracy pilot](benchmarks/codex/skill-comparison-2026-11-15/phase2/quality-pilot-review.md)
restored the missing prerequisite: 258,332 versus 308,486 tokens and 104.8 versus
123.0 seconds. One citation remained imprecise, while its control omitted the
prerequisite. This pilot is not a three-pair or equal-quality result; further
corrections are being tested. Unfinished runs are excluded.

The [comparison study](benchmarks/codex/skill-comparison-2026-11-15/README.md)
links source commits, complete traces, quality reviews and setup/audit failures.
It also tracks QMD Search, library-docs, doc-search, fidx, GBrain and Meme;
preparation failures are not reported as successful fast runs. Caveman's writing
style is not applied: requested plans and files retain their full detail.

A separate [process-reuse probe](benchmarks/codex/skill-comparison-2026-11-15/lexical-server-probe/results.json)
measured lexical CLI medians of **365 ms in-process versus 53 ms through an
already-running server**, with byte-identical evidence and diagnostics in all
nine pairs. Server startup took 65 ms and its first query 361 ms. This isolates
retrieval latency; it is not an end-to-end AI response or token-saving result.

### Earlier agent comparison — 10 November

Claude Code used `claude-opus-5-5` on Windows; Codex used `gpt-6-astra` on macOS.
These are historical measurements of an earlier workflow, not measurements of
the latest Sol changes above.

| Agent | Retrieval | Total tokens | vs baseline | Agent time |
| --- | --- | ---: | ---: | ---: |
| Claude Code, Windows | Read/Grep/Glob baseline | 1,624,913 | — | 159.3 s |
| Claude Code, Windows | Doktimoi lexical | 583,475 | **−64.1%** | 91.9 s |
| Claude Code, Windows | Doktimoi hybrid (GPU) | 545,563 | **−66.4%** | 100.2 s |
| Codex, macOS | `rg`/`sed` baseline | 250,858 | — | 147.8 s |
| Codex, macOS | Doktimoi lexical | 302,660 | +20.6% | 167.0 s |
| Codex, macOS | Doktimoi hybrid (CPU) | 274,583 | +9.5% | 197.6 s |

Claude's lexical arm used 42.3% less agent time and 37.1% less reported cost.
Its baseline made about 42 tool calls per run versus about 11 with Doktimoi.
The earlier Codex baseline already grouped lookups into about nine shell calls;
Doktimoi's 9–11 calls saved no rounds, while repeating skill/command overhead.
That explains why smaller search responses alone did not produce total-token savings.

Cold indexing averaged about 11.6 s on macOS and 58.9 s in the recorded Windows
lexical runs. One-time embedding took 470.9 s on the Mac CPU and 418.9 s on the
Windows integrated GPU. Hybrid arms reused earlier lexical controls. The
20-query evidence check scored 20/20 lexical and 18/20 hybrid; semantic ranking
can miss precise lexical conditions. One task and machine per agent do not
establish general superiority. [Earlier methods and raw results](benchmarks/README.md).

## Example uses

Open your documentation folder and ask:

- “In this meeting: does approval routing support this exception, and under what conditions?”
- “Plan offline approvals in `suunnitelma.md`, including requirements, components,
  source repositories, dependencies and unresolved questions.”
- “Compare these customer notes and pricing sheets with the product docs, separating
  supported features from missing evidence.”
- “doktimoi status” shows the index, semantic search and background server state.
- “Turn off semantic search for this folder” removes embeddings; keyword search stays.

The skill selects retrieval depth from the task: one targeted lookup for a single
question, batches for independent questions, and requirement/constraint discovery
for feature planning. No mode switch is required. Retrieval budgets limit tool
output; they do not shorten the requested plan or remove its details.

## Install

Requires **Node.js 24.15+ (or 22.22.2+) and npm 12.2.1+** on the machine running the
assistant. On first use the skill installs its npm dependencies and builds the index;
plugin installation alone does not install them.

**Ask your assistant** (Codex or Claude Code with file and terminal access):

```text
Install this skill for me, including its npm dependencies:
https://github.com/miika1006/doktimoi/tree/main/skills/doktimoi
```

**Claude Code plugin**, then run `/doktimoi:doktimoi` in your documentation folder:

```sh
claude plugin marketplace add miika1006/doktimoi
claude plugin install doktimoi@doktimoi
```

**Codex plugin**, then invoke `$doktimoi`. Review and trust its hooks in Codex
(`/hooks`, or Settings → Hooks) before expecting them to run:

```sh
codex plugin marketplace add miika1006/doktimoi
codex plugin add doktimoi@doktimoi
```

On macOS a desktop app or login shell can keep an older Node than your terminal. Check
`node --version` in the assistant's terminal, or use the absolute path from
`nvm which --lts`. The [setup guide](skills/doktimoi/references/index.md) covers nvm,
Windows and the macOS CPU backend for semantic search.

### Plugin hooks

- `PreToolUse` auto-approves the skill's own read-only `search`, `batch`, `read`,
  `status` and `help` commands, run as a single command on an already indexed folder.
  Everything else goes through the normal permission flow. In an indexed folder,
  folder-wide Grep, recursive shell searches and whole reads of large or Office/PDF
  files get a reminder to use doktimoi.
- `SessionStart` and `SubagentStart` add a short retrieval reminder in indexed folders, and
  say when an updated plugin still needs its npm dependencies (`npm ci`).
- `SessionStart`, `PostToolUse` (Edit/Write) and Codex `apply_patch` refresh changed
  files of an existing index in the background. Hooks never create an index or enable
  semantic search.

## How it works

The index is a disposable, machine-local `.doktimoi/` folder; source documents are never
rewritten or uploaded. Keyword search needs no AI model. Optional semantic search runs a
local embedding model only after you agree to download it; a hidden per-folder server then
keeps the model loaded and answers searches in parallel.

`search` returns cited passages; `--next` and `batch --requests` answer several
questions in one call, and `--mode exact` lists every matching line. `read` expands up to
20 references or Markdown/text line ranges, capped at 6000 tokens per call. Searches
verify returned sources against their hashes. OCR can misread text, and Excel formulas
use cached values, so check critical facts in the linked source.

[Setup and CLI](skills/doktimoi/references/index.md) ·
[Search workflow](skills/doktimoi/SKILL.md) ·
[Benchmarks](benchmarks/README.md) ·
[Test fixtures](examples/README.md)
