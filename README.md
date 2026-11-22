# Doktimoi

**On Mac M1, Codex with Doktimoi lexical search used 5–13% fewer total tokens than explicitly batched file tools on two Kubernetes reviews. On two Finnish Office/image tasks, batched file tools gave all six correct answers using 20–30% fewer tokens than Doktimoi.** On the receipt comparison ordinary file tools without the batching instruction chose the wrong shipment twice. On Windows, Claude Code previously used 48–65% fewer tokens with Doktimoi on the Kubernetes reviews. See the [Mac measurements and accuracy review](benchmarks/codex/mac-2026-11-22/README.md) and [Windows results](benchmarks/README.md).

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

**Tokens.** Each model round re-sends the whole conversation, so about 83% of Doktimoi's
385k tokens are that repeated context, 14% new context and 2% the written answer.
Doktimoi returns cited passages for several questions per call and needs 5–7 rounds;
the other tools return file names or snippets, so the agent opens files over 31–47 calls.

**Time.** Of 93.6 s, writing the answer took about 53 s, model work between rounds 30 s
and the searches about 10 s. Indexing the 409 files takes about 22 s once.

**Hybrid (GPU).** The GPU only computes embeddings and costs no tokens. The hybrid runs
most likely used more tokens because their agents made 7–9 rounds instead of 5–7: they
often sent their long natural-language searches one batch per round, and less exact
semantic hits led to extra exact-match checks. On this English task, keyword search
already matches the documents' wording.

Antivirus scanning was on during the Windows runs. Costs, quality checks and raw traces are in [benchmarks/](benchmarks/README.md).

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
