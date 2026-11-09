# Setup

## Runtime and installation

Requires Node.js 24.15+ (or 22.22.2+) and npm 12.2.1+. Check `node --version`,
`npm --version` and the resolved executable paths before changing anything.
The marketplace installs skill files, not npm packages.

On Windows, check `Get-Command nvm -ErrorAction SilentlyContinue`, `nvm version` and
`nvm list`. With [nvm-windows](https://github.com/nvm-windows/nvm), reuse a
compatible installed version, or pick a supported LTS from `nvm list available`
and run `nvm install <version>` and `nvm use <version>` (switching may need
elevation). Never install a competing standalone Node or remove other versions.
Recheck `Get-Command node,npm`, `where.exe node` and versions afterwards. On
macOS/Linux reuse the user's version manager; nvm-sh commands differ.

Upgrade an old npm with `npm install --global npm@latest` using the selected Node.
On access denied, EPERM/EACCES or an elevation requirement, explain the failing
operation and give exact commands for the user's own terminal opened with **Run as
administrator**, selecting the same nvm version first. Do not retry repeatedly,
change ACLs, bypass execution policy or switch administrator accounts. `npm.cmd`
works if only the PowerShell npm wrapper is blocked. Recheck versions afterwards;
reopen the terminal/IDE if PATH is stale. Index without elevation.

Install dependencies in the installed skill directory (containing SKILL.md and
package.json), preserving its `.npmrc` and lockfile, then build:

```text
npm ci --prefix "<skill>"
node "<skill>/scripts/doktimoi.mjs" build "<folder>"
```

Indexed: `.md`, `.markdown`, `.txt`, `.text`, `.rst`, `.adoc`, `.asciidoc`, `.docx`,
`.doc`, `.xlsx`, `.xls`, `.pptx`, `.pdf`, `.html`/`.htm`, `.png`, `.jpg`, `.jpeg`,
`.webp`, `.drawio`/`.drawio.xml`, `.mmd`, `.svg`, `.csv`, `.tsv`, `.yaml`/`.yml` and
`.json`. Symlinks, hidden paths, dependency/build directories and ignored files are
skipped; in Git repositories only tracked or non-ignored files are used. Unsupported
formats and conversion warnings are reported; a failed conversion aborts the
query. Source files are never changed. For a tiny folder, reading sources directly
may be cheaper; decide by content volume and question, not file count.

Use the same quoted commands in PowerShell, macOS or Linux, with Windows paths such
as `"C:\Docs\Product"`; Bash and Python are not required. Legacy `.doc` (and images
in legacy `.xls`) need LibreOffice; if it is not in the standard Windows/macOS
location, set `DOKTIMOI_SOFFICE` to the executable path (`soffice.exe` on Windows).
Without it such files are skipped with a warning; run `build` after installing it.
Microsoft Office is not used.

OCR (`DOKTIMOI_OCR_LANGUAGES`, default `eng+fin`) downloads recognition data on
first use, then runs locally; `DOKTIMOI_OCR_CACHE` selects its cache. `DOKTIMOI_OCR`
is `auto` (images, embedded Office images and PDF pages with raster images or no
text), `always` (also native-text PDF pages) or `off`. Each format's limits (OCR
errors, charts, layout, unevaluated includes or aliases, extracted-line
citations) are reported as extraction warnings with its results; do not claim
complete coverage after one. Linked external resources are never fetched.

## Ask about the local AI option

During initial setup, ask whether to enable **local semantic search**, explaining
first in the user's language:

- Keyword search already works without a language model and suits exact names,
  codes and terms at low startup cost.
- Semantic search downloads QMD's embedding model (a few hundred MB), turns
  passages and questions into vectors locally and combines meaning with keywords.
  It helps paraphrases and Finnish/English cross-language questions but costs
  disk, RAM and indexing/startup time.
- It does not generate answers or guarantee correct matches. There is no cloud AI
  charge; the assistant still answers with its normal model and may send selected
  passages to that provider. OCR is separate.

Offer “Enable local semantic search” and “Keep keyword search” and recommend one
by corpus and language needs. Never opt in silently or treat silence as consent;
an explicit user request to enable embeddings is consent. Lexical indexing can
proceed meanwhile, but do not run `embed`, download a model or run hybrid search
before consent. Respect a recorded choice; ask again only if the user wants to
change it. After acceptance:

```text
node "<skill>/scripts/doktimoi.mjs" embed "<folder>"
```

Record semantic search as enabled only after it completes. On failure, report it,
keep keyword search and record enablement as pending; never present lexical
results as semantic. Afterwards use `--mode hybrid` for meaning-based questions
and keyword search for exact identifiers. Documents are never uploaded. Models
use QMD's local cache (`XDG_CACHE_HOME` isolates it); `QMD_FORCE_CPU=1` forces
CPU when Metal/CUDA is unavailable; report the mode when benchmarking.

## Turn semantic search on or off; check status

To turn it on later, ask for consent as above, then run `embed`. To turn it off
when the user asks (no consent question needed), run:

```text
node "<skill>/scripts/doktimoi.mjs" disable-semantic "<folder>"
```

It stops the folder's background server, removes the embeddings and keeps the
keyword index, so no rebuild is needed and no model or server starts again for
the folder. Then set the recorded choice in the doktimoi block to `keyword only`.
The model files stay in QMD's cache for other folders.

To see what the index and its background work are doing, run:

```text
node "<skill>/scripts/doktimoi.mjs" status "<folder>"
```

It changes and starts nothing: it reports source, chunk and warning counts, the
last index update, whether semantic search is on (and chunks still waiting for
embeddings), an interrupted update, whether the index lock is held, and the
background server: its process, plugin version, model state, current request and
idle exit time. Report it to the user in plain words.

## Future sessions

Append `.doktimoi/` to the folder's `.gitignore` once, preserving its content and
tracked files. Pick the first existing instruction file:

1. `AGENTS.md` (or an existing `Agents.md`).
2. `CLAUDE.md`.
3. `.github/copilot-instructions.md`, then a root `copilot-instructions.md`.

Read it and respect it and its recorded search choice unless higher-priority
instructions differ. If its `doktimoi:start` block differs from the one below,
replace the block with the current text, keep the recorded choice and tell the
user. Append or update only Doktimoi's block there; never copy it into a new
host-specific file or create AGENTS.md when another file exists. If several case
variants exist, report conflicts instead of choosing. Respect the `applyTo` scope
of `.github/instructions/*.instructions.md` files; do not make one folder-wide.
If no file exists, propose the current host's (`AGENTS.md` for Codex, `CLAUDE.md`
for Claude, `.github/copilot-instructions.md` for Copilot) and create it only
after the user accepts; indexing works without it. Append this block once, with
`<choice>` set to `keyword only`, `semantic enabled` or `semantic enablement pending`:

```markdown
<!-- doktimoi:start -->
This folder is indexed by doktimoi. For every content lookup here, including fact
checks while editing or maintaining files, search first with the installed
doktimoi skill, not Grep or whole-file reads. Use Grep only for file names or exact
edit locations in a file doktimoi already returned. Run each doktimoi search as a
single command without cd or chaining. Retrieve cited originals; do not load
.doktimoi machine indexes.
Local AI search choice: <choice>. Do not enable embeddings without consent.
<!-- doktimoi:end -->
```

Preserve all other content. Reject symlinked instruction or ignore files. Report
incomplete or duplicated markers instead of replacing unrelated content. If the
user declines the instructions, report the mode without claiming it will be
remembered. Do not write global host settings, commit, push or index linked
repositories during setup.

## Cache

`.doktimoi/` holds QMD's `index.sqlite`, `manifest.json` (source hashes and
locations), `chunks/` and `visuals/` (normalized images and rendered PDF pages);
it costs disk, not context. Searches rescan metadata, reconvert only changed
files, update embeddings when a semantic index exists and fail rather than return
stale evidence; a per-folder lock serializes index updates, while searches run
without it (the background server rescans only after a file change, or once a
minute). `build` rehashes every source, and the first search after a plugin update
that changes chunking reconverts every source once (unchanged passages keep their
embeddings). `build` output lists extraction warnings; `status` counts them and
search shows only those of returned sources.
The cache is disposable: if it is incompatible or incomplete, rebuild it while
preserving unrelated user files. A folder with semantic search may have a
background search server holding `index.sqlite` open; run
`node "<skill>/scripts/doktimoi.mjs" stop "<folder>"` before deleting the cache
(`build` stops it itself). Old v1 `matrix.json`/`.ai` files are ignored.
