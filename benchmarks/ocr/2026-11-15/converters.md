# Document converters and OCR assessment — 2026-11-15

## Implemented decision and evidence

Do not replace all converters because of warning totals. Current `warningBreakdown()` distinguishes unconditional routine OCR notes from format caveats; neither count measures failed extraction. The implementation retains the existing structured/source converters, fixes the demonstrated Word semantic defect, and tunes the existing OCR engine. Tesseract.js and RapidOCR were compared on generated Finnish/English UI screenshots with known truth. Other alternatives below were researched from primary upstream sources; they were not installed or benchmarked. The experiment and raw measurements are documented in [the OCR comparison](README.md).

A minimal valid DOCX containing `Limit: 10` followed by superscript `3` followed by ` EUR. Do not exceed.` previously converted to `Limit: 103 EUR. Do not exceed.` This was reproduced with an in-memory Office archive, without OCR. Word uses Mammoth followed by Turndown and GFM in `sources.mjs`; its conversion did not preserve superscript/subscript markup, although the separate HTML converter already protected those semantics. The fix uses Turndown's existing `keep(['sup', 'sub'])` capability. A valid DOCX regression verifies the exponent, chemical subscript, governing negation and extracted-line citation. No library replacement was needed.

OCR now sets `tessedit_pageseg_mode=3` (AUTO) and uses `rotateAuto=true`. The comparison recovered every tested critical fact and row association in the skewed and 90-degree UI variants while retaining the clean-image result. The low-resolution variant still lost facts; the change is not a general accuracy guarantee. The release checkpoint is 0.14.0, converter version 19 and OCR result cache version 2. No blanket image upscaling, PDF DPI increase, new runtime dependency, confidence-based acceptance or warning suppression was added.

## What warnings actually mean

- Standalone image: always one generic OCR accuracy/diagram warning, even at confidence 100; disabled OCR has a separate warning.
- PDF: one generic routine OCR note per page if OCR adds extra lines or there is no native text. Every PDF also gets one unconditional reading-order/table/diagram caveat. Any image (including a logo) triggers full-page OCR in auto mode.
- Word: one unconditional layout/tracked-change caveat, one routine note per document containing images (not per image), plus Mammoth messages. With OCR off, its image note still says OCR may misread rather than explicitly disabled, unlike other image paths.
- PPTX/XLSX: routine note per embedded image; externally linked images are never fetched and receive an actual missing-content caveat.
- No confidence cutoff or low-confidence warning exists. Confidence only appears in chunk headings and OCR cache records. Empty OCR becomes the visual-only placeholder and receives the same generic warning.
- Exceptions are separate failures, including unreadable images, absent models, oversized renders, and malformed Office content. Word callback failures deliberately abort rather than cache missing image text.
- HTML, YAML, SVG, Mermaid, draw.io and source RST/AsciiDoc caveats describe deliberate static extraction limits, not failed indexing.

## Current OCR configuration and remaining tuning candidates

`extraction.mjs`: tesseract.js 7.0.0, WASM LSTM engine (OEM 1), default eng+fin, one reused sequential worker, image digest caching, normalized PNG visual evidence. DOKTIMOI_OCR=auto|always|off, DOKTIMOI_OCR_LANGUAGES, DOKTIMOI_OCR_CACHE are existing public controls. Native text always retained; additional OCR deduplicates normalized exact lines only, preserving differing signs, decimals and partial qualifications.

PDF scale 2.5 means 180 dpi (72 * 2.5), below Tesseract's recommended >=300 dpi. A future trial could compare scale 300/72 against the existing baseline; this would use about 2.78x as many pixels and more CPU/memory. This DPI change was not tested or applied. Respect the 40 MP render limit. Do not unconditionally upscale all screenshots or claim recovered detail.

AUTO page segmentation and automatic rotation/deskew were applied after the controlled comparison. Both 3-degree skew and 90-degree rotation were tested separately; the combination recovered all tested facts in both cases. Installed Tesseract.js implements `rotateAuto` through line finding and an estimated gradient/angle; that API name alone should not be treated as proof of every orientation case. Sparse PSM11 was also tried, but split table rows and failed the rotated case, so it was not adopted. No explicit white alpha background or document-language adaptation was added. Global numeric whitelists or dictionary corrections were rejected because they can remove words, negations or identifiers.

Persistent OCR result filenames contain the normalized image hash and languages. They do not independently identify every OCR parameter or model. The result cache schema was therefore bumped from version 1 to version 2 together with this fixed settings change: bumping only converterVersion would rerun conversion but could reuse old OCR text for identical embedded images. A gated regression verifies rotated UI labels and the critical amount, rejects an obsolete version-1 cache result, regenerates the result, then reuses the current cache without another OCR call. There is no new public tuning-options interface. Future recognition/model changes need the same invalidation discipline.

## Formats: keep versus investigate

- Markdown/text/RST/AsciiDoc: keep source preservation; executing includes/macros changes the trust boundary and is not needed.
- CSV/TSV/JSON/YAML: keep current exact scalar/address/physical-line treatment. Generic Markdown tools may coerce leading zeroes or lose parent paths/comments.
- HTML: current custom semantic conversion has useful tests (sup/sub, list values, pre, MathML); preserve these, no general replacement justified.
- XLS/XLSX: SheetJS direct cell extraction preserves formula + cached value + cell formatting/address; avoids recalculation. Keep. Legacy drawing conversion uses isolated LibreOffice only when needed. Generic Markdown tables can lose addresses/formula distinction.
- PPTX: direct archive parser preserves presentation order, notes, hidden state, table row/column values and image references. Known actual structural limit: content() collects all non-table paragraphs before appending all tables, so table placement among prose is lost; table cells do not account for merged-cell relationships. Masters/charts/SmartArt intentionally not fully interpreted. The controlled screenshot fixtures do not establish coverage of these presentation layout features. Evaluate representative documents before expanding.
- DOCX/DOC: Mammoth remains the semantic baseline; the demonstrated sup/sub loss in Turndown was fixed. Further evaluation should check numbered lists, Word equations, revisions, footnotes, nested/merged tables against known truth. Legacy .doc conversion already uses isolated LibreOffice with macro/link protections and platform-specific executable discovery.
- PDF: pdfjs text items are concatenated in source order with a simple y-delta newline heuristic. There is no table/layout reconstruction. Better OCR alone will not fix column reading order or row/cell association. Evaluate Docling on a small hard-PDF subset before any optional adapter.
- SVG/draw.io/Mermaid: preserve explicit graph endpoints/source, avoid inferring visual arrow direction or diagram meaning from OCR text.

## Upstream alternatives, verified primary sources

1. Tesseract.js: Apache-2.0, existing Node/WASM integration runs across platforms; no new Python/runtime packaging. Current default model data is quality-oriented per upstream, so switching to 'best' is not automatically a quality upgrade. Retains easiest install. The measured segmentation/rotation change was adopted; rendering/preprocessing changes remain untested candidates.
   - https://github.com/naptha/tesseract.js/blob/master/docs/performance.md
   - https://github.com/naptha/tesseract.js/blob/master/docs/api.md
   - https://github.com/tesseract-ocr/tessdoc/blob/main/ImproveQuality.md

2. Native Tesseract: Apache-2.0, supports macOS Homebrew/MacPorts and Windows (upstream points to UB Mannheim binaries). Adds external executable and traineddata setup; same engine family as WASM, so speed benefit is plausible but quality advantage must be measured using matched data/parameters. Native CLI PSM/deskew/preprocessing ecosystem is useful. Do not declare native universally more accurate.
   - https://tesseract-ocr.github.io/tessdoc/Installation.html

3. RapidOCR + ONNX Runtime: RapidOCR Apache-2.0, advertises Linux/Windows/macOS, pip install rapidocr onnxruntime. Uses Paddle-origin detection/orientation/recognition models. The installed 3.10.0 package bundles PP-OCRv6 small multilingual detection/recognition models; current upstream documentation explicitly lists Finnish support. The comparison used explicit `fi` routing and tested Finnish words and ä/ö, rather than assuming older Chinese/English defaults cover Finnish. The small-image result still misread `Älä` as `Ālä`. Latest upstream docs retire rapidocr_onnxruntime/openvino/paddle package names in favor of rapidocr. Python plus OpenCV/numpy/shapely and ONNX dependencies; Windows ORT requires Visual C++ runtime. The [model attribution statement](https://rapidai.github.io/RapidOCRDocs/main/model_licenses/) identifies registered model weights as Apache-2.0 with separate upstream ownership; dictionaries/fonts remain separately licensed resources. Installed model hashes matched the listed artifacts and are recorded in the OCR README. RapidOCR was actually compared, but not adopted: it recovered more small-image values/rows, while adding Python/native setup and taking longer on this small macOS CPU evaluation. Rotated row reconstruction also needs orientation-aware geometry.
   - https://github.com/RapidAI/RapidOCR
   - https://raw.githubusercontent.com/RapidAI/RapidOCRDocs/main/docs/install_usage/rapidocr/install.en.md
   - https://rapidai.github.io/RapidOCRDocs/main/model_list/
   - https://onnxruntime.ai/docs/install/

4. PaddleOCR: Apache-2.0, upstream explicitly says Windows and macOS adapted; Python + PaddlePaddle CPU runtime, model downloads, document-parser extras. More deployment weight than a plain OCR engine; justified only by measured text/layout/table wins. Do not conflate core CPU OCR with CUDA/VLM pipelines or assume their platform matrices match.
   - https://www.paddleocr.ai/latest/en/FAQ.html
   - https://www.paddleocr.ai/main/en/version3.x/installation.html
   - https://github.com/PaddlePaddle/PaddleOCR

5. Docling: MIT code; upstream README explicitly supports macOS/Linux/Windows x86_64+arm64 and Python>=3.10. Offers PDF layout, reading order and table structure plus OCR engines. Model licenses vary and require separate review. Python/ML/model footprint makes it a candidate for difficult PDFs, not replacement for exact CSV/JSON/Excel converters. Use deterministic standard pipeline first rather than generative VLM output for critical numbers.
   - https://github.com/docling-project/docling
   - https://docling-project.github.io/docling/getting_started/installation/
   - https://github.com/docling-project/docling/blob/main/docs/concepts/OCR.md

6. OS-native OCR: Apple Vision is macOS only, supported languages vary by API revision/recognition level and must be queried. Windows.Media.Ocr is Windows only and Microsoft officially requires package identity for desktop usage. They do not satisfy a single cross-platform backend and would add separate implementation/install paths. Useful optional benchmark references only.
   - https://developer.apple.com/documentation/vision/recognizing-text-in-images
   - https://learn.microsoft.com/en-us/uwp/api/windows.media.ocr

7. MarkItDown: MIT, Python, broad formats; DOCX also uses Mammoth, so wrapper replacement alone cannot establish semantic improvements. Current official OCR plugin uses an OpenAI-compatible LLM Vision client and skips image text on failures; no configured client means OCR skipped. That behavior weakens current fail-loud evidence guarantee. Not a drop-in local OCR improvement.
   - https://github.com/microsoft/markitdown/blob/main/packages/markitdown/pyproject.toml
   - https://github.com/microsoft/markitdown/blob/main/packages/markitdown-ocr/README.md

## Executed evaluation and limits

Generated fixtures, ground truth and outputs are recorded under this directory, separate from the pinned Kubernetes corpus. The controlled UI contains English/Finnish labels, `Do not send` and `Älä poista` restrictions, comma/dot decimals, a negative amount, a date, identifiers, small gray text, row-linked values and checked/unchecked controls. Four inputs cover normal scale, 65% downscaling, 3-degree skew and 90-degree rotation. All ten critical strings and three row associations are scored; correct surrounding words do not excuse the wrong negation or amount.

The same screenshot was embedded into DOCX/PPTX/XLSX/PDF for a pipeline smoke check: all ten image facts and separate OCR/visual citations were retained. This was one quality check, not a cross-format timing comparison. The DOCX sup/sub regression separately covers the non-OCR value-corruption defect.

Three sequential recognition runs per engine/settings were measured on macOS arm64. Tuned Tesseract preserved 10/10 critical strings and 3/3 row associations on normal, skewed and rotated cases; the small screenshot retained 8/10 strings and 1/3 rows. RapidOCR retained 10/10, 9/10, 10/10 and 10/10 strings respectively. It recovered all normal/small/skew rows after simple box grouping, but the generic grouping failed rotated rows. Tesseract uses recognized lines for its row score, so these association scores are not identical model-level table metrics. Warm median recognition was roughly 0.3–0.4 seconds for tuned Tesseract and 1.3–1.4 seconds for RapidOCR. Full measurements, versions, hashes, startup exclusions and raw text/boxes are in [README.md](README.md).

Checkbox boolean state was deliberately not scored as solved: text OCR does not reliably associate the drawn tick with a semantic approval state. Both visual controls and their expected booleans remain in the fixture truth. Confidence is not calibrated as factual correctness and does not suppress caveats.

No claim is made that all converters or alternative engines were benchmarked. The following broader evaluation remains useful if new documents expose gaps.

Unexecuted broader fixture candidates beyond the tested UI screenshots: clean 300dpi scanned text pages and matched 120dpi scans, including skewed/rotated variants; sparse diagram labels; tables with row-specific caps. PDF cases: native text, native+small decorative logo, scan only, mixed native+image critical restriction, two columns with table. Office: DOCX native+image+sup/sub+numbered list; XLSX formula/cached value/zero-padded IDs+anchored image; PPTX notes+table+hidden slide+image. Existing five examples/formats files remain useful smoke fixtures but are too small and clean to rank engines.

Further engine comparisons could include native Tesseract with matched eng/fin data and a 300dpi PDF ablation of the retained Tesseract.js pipeline. Existing Tesseract.js and RapidOCR results should remain the baseline rather than be overwritten. A Docling trial should target the difficult layout/table PDF subset. A full PaddleOCR pipeline is worth its additional setup only if unresolved cases justify it.

Future measurements should record cold setup time/download MB separately from cold first-conversion and warm conversion wall time; peak process-tree memory; exact dependency/model versions+hashes; output text and visual citations; critical facts pass/total, CER/WER, table row/cell correctness, citation resolvability, warnings by category, hard errors. One worker/no concurrent timed retrieval jobs. Three warm runs per case suffice for initial choice; use median and report worst-case. Repeat winning config on native Windows and macOS before claiming both validated; docs support is not a Windows execution test. Never choose based on warning count or uncalibrated confidence alone.

## Native platform support versus execution

Tesseract.js and RapidOCR were executed on macOS arm64 only. Their upstream cross-platform support and the native alternative support described above were checked in documentation. Neither OCR nor LibreOffice integration was **executed on native Windows in this investigation**. Project path/Windows unit tests are not equivalent to running OCR and legacy Office conversion on Windows. Generated font rendering also varies across hosts; use the recorded PNGs for engine comparisons and record new measurements separately.

## LibreOffice integration setup and final validation

The first full OCR-enabled test run had two missing legacy-image results: `image-policy.doc` and `image-policy.xls`. Direct conversion of those exact fixtures returned `DOKTIMOI_MISSING_CONVERTER`; `/Applications/LibreOffice.app` and `soffice` on PATH were absent. `openProject` deliberately marks unavailable legacy converters as skipped with a warning, so the later evidence assertions failed. Modern Office/PDF/image cases passed. This isolated an absent integration dependency rather than an OCR recognition regression. No tests were weakened to hide it.

An official Apple Silicon LibreOffice image was then downloaded and copied into `/tmp`, with no global install:

- [Official LibreOffice 26.8.3 macOS aarch64 DMG](https://download.documentfoundation.org/libreoffice/stable/26.8.3/mac/aarch64/LibreOffice_26.8.3_MacOS_aarch64.dmg).
- [Official mirror list and hashes](https://download.documentfoundation.org/libreoffice/stable/26.8.3/mac/aarch64/LibreOffice_26.8.3_MacOS_aarch64.dmg.mirrorlist).
- Published and locally verified SHA-256: `de943203795e5057785f65515063e2db5eb60b0bb6d8e2534fec59e5cc5fb988`; size 299,927,705 bytes.
- `soffice --version`: `LibreOffice 26.8.3.1 861effc5289d539f15c4c18d1ba8579ffd78728b`.
- Test executable: `/tmp/doktimoi-libreoffice/LibreOffice.app/Contents/MacOS/soffice`. This is an ephemeral local test path, not a supported installation requirement.

The disk image was mounted read-only with `hdiutil`, copied with `ditto` into the isolated temporary app directory, and unmounted afterward. Strict macOS `codesign` verification reported an invalid signature on both the original mounted app and its copy; the DMG's official SHA-256 matched and the executable ran. No signature, quarantine or OS security setting was modified.

The filesystem/process/socket sandbox blocked native LibreOffice conversion and several local-server/watch tests. Running the same conversion outside that sandbox succeeded. The complete suite was therefore rerun with the existing runner's explicit execution escalation, not by changing converter or test behavior:

```sh
DOKTIMOI_SOFFICE=/tmp/doktimoi-libreoffice/LibreOffice.app/Contents/MacOS/soffice \
DOKTIMOI_TEST_OCR=1 node --test
```

Final captured result: **145 tests, 141 passed, 4 skipped, 0 failed; exit 0; 24.73 seconds**. Both real legacy DOC and XLS image-evidence tests passed, as did the modern conversion and server-equivalence tests. Log from this environment: `/tmp/doktimoi-checkpoint-0.14.0-full-with-libreoffice-unsandboxed.log`. The earlier restricted run is separate failure evidence and is not counted as successful validation.

AUTO segmentation may emit Tesseract's routine `Estimating resolution` diagnostic. Its presence did not break the unrestricted server-equivalence test; no blanket stderr/error suppression or speculative DPI change was introduced.

The implementation was captured in checkpoint `4505db9` (0.14.0). Further format expansion or pipeline replacement requires evidence that the existing extraction loses required facts, plus regressions preserving numbers, restrictions, table relationships and source citations. Token-saving experiments must not shorten authored plans or files, remove evidence or caveats, or trade away accuracy.
