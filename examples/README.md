# Test fixtures

- `kubernetes/`: 409 long, unchanged Kubernetes documentation files (8.5 MB),
  pinned to one upstream commit with per-file checksums and CC-BY-4.0 attribution.
  Used by the [large-corpus agent benchmark](../benchmarks/README.md).
- `office/`: Word and Excel test files from MarkItDown's test suite, byte-for-byte
  upstream Git blobs recorded in [sources.json](sources.json). MIT license in
  [licenses/markitdown.txt](licenses/markitdown.txt).
- `formats/`: fictional PDF, image-bearing Word/DOC, image and legacy XLS fixtures
  with known answers for extraction tests.
- `extended/`: a fictional static HTML approval guide and PowerPoint/Excel workbooks
  containing an approval image.
