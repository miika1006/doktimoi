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
- “doktimoi status” shows the index, whether semantic search is on and what the
  background server is doing, without changing anything.
- “Turn off semantic search for this folder” removes the embeddings and stops the
  background server; keyword search keeps working. Ask to turn it on again at any
  time.

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

- `PreToolUse` approves the skill's own `search`, `read` and `status` commands without a
  permission prompt when they run as a single command in lexical or hybrid mode
  on a folder that already has a `.doktimoi` index, or a path inside one (search may refresh that
  index; hybrid only updates existing embeddings and fails if semantic search was
  never enabled), and `help`/`--help`, which prints the usage text and touches no
  folder. Other commands, `build`, `embed`, `disable-semantic` and unindexed folders go
  through the normal permission flow. Inside an indexed folder, folder-wide Grep,
  recursive shell searches (grep -r, rg, git grep, findstr /s, Select-String) and
  whole reads of large or Office/PDF files get a reminder to use doktimoi.
- `SessionStart` and `PostToolUse` (Edit/Write) refresh an existing index's changed
  files in the background. They never create an index and leave embeddings to
  hybrid search, so the lock is held briefly. A search that starts during a
  refresh waits about a second for it, then answers from the current index with a
  note and leaves out sources changed since. In a folder with semantic search enabled, `SessionStart`
  also starts the search server (below) and has it load the embedding model in the
  background.

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

In a folder with semantic search enabled, `search` and `read` start a hidden
background server for that folder and send their requests to it over a local
named pipe or Unix socket, authenticated by a random token in
`.doktimoi/server.json`. The server keeps the embedding model loaded, so only the
first hybrid search waits for it. It answers searches and reads in parallel,
watches the folder and re-indexes only after a change (and at least once a
minute), taking the index lock only while it writes; it exits after 30 idle
minutes. If the server is unavailable, the command runs in-process as before.
Keyword-only folders never start a server.

OCR downloads English/Finnish recognition data on first use and runs locally.
Legacy `.doc` and `.xls` image conversion also require LibreOffice. OCR can misread text; inspect
the linked image for critical facts and diagrams. Complex chart/diagram/layout content may need direct inspection, and Excel
formulas use cached results. Token counts are estimates.

`read` expands a search result, or for Markdown and text reads a line range
(`plan.md:1-400`) within the token budget. Its output names the source lines it
shows, and a cut read ends with the line range that continues it. One call's
output is capped at 6000 tokens and about 20 KB so that it stays inline in Claude
Code.

`search` and `read` also take a folder or file inside the indexed folder: they use
that index and search only that part. Only `build` creates an index. `--path` and
`--exclude` narrow a search to, or away from, folders and files. A keyword search
whose terms never occur together returns passages matching some of them, labeled
as such.

`search --brief` lists only references, heading paths and one matching line per
hit, so an assistant can locate passages cheaply and then `read` exact ranges.
Adjacent hits from one file are returned as one passage.

Search checks file metadata and verifies returned sources against their hashes;
`--verify` rehashes every source. A tiny folder may be cheaper to read directly.

[Setup and CLI](skills/doktimoi/references/index.md) ·
[Search workflow](skills/doktimoi/SKILL.md) ·
[Test fixtures](examples/README.md)
