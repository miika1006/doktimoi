# Setup

## Runtime and installation

Requires Node.js 24.15+ (or 22.22.2+) and npm 12.2.1+. Check `node --version`,
`npm --version` and the resolved executable paths before changing anything.
The marketplace installs skill files, not npm packages.

On Windows, check `Get-Command nvm -ErrorAction SilentlyContinue`, `nvm version`
and `nvm list`. If nvm-windows is present, reuse a compatible installed version;
otherwise choose a supported LTS version from `nvm list available` and run
`nvm install <version>` followed by `nvm use <version>`. Do not install a competing
standalone Node or uninstall the user's other versions. Nvm-windows versions and
installation modes differ: elevation may be needed for switching versions.
Check `Get-Command node,npm`, `where.exe node`, and versions again after switching.

Upgrade an old npm with `npm install --global npm@latest` using the selected Node.
If Windows reports access denied, EPERM/EACCES, or an elevation requirement,
explain the failing operation and give the exact commands for the user's own
PowerShell/Command Prompt opened with **Run as administrator**. They should select
the same nvm version there before updating npm. Do not repeatedly retry, change
ACLs, bypass PowerShell execution policy, or switch to a different administrator
account. `npm.cmd` can be used if only the PowerShell npm wrapper is blocked.
Afterward recheck versions in the assistant's terminal; reopen the terminal/IDE
if it still sees the old PATH. Run ordinary indexing without elevation.

On macOS/Linux, reuse the user's version manager if present; nvm-windows commands
are not interchangeable with nvm-sh commands. See [nvm-windows](https://github.com/nvm-windows/nvm).
Install dependencies in the installed skill directory containing SKILL.md and
package.json, preserving its `.npmrc` and lockfile:

```text
npm ci --prefix "<skill>"
node "<skill>/scripts/doktimoi.mjs" build "<folder>"
```

The program indexes `.md`, `.markdown`, `.txt`, `.text`, `.rst`, `.adoc`, `.asciidoc`,
`.docx`, `.doc`, `.xlsx`, `.xls`, `.pdf`, `.png`, `.jpg`, `.jpeg`, `.webp`,
`.drawio`/`.drawio.xml`, `.csv`, `.tsv`,
`.yaml`/`.yml`, `.json`, `.pptx`, and `.html`/`.htm`. It uses Turndown for HTML, Mammoth for Word, SheetJS
for XLS/XLSX, PDF.js for PDF text/rendering, Tesseract.js for OCR,
and QMD/SQLite for search. Converters are loaded only when needed.
It skips symlinks, hidden paths, dependency/build directories and ignored files.
Git's tracked/nonignored inventory is used within repositories. Unsupported
formats and conversion warnings are reported; failed conversion aborts the query.
No source files are changed by the program.

For a tiny folder, direct source reading may be cheaper than indexing. Decide by
content volume and question, not file count. Do not pretend a fixed threshold or
a particular backend is optimal for every corpus.

## OCR and Windows

Use the same quoted Node/npm commands in PowerShell, macOS or Linux terminals.
Use Windows paths such as `"C:\Docs\Product"` for `<folder>`; do not require Bash.
Legacy `.doc` needs LibreOffice Writer; extracting drawings from legacy `.xls`
also needs LibreOffice Calc. Its standard Windows/macOS
location is detected; otherwise set `DOKTIMOI_SOFFICE` to the executable path
(`soffice.exe` on Windows). No Python installation is needed by the skill.

OCR defaults to English and Finnish (`DOKTIMOI_OCR_LANGUAGES=eng+fin`). Recognition
data downloads on first use; subsequent recognition is local. `DOKTIMOI_OCR=off`
disables OCR, while `always` also OCRs native-text PDF pages. The default `auto`
OCRs PDF pages containing raster images or no native text, plus standalone and
embedded Word images. Vector diagrams with native text still need inspection.
Unsupported embedded image encodings can fail conversion; do not claim complete
coverage after an extraction failure. `DOKTIMOI_OCR_CACHE` selects the model cache.

For example, in PowerShell: `$env:DOKTIMOI_OCR_LANGUAGES = "eng+fin"`.
OCR cannot establish a diagram's meaning; open cited visual files when needed.
Embedded drawing images in Excel and slide/notes images in PowerPoint are OCRed.
Excel charts/in-cell rich-data images, PowerPoint charts/SmartArt/master content,
and exact visual layout may still require inspection. Linked external images are
reported but never downloaded. draw.io preserves labels and connector endpoints;
arrow styles are not interpreted as process direction. JSON/YAML retain source
ranges and structural paths; YAML aliases and tags are not evaluated. CSV fields
remain strings, with column numbers and physical source line ranges.
TSV uses tab separators and literal quotes (no CSV-style quoting). Plain-text formats require UTF-8; RST and AsciiDoc retain
source text and line citations without evaluating includes, directives or substitutions.

HTML/HTM support covers static UTF-8 documents: headings, text, code, tables,
links and image alt text. Scripts/styles are excluded and linked resources are
never fetched. Images, frames, CSS visibility and JavaScript-rendered content
need original-page inspection. HTML citations address **extracted** lines, not
physical HTML source lines; open the original file when exact markup matters.

## Ask about the local AI option

During initial setup, ask the user whether to enable **local semantic search**.
Explain before asking, in the user's language:

- Keyword search is already usable without a language model. It suits exact names,
  codes and terms, with low startup cost.
- Semantic search downloads QMD's embedding model (currently a few hundred MB),
  converts passages and questions into numeric vectors locally, and combines
  meaning-based matches with keywords. It helps paraphrases and Finnish/English
  cross-language questions, but uses additional disk, RAM and indexing/startup time.
- It does not generate answers or guarantee that a match is correct. There is no
  separate cloud AI API charge; the assistant still answers with its normal model
  and may send selected passages to that provider. OCR is a separate local feature.

Offer “Enable local semantic search” and “Keep keyword search”. Recommend based
on corpus/language needs; do not silently opt in or treat silence as consent.
Lexical indexing and other independent setup can proceed while waiting. Do not
run `embed`, download an embedding model, or perform hybrid search before consent.
An explicit user request to enable embeddings counts as consent. Respect an
existing recorded choice; ask again only if the user wants to change it.

After acceptance:

```text
node "<skill>/scripts/doktimoi.mjs" embed "<folder>"
```

Confirm completion before recording semantic search as enabled. If it fails,
report the problem, keep keyword search usable, and record that enablement is
pending. Never report lexical fallback as successful semantic search. Use
`--mode hybrid` for meaning-based questions after enablement; keyword searches
can still be used for exact identifiers. No query-generation/reranking model is
loaded. Source conversion and search do not upload documents.

Models use QMD's local cache; `XDG_CACHE_HOME` can isolate it. If Metal/CUDA is
unavailable, `QMD_FORCE_CPU=1` selects CPU. Report the mode when benchmarking.

## Future sessions

Append `.doktimoi/` to the folder's `.gitignore` once, preserving existing content.
Ignoring does not untrack files already in Git. Do not remove tracked files.
Read the existing project instructions before changing them. Select the first
existing instruction file in this order:

1. `AGENTS.md` (also recognize an existing `Agents.md` case variant).
2. `CLAUDE.md` if no Agents file exists.
3. `.github/copilot-instructions.md`, then an existing root `copilot-instructions.md`,
   if neither Agents nor Claude instructions exist.

Use the chosen file's existing content and append/update only Doktimoi's owned
block there. Do not copy the file's content into a new host-specific file and do
not create AGENTS.md just because only CLAUDE.md or Copilot instructions exist.
If multiple case variants exist on a case-sensitive filesystem, read them and
report conflicting instructions instead of choosing arbitrarily. If there are
only scoped `.github/instructions/*.instructions.md` files, respect their
`applyTo` scope; do not turn one into folder-wide guidance.

If no suitable instruction file exists, propose adding the current host's file
(`AGENTS.md` for Codex, `CLAUDE.md` for Claude, or `.github/copilot-instructions.md`
for Copilot). Create it only after the user accepts; indexing works without it.
Append this block once, replacing `<choice>` with the user's actual selection
(`keyword only`, `semantic enabled`, or `semantic enablement pending`):

```markdown
<!-- doktimoi:start -->
For documentation questions, use the installed doktimoi skill to search this
folder. Retrieve cited originals; do not load .doktimoi machine indexes.
Local AI search choice: <choice>. Do not enable embeddings without consent.
<!-- doktimoi:end -->
```

Preserve all other content. Reject symlinked instruction/ignore files. If markers
are incomplete or duplicated, report the conflict rather than replacing unrelated
content. If the user declines adding instructions, report the selected mode in the
handoff without claiming it will be remembered across sessions. Do not write global
host settings, commit, push, or index linked repositories as part of skill setup.

## Cache and updates

`.doktimoi/index.sqlite` is QMD's index. `manifest.json` tracks source hashes and
original locations. `chunks/` contains source text or extracted records with structural context for
QMD; citations still refer to original files. `visuals/` stores normalized images
and rendered PDF pages for OCR and selective inspection, deduplicated by content.
Embedded Office images require extraction; standalone images are currently also
cached as PNG. These copies cost disk space, not model context: the assistant sees
only selected evidence. JSON minification or
cache file size is not a measure of model context consumption.

Each search rescans the inventory and compares size, identity, modification and
change timestamps. Changed files are hashed; only changed content is reconverted.
Selected source bytes are always hash-verified. `build` and `search --verify` hash
every source, useful when filesystem timestamps are unreliable. Unchanged searches
scan O(file count) metadata plus returned source bytes. Changed Word text can reuse
OCR for unchanged images. Visual and OCR caches are removed when no source uses them.
A per-folder lock serializes writers and searches. A dirty marker forces repair
after an interrupted update. A failed update returns an error, not stale evidence.
Hybrid searches re-embed changed chunks when a semantic index already exists.
Converter revisions also invalidate extracted chunks, even if sources are unchanged.

The cache is disposable. If its schema is incompatible or files are missing,
rebuild it after preserving any unrelated user files. Old v1 `matrix.json`/`.ai`
files are not read by v2 and need not be loaded or migrated.
