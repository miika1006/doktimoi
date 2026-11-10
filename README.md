# Doktimoi

A Claude Code and Codex skill for finding answers in local documentation with
small, source-cited context.

When you ask Claude Code or Codex a question inside a documentation folder, the
assistant often searches files with tools such as `grep` or `rg`, reads matching
sections, and searches again. In a large collection of long files, repeated
searches and reads can consume substantial model context, tokens, and time.

Doktimoi gives that folder a built-in local search engine. It indexes the files
and returns relevant source passages with citations and a bounded output size.
The goal is to find sufficient evidence in fewer steps, optimize token use, and
speed up the assistant's work. Actual savings depend on retrieval quality and
the number of model turns; a small search response alone does not guarantee them.
See the [measured benchmark and answer checks](benchmarks/README.md).

Supports Markdown, plain text, Word (`.docx`/`.doc`), Excel
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

## Measured results — 10 November 2026

**This benchmark did not demonstrate total-token or time savings.** Nine fresh
Codex contexts reviewed the same production-design task against 409 long,
unchanged Kubernetes documentation files (8.5 MB), using `gpt-6-astra`, medium
reasoning. Each row contains three runs; values below are per-run averages.

| Retrieval | Total model tokens | Change vs baseline | Agent time |
| --- | ---: | ---: | ---: |
| Selective `rg` / `sed` baseline | 250,858 | — | 147.8 s |
| Doktimoi lexical | 302,660 | +20.6% | 167.0 s |
| Doktimoi hybrid, local CPU model | 274,583 | +9.5% | 197.6 s |

Total tokens include cached input once and output once. Hybrid used 7.5% less
uncached input, which is a different metric. Index setup is excluded above:
lexical construction averaged 11.6 s; semantic setup took 11.2 s plus 470.9 s
for embeddings, with model download and a native CPU build additionally required
on this Mac. Semantic trials reused all three earlier baseline controls; they
were collected in a later phase, not alternating contemporaneous pairs.

The 20-query evidence check scored **20/20 lexical and 18/20 hybrid** on the same
keyword queries. Returned source text and exact line references passed integrity
checks. All nine memos covered the ten topics; one semantic memo omitted a
StatefulSet prerequisite and an HPA numerical assumption. Some DNS citations
were weaker than the available source. These are not claims of perfect accuracy.

The work fixed ranking, chunking, batch recovery, source-reference and runtime
problems, but remaining lookup rounds and accumulated context still outweigh
the benefit here. See [raw usage and methodology](benchmarks/README.md),
[aggregate data](benchmarks/comparison.json), and
[answer review](benchmarks/quality-review.md). Earlier unsuccessful and
interrupted experiments are retained. One task/model/corpus does not establish
performance on other documentation or formats.

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

### Codex plugin

```sh
codex plugin marketplace add miika1006/doktimoi
codex plugin add doktimoi@doktimoi
```

Then invoke `$doktimoi` in your documentation folder. The portable
[plugin manifest](plugin.json) packages the same skill and hooks for Codex;
the existing Claude marketplace also works as a Codex-compatible catalog.
Dependencies still need the setup step above. Review and trust the hooks in
Codex (`/hooks` in the CLI or Settings → Hooks in the app) before expecting them
to run; installing the plugin alone does not trust them. Standalone skill
installation does not install plugin hooks.
See the official [plugin packaging](https://developers.openai.com/plugins/build/plugins)
and [Codex hooks](https://learn.chatgpt.com/docs/hooks) documentation.

The plugin ships shared Claude Code and Codex hooks:

- `PreToolUse` returns an allow decision for the skill's own `search`, inline `batch`, `read` and
  `status` commands when they run as a single command in lexical or hybrid mode
  on a folder that already has a `.doktimoi` index, or a path inside one (search may refresh that
  index; hybrid only updates existing embeddings and fails if semantic search was
  never enabled), and `help`/`--help`, which prints the usage text and touches no
  folder. The host's sandbox and permission policies still apply. Other commands,
  `build`, `embed`, `disable-semantic` and unindexed folders go
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
- `SessionStart` and `SubagentStart` give agents a short retrieval reminder in
  already indexed folders. Codex `apply_patch` edits, moves and deletions refresh
  each affected index. These hooks share the retrieval implementation; they do
  not create indexes or enable semantic search on their own.

With a standalone skill installation, use `/doktimoi` in Claude Code or `$doktimoi`
in Codex. If the skill does not appear, restart the assistant.

See the official [Claude marketplace](https://code.claude.com/docs/en/plugin-marketplaces)
and [Codex skill](https://learn.chatgpt.com/docs/build-skills) instructions.

### macOS and nvm

Run `node --version` and `command -v node` in the assistant's terminal. A desktop
app or login shell can retain an older Node even after `nvm install --lts` and
`nvm use --lts` in another terminal. Restart the app from the configured shell,
or use the quoted absolute executable reported by `nvm which --lts` in place of
`node`. Doktimoi now rejects unsupported Node versions before loading native
dependencies and reports the executable it actually received. Existing nvm
installations are reused; no competing system Node is needed.

For semantic search inside a macOS sandbox, Metal may be unavailable. Some
Apple Silicon packages still initialize Metal even with `QMD_FORCE_CPU=1` until
a CPU-only backend is built. The [setup guide](skills/doktimoi/references/index.md)
includes the tested native-build remedy; it preserves sandbox restrictions.

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

For factual questions, start with complete search passages and batch independent
questions. Use `search --brief` to locate files or sections: it lists references,
heading paths and one matching line per hit, then `read` expands the exact ranges.
Avoid rereading overlapping evidence: small output alone does not save tokens
if it forces many more model calls.
Adjacent hits from one file are returned as one passage.

Each tool call resends the assistant's whole conversation, so doktimoi lets one
call do several lookups. `--next` separates independent questions in one
`search` (`--query a --query "a alt" --next --query b`), each answered in its
own section. For different scopes, `batch --requests '[{"queries":["first"],"paths":["known/a.md"]},{"queries":["second"],"paths":["known/b.md"]}]'`
keeps each question's filters separate; it also accepts JSON on stdin.
`read` takes up to 20 references or ranges, from any files, and
returns them in order within the per-call cap, naming those that did not fit.
`search --mode exact` replaces `grep -rn`: it lists every line holding a phrase
(case-insensitive) per file, with Markdown and text source line numbers and the
chunk location for Word, Excel, PowerPoint, PDF and OCR text, all readable with
`read`.

Search checks file metadata and verifies returned sources against their hashes;
`--verify` rehashes every source. A tiny folder may be cheaper to read directly.
CSV/TSV references use `csv-lines:N-M` for original physical line spans, because
normalized field text and quoted multiline records do not have one output line
per source line. Copy those references exactly into `read`.

[Setup and CLI](skills/doktimoi/references/index.md) ·
[Search workflow](skills/doktimoi/SKILL.md) ·
[Test fixtures](examples/README.md)
