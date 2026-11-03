# Retrieval benchmark

Generated: 2026-11-03T04:30:42.110Z. Node v22.23.4, darwin/arm64, Apple M1. Semantic backend: auto; model: embeddinggemma-300M-Q8_0.

Measured tool-result context with o200k_base, not Claude/Codex billing or complete agent turns. Three repetitions; per-query median. Index freshness scan is included. Warm runs reuse one process; fresh-process figures include startup. No answer-generation model was called.

| Corpus | Files / chunks | Full-read tokens | Build ms | Fresh-process lexical / hybrid ms |
| --- | ---: | ---: | ---: | ---: |
| documentation | 12 / 200 | 37511 | 309.32 | 332.15 / 1942.2 |
| office | 2 / 8 | 1945 | 436.95 | 298.03 / 1974.74 |
| sales | 3 / 10 | 560 | 72.32 | 297.53 / 2019.45 |
| product | 5 / 16 | 676 | 34.19 | 294.6 / 2049.68 |

| Corpus | Mode | Evidence found | Median ms | Median result tokens |
| --- | --- | ---: | ---: | ---: |
| documentation | rg-prepared | 9/11 | 32.88 | 539 |
| documentation | lexical-prepared | 11/11 | 16.31 | 625 |
| documentation | hybrid-natural | 10/11 | 42.5 | 787 |
| office | rg-prepared | 2/2 | 35.77 | 903 |
| office | lexical-prepared | 2/2 | 20.6 | 904 |
| office | hybrid-natural | 2/2 | 41.73 | 1274 |
| sales | rg-prepared | 5/5 | 19.81 | 70 |
| sales | lexical-prepared | 5/5 | 11.94 | 70 |
| sales | hybrid-natural | 5/5 | 31.89 | 299 |
| product | rg-prepared | 6/6 | 22.94 | 113 |
| product | lexical-prepared | 6/6 | 14.43 | 122 |
| product | hybrid-natural | 6/6 | 31.31 | 280 |

## Interpretation

- Prepared lexical terms were authored with the fixtures. Their generation cost is not measured. Hybrid-natural receives the unmodified question, including Finnish questions for English sources. These are distinct workflows, not equal-input algorithm comparisons.
- rg uses the same normalized chunks and refresh scan, literal OR matches, filesystem order, at most four complete chunks and the same context budget. It has no ranking. Oversize chunks are omitted; this is a bounded baseline, not every possible agent grep workflow.
- Evidence found means all required source/text patterns appeared in the returned passages. It is not an LLM answer-quality or feature-planning score. Unanswerable queries are reported separately in results.json.
- Full-read is a context-volume reference, not a claim that competent agents normally read every file. Office content uses extracted text. Compare compact tokens to jsonTokens in results.json for the same returned evidence; the JSON includes internal IDs and is not the best possible JSON encoding.
- A fresh CLI invocation pays startup on every call. Warm times apply only to a reused openProject session. Initial indexing excludes createStore startup; model files were already cached. No automatic answer-confidence threshold is applied to vector matches.
- Sources are a small pinned public corpus plus synthetic sales/product cases. Results are not a universal speed or token-savings claim. Model downloads are outside query timing; embedding build and first semantic query times are recorded in results.json.
- All 24 add/modify/delete and incremental-embedding checks passed. Mutation tests operate on temporary copies.

## Missed evidence

- rg-prepared: reuse-fi
- rg-prepared: markitdown-office
- hybrid-natural: qmd-local-fi
