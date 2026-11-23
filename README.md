# Doktimoi

**On a Kubernetes documentation review with Claude Code on Windows, Doktimoi 0.14.7 used 67.9% fewer total tokens than ordinary file tools and 52.6% fewer than the same tools given a batching instruction; with Codex on macOS, Doktimoi 0.14.4 saved 25.0–32.6% on two such reviews.** The Doktimoi runs included the batching instruction (group independent tool calls, such as searches or file reads, in the same round). That instruction alone saved 32.4% with Claude Code and 20.8–22.4% with Codex. Cost fell less than tokens: 22% with Claude Code. [Benchmark results](benchmarks/README.md)

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

### Claude Code on Windows

On 23 November 2026, Claude Code (`claude-opus-5-5`, Windows) answered a ten-question
production review of 409 Kubernetes documentation files, three fresh runs per row. The
batched arms got one extra sentence asking to group independent searches and reads.

| Retrieval | Total tokens | vs ordinary | vs batched files | Cost | Agent time | Model rounds |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Ordinary file tools (Read/Grep/Glob) | 1,408,986 | — | — | $0.98 | 131.5 s | 23.3 |
| Batched file tools | 953,057 | −32.4% | — | $0.89 | 128.7 s | 14.7 |
| Batched Doktimoi 0.14.7 | 451,845 | −67.9% | −52.6% | $0.76 | 93.6 s | 7.7 |
| **Batched Doktimoi 0.14.8** (unpaired rerun) | **376,985** | **−73.2%** | **−60.4%** | **$0.61** | **87.5 s** | **6.3** |

**Tokens.** Each model round re-sends the whole conversation, so rounds decide the
total. Doktimoi returns cited passages for several questions per call and needed 6–8
rounds; ordinary file tools needed 20–27.

**Cost.** Cost falls less than tokens: every arm of the three-arm study brought about
the same new context (72,000 tokens per run), and re-sent context is read from the cache
at a low price. Batching alone cut cost by 8.5%, Doktimoi 0.14.7 by 22%.

**Time.** Doktimoi runs were 29–33% shorter. Indexing the 409 files takes about 10 s once.

**Quality.** Every answer has ten sections and existing citation ranges, and every
answer ran over the requested word range. The memos were screened for six known
qualifications, not reviewed claim by claim.

On an earlier held-out review (16 November, antivirus scanning on) Doktimoi 0.14.2 used
48.5% fewer tokens than ordinary file tools, and hybrid search used more tokens than
keyword search on this English corpus. Antivirus scanning was off on 23 November. Costs,
checks, trace findings and raw traces are in the [Claude Code results](benchmarks/README.md#claude-code-windows).

### Codex on macOS

On 22 November 2026, Codex (`gpt-6.1-sol`, Apple M1) used Doktimoi 0.14.4 for both Kubernetes reviews in lexical and hybrid modes and for the lexical Finnish archive decision. The hybrid Finnish archive decision used 0.14.6. The final English receipt comparison over Finnish sources used 0.14.7 in both retrieval modes. [Codex results and version evidence](benchmarks/codex/mac-2026-11-22/README.md#doktimoi-versions)

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
local embedding model only after you agree to download it. With it enabled, `--mode auto`
answers by keywords while a passage holds every search term and adds matches by meaning
only when none does; in [passage tests](benchmarks/claude/auto-mode-2026-11-23-windows/README.md)
it matched keyword search on English queries (20/20) and found 5 of 8 bilingual passages
against 4 for keywords and 2 for always-on hybrid fusion. A hidden per-folder server keeps
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
