# Example corpora

- `documentation/`: 12 real Markdown files from [HTTPX](https://github.com/encode/httpx),
  [QMD](https://github.com/tobi/qmd) and [MarkItDown](https://github.com/microsoft/markitdown).
- `office/`: Word and Excel test files from MarkItDown's test suite.
- `sales/`: fictional Finnish/English customer case, contract and pricing workbook.
  Regenerate the workbook with `node benchmarks/create-sales.mjs` from the repo root.
- `product/`: fictional product with three source repositories, limitations,
  integrations, security rules and a roadmap. The `example.invalid` URLs are
  placeholders, not repositories to fetch.
- `formats/`: fictional PDF, image-bearing Word/DOC, image and legacy XLS fixtures
  with known answers for extraction tests. `benchmarks/create-formats.py` regenerates
  PDF/PNG/DOCX; the DOC copy was exported with LibreOffice and XLS with SheetJS.
- `extended/`: fictional PowerPoint and Excel workbooks containing an approval
  image. Regenerate PPTX/XLSX with `benchmarks/create-office-images.py` (dev-only
  python-pptx/openpyxl/Pillow); export the XLS copy with LibreOffice using
  `--headless --convert-to "xls:MS Excel 97" --outdir examples/extended examples/extended/image-policy.xlsx`.
- `product-case/`: fictional customer meeting requirements for a gap-analysis
  exercise. Keep these distinguishable from the product's actual capabilities.

Public files are byte-for-byte upstream Git blobs recorded in
[sources.json](sources.json); the URLs help navigation, while blob hashes pin the
actual content. Verify or download them with `benchmarks/fetch-examples.mjs`.
Source licenses are preserved under [licenses/](licenses/): HTTPX BSD-3-Clause,
QMD MIT, MarkItDown MIT. The fixture copies retain their upstream notices.

Indexes under `.doktimoi/` are ignored disposable machine data. The benchmark
builds fresh indexes in temporary copies and deletes them afterward. Its 25
queries check retrieval of known evidence, including one unanswerable query;
they do not run a complete AI-generated feature plan or gap analysis.
