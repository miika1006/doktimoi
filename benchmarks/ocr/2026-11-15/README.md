# Controlled UI screenshot OCR comparison

Generated Finnish/English application form, row-linked values, small gray instructions and checked/unchecked controls. This is synthetic material, contains no private data, and uses no third-party document corpus. The four PNGs and truth.json are the exact final inputs; recorded JSON outputs must not be edited. The same normal screenshot is embedded in DOCX, PPTX, XLSX and image-only PDF copies of existing project fixtures (native template text remains, OCR facts are scored separately).

Broader format coverage, retained converters, researched alternatives, applied fixes and final LibreOffice integration validation are documented in [the converter assessment](converters.md).

## Results

macOS arm64 only. Native Windows support was checked in upstream documentation, **not executed on Windows**. Three sequential recognition runs per image/settings; figures are medians, not end-to-end indexing time. No timed retrieval/indexing job ran concurrently. Earlier exploratory passes are excluded. Each cell is exact critical strings passed /10, row associations /3; milliseconds in parentheses.

| Configuration | Normal UI | 65% screenshot | 3° skew | 90° rotation |
| --- | --- | --- | --- | --- |
| Tesseract.js default | 10, 3 (316) | 8, 1 (298) | 9, 3 (313) | 0, 0 (1445) |
| Tesseract.js AUTO + rotateAuto | 10, 3 (336) | 8, 1 (299) | 10, 3 (427) | 10, 3 (336) |
| RapidOCR multilingual small CPU | 10, 3 (1388) | 9, 3 (1383) | 10, 3 (1382) | 10, 0 (1263) |

Tesseract.js 7.0.0, tesseract.js-core7.0.0 WASM, OEM1, cached eng+fin. Default means no setParameters; tuned sets tessedit_pageseg_mode=3 and rotateAuto=true. Model initialization within the warmed Node process is recorded as setupMs in JSON (~0.17s); model download and npm installation were not timed. Reused one worker for all cases. Existing OCR warnings remain appropriate: even the tuned small screenshot still misreads critical values. Sparse PSM11 was tried separately and rejected: it split table rows and failed the rotated variant.

RapidOCR3.10.0, ONNX Runtime1.19.2, Python3.9.6, PP-OCRv6 det_small + rec_small and ch_ppocr_mobile_v2.0_cls_mobile; explicit fi routing; one intra/inter-op thread. Model initialization after Python imports is setupMs (~0.045s), which **excludes Python/module cold startup**. First ever cold Python import was slow and emitted a urllib3/LibreSSL warning; no cold-import timing claim. Temp dependency environment occupied297MB; installation/download duration was not measured. Complete dependency versions: requirements.lock.txt. First inference was slower; raw per-run data retained. Neither engine timings include process launch.

RapidOCR emits individual cell boxes, so its row score uses simple y-center grouping; Tesseract's score uses recognized lines. These are practical output association checks, not equivalent model-level table metrics. Rotated RapidOCR has correct strings but needs orientation-aware geometry to join rows. Checkboxes are included visually and in truth.json, but **boolean state is not scored**: neither engine produces a reliable semantic boolean from the tick. Do not infer approved/sent state from OCR text alone.

Pipeline smoke (baseline before tuning) found all10 normal-image critical facts through DOCX/PPTX/XLSX/PDF and separate ocr-lines visual citations. See pipeline-results.json; this was one quality/citation check, not a cross-format speed benchmark.

## Decision

Tune the existing Tesseract dependency: it fixes the demonstrated skew/rotation failures, keeps normal results, and is faster in this small test. RapidOCR improves small-image row/number recognition, but adds Python/native dependencies and does not replace layout interpretation. Do not claim a universal OCR winner from four related images. No blanket upscaling, DPI change, extra runtime dependency, warning suppression, or confidence-based acceptance was added.

The OCR result cache version must change when recognition settings change; converterVersion alone can reuse old OCR text for unchanged embedded images.

## Reproduce into a new directory

Run from any directory with the project Node dependencies installed:

```sh
node benchmarks/ocr/2026-11-15/generate-fixtures.mjs /tmp/new-ui-ocr-run
node benchmarks/ocr/2026-11-15/embed.mjs /tmp/new-ui-ocr-run
node benchmarks/ocr/2026-11-15/compare-tesseract.mjs /tmp/new-ui-ocr-run
python benchmarks/ocr/2026-11-15/compare-rapid.py /tmp/new-ui-ocr-run
```

Rapid comparison needs rapidocr==3.10.0 and onnxruntime==1.19.2 in a separate Python environment; requirements.lock.txt records this macOS/Python3.9 installation, not a universal Windows lock. Model downloads/setup require consent. Tesseract comparison uses DOKTIMOI_OCR_CACHE or the user's .cache/doktimoi/ocr traineddata cache. Scripts reject existing result files. Generated font rendering can differ by OS; use committed PNGs when comparing engine results across OSes, and record new outputs in a new folder. Do not rerun into this recorded directory.

## Primary upstream evidence

- [Tesseract quality guidance](https://github.com/tesseract-ocr/tessdoc/blob/main/ImproveQuality.md): segmentation, image scaling, deskew and table limits.
- [Tesseract.js API](https://github.com/naptha/tesseract.js/blob/master/docs/api.md) and [performance guidance](https://github.com/naptha/tesseract.js/blob/master/docs/performance.md): existing tuning controls; default quality-oriented language data.
- [RapidOCR install](https://github.com/RapidAI/RapidOCR): Windows/macOS/Linux; Python+ONNX runtime.
- [RapidOCR models](https://rapidai.github.io/RapidOCRDocs/main/model_list/): PP-OCRv6 multilingual includes Finnish.
- [RapidOCR model attribution](https://rapidai.github.io/RapidOCRDocs/main/model_licenses/): registered weights Apache2.0, distinct upstream attribution. Dict/font assets have separate licenses.
- [ONNX Runtime setup](https://onnxruntime.ai/docs/install/): native dependencies, including Windows Visual C++ runtime.

Bundled model SHA256:

```text
090f04abcd9d9a7498bc4ebf677e4cb9bdce1fe4197ddb7e529f1ef44e1ff94f PP-OCRv6_det_small.onnx
6f327246b50388f3c176ae304bd95767ea6dc0c9ae92153ef8cbe210b3c14884 PP-OCRv6_rec_small.onnx
e47acedf663230f8863ff1ab0e64dd2d82b838fceb5957146dab185a89d6215c ch_ppocr_mobile_v2.0_cls_mobile.onnx
```
