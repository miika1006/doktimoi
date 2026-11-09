# Doktimoi

A Claude Code and Codex skill for finding answers in local documentation with
small, source-cited context. Supports Markdown, plain text, Word (`.docx`/`.doc`), Excel
(`.xlsx`/`.xls`), PowerPoint (`.pptx`), PDF, HTML (`.html`/`.htm`),
RST, AsciiDoc, draw.io, Mermaid (`.mmd`), SVG, CSV/TSV, YAML, JSON, and
PNG/JPEG/WebP images.

Built on **[QMD](https://github.com/tobi/qmd)**, a local search engine with keyword
(BM25) and semantic search. QMD does the retrieval; your assistant writes the answer.

## What Doktimoi adds

- **Document ingestion and local OCR**, including images embedded in Word, Excel, PowerPoint and PDF.
  Citations retain source files, Markdown lines, PDF pages or Excel sheets/cells.
- **Automatic refresh before searching** when documents are added, edited, or deleted.
- **Token-budgeted output**: selected source passages, defaulting to 1600 tokens,
  instead of loading the index into the assistant's context.
- **Product-analysis guidance**: distinguish shipped features, roadmap items,
  customer requirements, and unknowns when planning features or assessing gaps.

QMD already provides search, citations, and selective reading. For Markdown-only
collections, its own skill may be enough.

## Example uses

Open your documentation folder and ask:

- “How does approval routing work, and what are its limits?”
- “Plan offline approvals. Which components and source repositories are affected?”
- “Compare these customer meeting notes and pricing sheets with the product docs.
  Produce a gap analysis, separating supported features from missing evidence.”

## Install

Requires **Node.js 24.15+ (or 22.22.2+) and npm 12.2.1+** on the machine running
the assistant. Setup reuses nvm on Windows when available; switching Node or
updating npm may require your administrator terminal.

### Ask your assistant

Paste this into Codex or Claude Code with local file and terminal access:

```text
Install this skill for me, including its npm dependencies:
https://github.com/miika1006/doktimoi/tree/main/skills/doktimoi
```

In Codex, you can explicitly prefix the request with `$skill-installer`.
The URL points to the complete skill folder, including its scripts and lockfile.

### Claude Code marketplace

Run in your terminal:

```sh
claude plugin marketplace add miika1006/doktimoi
claude plugin install doktimoi@doktimoi
```

Then open your documentation folder in Claude Code and run `/doktimoi:doktimoi`.
The skill guides the assistant through dependency installation and initial indexing
on first use. Marketplace installation alone does not install npm dependencies.

The Claude Code plugin also ships hooks:

- `PreToolUse` approves the skill's own `search` and `read` commands without a
  permission prompt when they run as a single command in lexical or hybrid mode
  against a folder that already has a `.doktimoi` index (search may refresh that
  index; hybrid only updates existing embeddings and fails if semantic search was
  never enabled). Folder-wide Grep calls inside an indexed folder get a reminder
  to use doktimoi. Other commands, `build`, `embed` and unindexed folders go
  through the normal permission flow.
- `SessionStart` and `PostToolUse` (Edit/Write) refresh an existing index in the
  background (`sync`: changed files, plus incremental embeddings when semantic
  search is enabled). They never create an index. A search that starts during a
  refresh waits for it.

With a standalone skill installation, use `/doktimoi` in Claude Code or `$doktimoi`
in Codex. If the skill does not appear, restart the assistant.

See the official [Claude marketplace](https://code.claude.com/docs/en/plugin-marketplaces)
and [Codex skill](https://learn.chatgpt.com/docs/build-skills) instructions.

## How it works

Doktimoi stores a disposable, machine-only index in `.doktimoi/`. Search runs
locally; only selected passages enter your assistant's normal model context.
Keyword search needs no AI model. Optional semantic search downloads and runs a
local embedding model. Setup explains the tradeoffs and asks whether to enable
it. Source documents are not rewritten.

OCR downloads English/Finnish recognition data on first use and runs locally.
Legacy `.doc` and `.xls` image conversion also require LibreOffice. OCR can misread text; inspect
the linked image for critical facts and diagrams. Complex chart/diagram/layout content may need direct inspection, and Excel
formulas use cached results. Token counts are estimates.

Search checks file metadata and verifies returned sources against their hashes;
`--verify` rehashes every source. A tiny folder may be cheaper to read directly.

[Setup and CLI](skills/doktimoi/references/index.md) ·
[Search workflow](skills/doktimoi/SKILL.md) ·
[Benchmarks](benchmarks/RESULTS.md) · [Example sources](examples/README.md)
