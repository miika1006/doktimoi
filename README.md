# Doktimoi

**Measured: 64% fewer model tokens with Claude Code.** On a 409-file Kubernetes
documentation task, Claude Code (`claude-opus-5-5`) used a mean 583,475 tokens with
Doktimoi against 1,624,913 with its own Read/Grep tools. That is 42% less agent time and
37% less cost over three pairs. With Codex (`gpt-6-astra`) the same task saved nothing:
it used 20.6% more tokens than an `rg`/`sed` baseline. [Details](#measured-results).

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

10 November 2026. Same production-design task, 409 unchanged Kubernetes v1.32 files
(8.5 MB), three fresh contexts per row, values are per-run means. Index build is excluded.

| Agent | Retrieval | Total tokens | vs baseline | Agent time |
| --- | --- | ---: | ---: | ---: |
| Claude Code, Windows | Read/Grep/Glob baseline | 1,624,913 | — | 159.3 s |
| Claude Code, Windows | Doktimoi lexical | 583,475 | **−64.1%** | 91.9 s |
| Codex, macOS | `rg`/`sed` baseline | 250,858 | — | 147.8 s |
| Codex, macOS | Doktimoi lexical | 302,660 | +20.6% | 167.0 s |
| Codex, macOS | Doktimoi hybrid (CPU) | 274,583 | +9.5% | 197.6 s |

The saving comes from fewer model rounds. Claude's baseline makes about 42 tool calls per
run, each one re-sending the growing context; Doktimoi needed about 11. Codex's baseline
already chains searches into about 9 shell commands, so there was little to save.
Cold lexical indexing took 11.6 s on the Mac and 37 s on Windows with real-time virus
scanning off (about 147 s with it on). The 20-query evidence check scored 20/20 lexical
and 18/20 hybrid. One task, corpus and model per agent does not establish results elsewhere.
Raw events, answers, audits and failed attempts: [benchmarks](benchmarks/README.md).

## Example uses

Open your documentation folder and ask:

- “How does approval routing work, and what are its limits?”
- “Plan offline approvals. Which components and source repositories are affected?”
- “Compare these customer notes and pricing sheets with the product docs, separating
  supported features from missing evidence.”
- “doktimoi status” shows the index, semantic search and background server state.
- “Turn off semantic search for this folder” removes embeddings; keyword search stays.

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
- `SessionStart` and `SubagentStart` add a short retrieval reminder in indexed folders.
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
