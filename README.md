# Doktimoi

A Claude Code and Codex skill for searching local documentation with minimal
context use. The search engine reads the index; the assistant receives only
selected original passages and source references. Use it to understand product
behavior, plan new features, or assess gaps in a customer sales case.

Supported files: Markdown, plain text, Word (`.docx`), and Excel (`.xlsx`).
Lexical search uses QMD's BM25 search. An optional local embedding model supports
semantic and cross-language retrieval. Documents are not uploaded to a search
service; selected passages enter your assistant's normal model context.

## Why this architecture?

Everything in `.doktimoi/` is for machine use. The assistant does not read the
manifest or a complete routing index. SQLite and minified JSON are internal
program structures, not prompt content. Replacing JSON with a shorter custom
format would not reduce context use here.

Doktimoi does not create AI-written `.ai` summaries, which can lose prohibitions,
exceptions, versions, and units. Instead, it reduces context by selecting relevant
original text, avoiding repetition, and limiting the tokens in search results.
Fewer characters do not necessarily mean fewer tokens. Example output:

```text
security.md:12-18
## Audit retention
Audit events are retained for 90 days.
```

Markdown references point to original source lines. Word references point to
**extracted text** lines, not Word pages. Excel output preserves the worksheet,
row range, cell addresses, number formats, and cached formula results.

## Installation

Requires Node.js 22+ and npm. Copy the entire `skills/doktimoi` directory into your
assistant's skills directory, then install dependencies at the destination.
For example, run these commands from this repository's root if an installation
with the same name does not already exist:

**Claude Code:**

```sh
mkdir -p "$HOME/.claude/skills"
test ! -e "$HOME/.claude/skills/doktimoi" && test ! -L "$HOME/.claude/skills/doktimoi" && cp -R skills/doktimoi "$HOME/.claude/skills/doktimoi" &&
npm ci --prefix "$HOME/.claude/skills/doktimoi"
```

**Codex:**

```sh
mkdir -p "$HOME/.agents/skills"
test ! -e "$HOME/.agents/skills/doktimoi" && test ! -L "$HOME/.agents/skills/doktimoi" && cp -R skills/doktimoi "$HOME/.agents/skills/doktimoi" &&
npm ci --prefix "$HOME/.agents/skills/doktimoi"
```

For a project-specific installation, use `.claude/skills/doktimoi` or
`.agents/skills/doktimoi`. When upgrading, preserve any local modifications before
replacing the previous installation. Do not transfer `node_modules` between
machines; `npm ci` installs dependencies appropriate for the target machine.

Open your documentation folder in the assistant and invoke `/doktimoi` in
Claude Code, or `$doktimoi` or `/skills` in Codex. Start a new session if the skill
is not visible. Invocation details: [Claude Code](https://code.claude.com/docs/en/skills),
[Codex](https://learn.chatgpt.com/docs/build-skills).

The skill builds the index, adds a `.doktimoi/` ignore rule, and adds brief
retrieval instructions to the target folder's `AGENTS.md` and `CLAUDE.md`,
preserving existing content. You can then ask questions such as “How do approvals
work?” or “Compare these meeting notes with the product's capabilities and
produce a gap analysis.”

## Search and updates

You can also run the helper directly from this repository:

```sh
npm ci --prefix skills/doktimoi
node skills/doktimoi/scripts/doktimoi.mjs build examples/documentation
node skills/doktimoi/scripts/doktimoi.mjs search examples/documentation --query max_connections --budget 1200
```

Enable semantic search separately. The first `embed` run downloads a local
embedding model; lexical search needs neither model downloads nor API keys.

```sh
node skills/doktimoi/scripts/doktimoi.mjs embed examples/documentation
node skills/doktimoi/scripts/doktimoi.mjs search examples/documentation --mode hybrid --query "How do I limit the number of concurrent connections?"
```

The default budget is 1600 `o200k_base` tokens. `--metrics` reports measurements
separately on stderr. This does not measure the complete prompt, model response,
or reasoning tokens. Truncated passages are explicitly marked; expand them to
check omitted conditions:

```sh
node skills/doktimoi/scripts/doktimoi.mjs read FOLDER 'file.md:20-45' --from 1 --lines 40 --budget 1600
```

Copy the reference from a search result. `--from` is a line number within that
retrieved chunk.

Every search checks the file inventory and source content hashes. Added,
modified, and deleted files are updated automatically. Only changed sources are
converted again; hybrid search updates their embeddings. Changes are detected
even when timestamps are preserved. Hashing costs O(corpus bytes) on every search.

The cache contains `index.sqlite`, `manifest.json`, and `chunks/`, along with
temporary lock/update files. It can be rebuilt from the sources. The program does
not modify original documents. The old `matrix.json`/`.ai` format is not used.

## Examples and benchmarks

The repository includes HTTPX, QMD, and MarkItDown documentation downloaded from
GitHub, Word and Excel test files, and synthetic sales and product cases.
[Sources and licenses](examples/README.md) are preserved.

```sh
node benchmarks/fetch-examples.mjs --verify
node --test tests/retrieval.test.mjs
node benchmarks/run.mjs
node benchmarks/run.mjs --semantic
```

To download the fixtures again, run `node benchmarks/fetch-examples.mjs`. Exact
Git blobs are pinned in [sources.json](examples/sources.json). Benchmarks and
update checks run on temporary copies. Each run replaces the results report with
its own measurements.

[Results](benchmarks/RESULTS.md) compare bounded `rg` search, lexical search with
prepared terms, and hybrid search with natural-language questions. Measurements
cover context tokens, retrieval time, fresh-process startup, and index updates.
Detailed matches are available in the [measurement data](benchmarks/results.json).
For a small collection of documents, reading the originals directly may be cheaper.

## Limitations

Retrieval does not establish that an answer or feature plan is correct. Semantic
search can return matches even when the corpus does not answer the question.
The skill distinguishes current product capabilities, customer requirements,
roadmap items, and unknowns. Source repository links are preserved, but linked
repositories are not cloned automatically.

PDF/OCR, legacy `.doc`/`.xls` files, images, and charts are outside this version's
scope. Word layout and tracked changes are not fully preserved. Excel formulas
are not recalculated. Hidden files, symlinks, and dependency/build directories
are skipped; Git repositories use tracked and nonignored files.

Warm search timings require reuse of the same `openProject` session. Every CLI
invocation pays startup costs, and hybrid search also initializes the model.
GPU support depends on the environment; `QMD_FORCE_CPU=1` selects CPU execution.
Results from this small test corpus should not be generalized to large datasets
or different hardware.

Instructions: [SKILL.md](skills/doktimoi/SKILL.md),
[indexing](skills/doktimoi/references/index.md),
[feature planning and gap analysis](skills/doktimoi/references/retrieve.md).
