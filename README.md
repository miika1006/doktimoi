# Doktimoi

**With Claude Code, Doktimoi used 48–65% fewer tokens than Claude's own file tools and
fewer than every other local retrieval skill tested on the same documentation task.** The saving
comes from answering in fewer model rounds, so it depends on the agent; see
[Measured results](#measured-results).

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

On 16 November 2026, Claude Code (`claude-opus-5-5`, Windows) answered two ten-question
reviews of 409 Kubernetes documentation files, the second written after all tuning, three
fresh runs per row. Doktimoi 0.14.2 used the fewest tokens and tool calls and the least
time of every arm, with answers of comparable quality.

| Task | Retrieval | Total tokens | vs control | Agent time | Tool calls |
| --- | --- | ---: | ---: | ---: | ---: |
| Production design | Read/Grep/Glob control | 1,092,232 | — | 140.7 s | 31 |
| | **Doktimoi 0.14.2** | **385,461** | **−64.7%** | **93.6 s** | 11 |
| | Doktimoi 0.14.2 hybrid (GPU) | 476,179 | −56.4% | 108.8 s | 11 |
| | Meme 1.0.0 (Rust port of QMD) | 777,178 | −28.8% | 194.5 s | 43 |
| | QMD 2.8.3 | 836,378 | −23.4% | 135.8 s | 44 |
| | library-docs | 1,335,672 | +22.3% | 147.7 s | 37 |
| | GBrain (keyword) | 1,347,006 | +23.3% | 169.8 s | 40 |
| | doc-search | 2,127,833 | +94.8% | 423.2 s | 44 |
| Held-out batch platform | Read/Grep/Glob control | 1,247,728 | — | 118.8 s | 34 |
| | **Doktimoi 0.14.2** | **642,117** | **−48.5%** | **93.8 s** | 14 |

**Where Doktimoi's tokens go.** A Doktimoi run on the production task took 5–7 model
rounds: one to read the skill, one or two in which the agent sends several search
batches at once, a few to fill gaps, and one to write the answer. Every round sends the
whole conversation so far back to the model, so about 83% of the 385k tokens are this
repeated context read from the provider's cache, about 14% is new context written to the
cache, and only about 2% is the model's own output (the 1,700-word memo). The searches
returned about 20k tokens of cited passages in total; they cost far more than that
because each later round re-reads them. The control needed 31 tool calls and the
competitors 37–47, because their tools return file names or snippets and the agent then
opens files, round after round; Doktimoi returns the passages themselves, several
questions per call, so it needs fewer rounds. Total tokens follow the number of rounds,
not the size of one response.

**Where the time goes.** Of the 93.6 s, writing the final memo took about 53 s, the
searches and reads about 10 s in total (including starting the folder's background
server on the first call), and the model's work between rounds the remaining 30 s or
so. Fewer rounds therefore also saves time, while faster search alone would save little.
Building the index is a one-off step outside these times: about 22 s for the 409 files
(146 s before 0.14.2). Optional semantic search needed another 7.5 minutes of GPU
embedding and on this task did not beat keyword search; its agents made more rounds.

Real-time antivirus scanning was on during all runs, which slows indexing and process
start-up. Totals count provider input plus output with cached input once; costs, quality
checks, raw traces, the paused competitor study and earlier Codex results are in
[benchmarks/](benchmarks/README.md).

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
local embedding model only after you agree to download it. A hidden per-folder server keeps
the index open (and the model loaded, when enabled) and answers searches in parallel; it never
creates an index or enables a model.

`search` returns cited passages; `--next` and `batch --requests` answer several
questions in one call, and `--mode exact` lists every matching line. `read` expands up to
20 references or Markdown/text line ranges, capped at 6000 tokens per call. Searches
verify returned sources against their hashes. OCR can misread text, and Excel formulas
use cached values, so check critical facts in the linked source.

[Setup and CLI](skills/doktimoi/references/index.md) ·
[Search workflow](skills/doktimoi/SKILL.md) ·
[Benchmarks](benchmarks/README.md) ·
[Test fixtures](examples/README.md)
