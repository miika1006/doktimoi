# Setup

Requires Node.js 22+ and the dependencies in this skill's package-lock.json:

The Claude marketplace installs the skill files, not npm packages. On first use,
check `node --version` and install dependencies in this installed skill directory
(the directory containing SKILL.md and package.json), then build the target folder.
Use the same setup after a standalone URL installation if dependencies are absent.

```text
npm ci --prefix <skill>
node <skill>/scripts/doktimoi.mjs build <folder>
```

The program indexes `.md`, `.markdown`, `.txt`, `.docx`, `.xlsx`. It reads Markdown
without rewriting facts, converts Word with Mammoth and Excel with ExcelJS, and
uses QMD/SQLite for search. Office converters are loaded only when needed.
It skips symlinks, hidden paths, dependency/build directories and ignored files.
Git's tracked/nonignored inventory is used within repositories. Unsupported
formats and conversion warnings are reported; failed conversion aborts the query.
No source files are changed by the program.

For a tiny folder, direct source reading may be cheaper than indexing. Decide by
content volume and question, not file count. Do not pretend a fixed threshold or
a particular backend is optimal for every corpus.

## Semantic search

For a larger or multilingual corpus:

```text
node <skill>/scripts/doktimoi.mjs embed <folder>
```

This downloads QMD's embedding model on first use, then computes embeddings
locally. It requires additional disk/RAM and initialization time. Lexical search
downloads no models. Hybrid search uses the embedding model plus lexical search;
it does not load a query-generation or reranking model. Search and conversion do
not upload documents. The host assistant still uses its normal model service.

Models are shared in QMD's normal local cache; `XDG_CACHE_HOME` can isolate them.
If Metal/CUDA is unavailable in the host sandbox, `QMD_FORCE_CPU=1` selects CPU.
Report the execution mode when benchmarking. Never silently label lexical-only
results as a successful semantic search after a model failure.

## Future sessions

Append `.doktimoi/` to the folder's `.gitignore` once, preserving existing content.
Ignoring does not untrack files already in Git. Do not remove tracked files.
Append this owned block once to `AGENTS.md` and `CLAUDE.md` in the target folder:

```markdown
<!-- doktimoi:start -->
For documentation questions, use the installed doktimoi skill to search this
folder. Retrieve cited originals; do not load .doktimoi machine indexes.
<!-- doktimoi:end -->
```

Preserve other instructions. Reject symlinked files; if markers are incomplete or
duplicated, report the conflict instead of replacing unrelated content. Search
will pick up these file changes automatically. Do not write global host settings,
commit, push, or index repositories linked by the documents.

## Cache and updates

`.doktimoi/index.sqlite` is QMD's index. `manifest.json` tracks source hashes and
original locations. `chunks/` contains exact text blocks and structural context
for the indexer; the assistant sees only selected evidence. JSON minification or
cache file size is not a measure of model context consumption.

Each search rescans the inventory and hashes source bytes, including new/deleted
files. Only changed sources are reconverted. This favors correctness even when
timestamps are preserved. The scan is O(corpus bytes); measure it on large corpora.
A per-folder lock serializes writers and searches. A dirty marker forces repair
after an interrupted update. A failed update returns an error, not stale evidence.
Hybrid searches re-embed changed chunks when a semantic index already exists.
Converter revisions also invalidate extracted chunks, even if sources are unchanged.

The cache is disposable. If its schema is incompatible or files are missing,
rebuild it after preserving any unrelated user files. Old v1 `matrix.json`/`.ai`
files are not read by v2 and need not be loaded or migrated.
